// ルームから届いたメディア（画像/動画/音声/ファイル）を「メディア閲覧」用に保存する。
// 仕様: 1ルームあたり合計 20MB まで保存。超過したら古いものから自動削除（FIFO）。
import { fetchLineMessageBinary } from './line_client.ts'
import { fetchLineDisplayNameByUserId } from './line_display_names.ts'
import * as jpeg from 'https://esm.sh/jpeg-js@0.4.4'

/** 保存先ストレージバケット（private） */
const MEDIA_LIBRARY_BUCKET = 'line-media'
/** 1ルームあたりの保存上限（合計） */
export const ROOM_MEDIA_CAP_BYTES = 20 * 1024 * 1024
/** 単体メディアの取得上限（= ルーム上限。これを超えると保存しない） */
const MAX_SINGLE_MEDIA_BYTES = ROOM_MEDIA_CAP_BYTES

/** メディア閲覧用の画像圧縮（バランス重視: 長辺1280px・JPEG画質75）。
 *  ※ OCR/レシート解析には影響しない（解析は別ルートで元画像を取得しているため）。 */
const COMPRESS_LONG_EDGE = 1280
const COMPRESS_JPEG_QUALITY = 75
/** これ未満は元々小さいので圧縮しない（誤差・劣化を避ける） */
const COMPRESS_MIN_INPUT_BYTES = 80 * 1024
/** これ超は安全のため圧縮しない（巨大画像のメモリ/CPU対策） */
const COMPRESS_MAX_INPUT_BYTES = 8 * 1024 * 1024

type SupabaseClientLike = {
  from: (table: string) => any
  storage: { from: (bucket: string) => any }
}

function extensionForContentType(contentType: string, mediaType: string): string {
  const c = String(contentType || '').toLowerCase()
  if (c.includes('jpeg') || c.includes('jpg')) return 'jpg'
  if (c.includes('png')) return 'png'
  if (c.includes('gif')) return 'gif'
  if (c.includes('webp')) return 'webp'
  if (c.includes('heic')) return 'heic'
  if (c.includes('mp4')) return 'mp4'
  if (c.includes('quicktime')) return 'mov'
  if (c.includes('webm')) return 'webm'
  if (c.includes('m4a') || c.includes('aac') || c.includes('x-m4a')) return 'm4a'
  if (c.includes('mpeg') && mediaType === 'audio') return 'mp3'
  if (c.includes('wav')) return 'wav'
  if (c.includes('pdf')) return 'pdf'
  if (mediaType === 'image') return 'jpg'
  if (mediaType === 'video') return 'mp4'
  if (mediaType === 'audio') return 'm4a'
  return 'bin'
}

function sanitizePathSegment(value: string): string {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)
}

function isJpegContentType(contentType: string): boolean {
  const c = String(contentType || '').toLowerCase()
  return c.includes('jpeg') || c.includes('jpg')
}

/** RGBA をバイリニア補間で縮小する。 */
function downscaleRgba(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const dst = new Uint8Array(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * sh / dh - 0.5
    const y0 = Math.max(0, Math.floor(sy)); const y1 = Math.min(sh - 1, y0 + 1); const fy = sy - y0
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * sw / dw - 0.5
      const x0 = Math.max(0, Math.floor(sx)); const x1 = Math.min(sw - 1, x0 + 1); const fx = sx - x0
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4
      const di = (y * dw + x) * 4
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i01 + c] * fx
        const bot = src[i10 + c] * (1 - fx) + src[i11 + c] * fx
        dst[di + c] = (top * (1 - fy) + bot * fy) | 0
      }
    }
  }
  return dst
}

/** 画像(JPEG)を「メディア閲覧」用に縮小＋再圧縮。失敗時は null（呼び出し側で元データを保存）。
 *  純JS実装(jpeg-js)のためWASM不要でEdgeバンドルに安全。OCRは別取得の元画像を使うため無関係。 */
function recompressJpegForLibrary(input: Uint8Array): Uint8Array | null {
  try {
    const dec = jpeg.decode(input, { useTArray: true, formatAsRGBA: true })
    if (!dec || !dec.width || !dec.height || !dec.data) return null
    const longEdge = Math.max(dec.width, dec.height)
    const scale = longEdge > COMPRESS_LONG_EDGE ? COMPRESS_LONG_EDGE / longEdge : 1
    const dw = Math.max(1, Math.round(dec.width * scale))
    const dh = Math.max(1, Math.round(dec.height * scale))
    const data = scale < 1
      ? downscaleRgba(dec.data as Uint8Array, dec.width, dec.height, dw, dh)
      : (dec.data as Uint8Array)
    const enc = jpeg.encode({ data, width: dw, height: dh }, COMPRESS_JPEG_QUALITY)
    return enc && enc.data ? new Uint8Array(enc.data) : null
  } catch (_e) {
    return null
  }
}

/**
 * 受信メディア1件を保存する。冪等（同一 line_message_id は二重保存しない）。
 * 保存後、1ルーム20MB上限を超えていれば古い順に自動削除する。
 */
export async function saveRoomMediaToLibrary(
  supabase: SupabaseClientLike,
  params: {
    roomId: string
    userId: string | null
    lineMessageId: string
    mediaType: string
    fileName?: string | null
    accessToken: string
    storeKey?: string | null
  },
): Promise<{ saved: boolean; reason?: string }> {
  const roomId = String(params.roomId || '').trim()
  const lineMessageId = String(params.lineMessageId || '').trim()
  const mediaType = String(params.mediaType || '').trim()
  const accessToken = String(params.accessToken || '').trim()
  if (!roomId || !lineMessageId || !mediaType || !accessToken) {
    return { saved: false, reason: 'missing_params' }
  }
  if (!['image', 'video', 'audio', 'file'].includes(mediaType)) {
    return { saved: false, reason: 'unsupported_media_type' }
  }

  // 冪等: 既に保存済みならスキップ
  const existing = await supabase
    .from('line_message_media')
    .select('id')
    .eq('line_message_id', lineMessageId)
    .limit(1)
    .maybeSingle()
  if (existing && existing.data) return { saved: false, reason: 'already_saved' }

  // LINE から本体を取得（20MB上限）
  const content = await fetchLineMessageBinary(lineMessageId, accessToken, MAX_SINGLE_MEDIA_BYTES)
  if (!content.ok) return { saved: false, reason: content.error }
  let bytes = content.bytes
  let size = bytes.byteLength
  if (size <= 0) return { saved: false, reason: 'empty_content' }
  if (size > ROOM_MEDIA_CAP_BYTES) return { saved: false, reason: 'exceeds_room_cap' }

  // 画像は「メディア閲覧」用に縮小＋再圧縮して保存容量を抑える（バランス重視: 長辺1280px・JPEG画質75）。
  // ・OCR/レシート解析には影響しない（解析は別ルートで元画像を取得しているため）。
  // ・JPEG のみ対象。再圧縮で逆に大きくなる/失敗した場合は元データのまま保存する（安全側）。
  let contentType = String(content.contentType || '').trim()
  if (
    mediaType === 'image' && isJpegContentType(contentType) &&
    size >= COMPRESS_MIN_INPUT_BYTES && size <= COMPRESS_MAX_INPUT_BYTES
  ) {
    const recompressed = recompressJpegForLibrary(bytes)
    if (recompressed && recompressed.byteLength > 0 && recompressed.byteLength < size) {
      bytes = recompressed
      size = recompressed.byteLength
      contentType = 'image/jpeg'
    }
  }

  const ext = extensionForContentType(contentType, mediaType)
  const storagePath = `${sanitizePathSegment(roomId)}/${sanitizePathSegment(lineMessageId)}.${ext}`
  const mime = contentType || (mediaType === 'image' ? 'image/jpeg' : 'application/octet-stream')

  const uploaded = await supabase.storage.from(MEDIA_LIBRARY_BUCKET).upload(storagePath, bytes, {
    contentType: mime,
    upsert: true,
  })
  if (uploaded && uploaded.error) {
    return { saved: false, reason: `upload_failed: ${uploaded.error.message}` }
  }

  // 投稿者名を解決（LINE API: グループ/ルームのメンバー名→プロフィール名）。
  // 取得できない場合は null のまま（メディア一覧は user_id から補完表示する）。
  const senderUserId = params.userId ? String(params.userId).trim() : ''
  let senderDisplayName: string | null = null
  if (senderUserId) {
    try {
      senderDisplayName = await fetchLineDisplayNameByUserId(senderUserId, roomId, accessToken)
    } catch (_) {
      senderDisplayName = null
    }
  }

  const inserted = await supabase.from('line_message_media').insert({
    message_id: null,
    line_message_id: lineMessageId,
    room_id: roomId,
    user_id: senderUserId || null,
    sender_display_name: senderDisplayName,
    media_type: mediaType,
    store_partition_key: params.storeKey ? String(params.storeKey).trim() : null,
    storage_bucket: MEDIA_LIBRARY_BUCKET,
    storage_path: storagePath,
    original_file_name: params.fileName ? String(params.fileName).slice(0, 255) : null,
    mime_type: mime,
    file_size_bytes: size,
    content_preview: null,
    created_at: new Date().toISOString(),
  })
  if (inserted && inserted.error) {
    // 行挿入に失敗したらアップロード済みファイルを掃除（孤児防止）
    try { await supabase.storage.from(MEDIA_LIBRARY_BUCKET).remove([storagePath]) } catch (_) { /* ignore */ }
    return { saved: false, reason: `insert_failed: ${inserted.error.message}` }
  }

  await enforceRoomMediaCap(supabase, roomId)
  return { saved: true }
}

/**
 * 指定 LINE メッセージのメディア保存を取り消す（ストレージ実体＋DB行）。
 *
 * `#メモ` の引用返信でジャーナルレポート側（店舗ナレッジ）へ登録した添付は、
 * メディアライブラリには残さない方針のため、登録成功後にこれで取り消す。
 * メディア保存は添付を受信した時点で先に走るので、`#メモ` が後から来る
 * 引用返信方式では「保存しない」ではなく「登録できたら消す」で実現する。
 *
 * @returns 実際に削除した行があれば true（元から無い・上限超過で自動削除済みなら false）
 */
export async function removeRoomMediaByMessageId(
  supabase: SupabaseClientLike,
  lineMessageId: string,
): Promise<boolean> {
  const messageId = String(lineMessageId || '').trim()
  if (!messageId) return false
  try {
    const { data: rows, error } = await supabase
      .from('line_message_media')
      .select('id, storage_bucket, storage_path')
      .eq('line_message_id', messageId)
    if (error || !Array.isArray(rows) || rows.length === 0) return false

    const ids: number[] = []
    const pathsByBucket = new Map<string, string[]>()
    for (const r of rows) {
      const id = Number(r.id)
      if (!Number.isFinite(id)) continue
      ids.push(id)
      const bucket = String(r.storage_bucket || MEDIA_LIBRARY_BUCKET)
      const path = String(r.storage_path || '')
      if (!path) continue
      if (!pathsByBucket.has(bucket)) pathsByBucket.set(bucket, [])
      pathsByBucket.get(bucket)!.push(path)
    }
    if (ids.length === 0) return false

    for (const [bucket, paths] of pathsByBucket) {
      if (paths.length === 0) continue
      // ストレージ実体の削除に失敗しても、DB行は消して一覧から見えないようにする
      try { await supabase.storage.from(bucket).remove(paths) } catch (_) { /* ignore */ }
    }
    const deleted = await supabase.from('line_message_media').delete().in('id', ids)
    if (deleted?.error) {
      console.error('removeRoomMediaByMessageId delete failed:', deleted.error.message)
      return false
    }
    return true
  } catch (err) {
    console.error('removeRoomMediaByMessageId failed:', err)
    return false
  }
}

/** 1ルーム20MB上限を超えた分を、古い順（created_at 昇順）にストレージ＋行ごと削除する。 */
async function enforceRoomMediaCap(supabase: SupabaseClientLike, roomId: string): Promise<void> {
  const { data: rows, error } = await supabase
    .from('line_message_media')
    .select('id, storage_bucket, storage_path, file_size_bytes')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true })
  if (error || !Array.isArray(rows)) return

  let total = 0
  for (const r of rows) total += Number(r.file_size_bytes || 0)
  if (total <= ROOM_MEDIA_CAP_BYTES) return

  const idsToDelete: number[] = []
  const pathsByBucket = new Map<string, string[]>()
  for (const r of rows) {
    if (total <= ROOM_MEDIA_CAP_BYTES) break
    const id = Number(r.id)
    if (!Number.isFinite(id)) continue
    idsToDelete.push(id)
    const bucket = String(r.storage_bucket || MEDIA_LIBRARY_BUCKET)
    const path = String(r.storage_path || '')
    if (path) {
      if (!pathsByBucket.has(bucket)) pathsByBucket.set(bucket, [])
      pathsByBucket.get(bucket)!.push(path)
    }
    total -= Number(r.file_size_bytes || 0)
  }
  if (idsToDelete.length === 0) return

  for (const [bucket, paths] of pathsByBucket) {
    if (paths.length === 0) continue
    try { await supabase.storage.from(bucket).remove(paths) } catch (_) { /* ignore */ }
  }
  try {
    await supabase.from('line_message_media').delete().in('id', idsToDelete)
  } catch (_) { /* ignore */ }
}
