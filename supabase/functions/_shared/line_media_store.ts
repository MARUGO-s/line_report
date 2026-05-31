// ルームから届いたメディア（画像/動画/音声/ファイル）を「メディア閲覧」用に保存する。
// 仕様: 1ルームあたり合計 20MB まで保存。超過したら古いものから自動削除（FIFO）。
import { fetchLineMessageBinary } from './line_client.ts'

/** 保存先ストレージバケット（private） */
const MEDIA_LIBRARY_BUCKET = 'line-media'
/** 1ルームあたりの保存上限（合計） */
export const ROOM_MEDIA_CAP_BYTES = 20 * 1024 * 1024
/** 単体メディアの取得上限（= ルーム上限。これを超えると保存しない） */
const MAX_SINGLE_MEDIA_BYTES = ROOM_MEDIA_CAP_BYTES

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
  const bytes = content.bytes
  const size = bytes.byteLength
  if (size <= 0) return { saved: false, reason: 'empty_content' }
  if (size > ROOM_MEDIA_CAP_BYTES) return { saved: false, reason: 'exceeds_room_cap' }

  const ext = extensionForContentType(content.contentType, mediaType)
  const storagePath = `${sanitizePathSegment(roomId)}/${sanitizePathSegment(lineMessageId)}.${ext}`
  const mime = String(content.contentType || '').trim()
    || (mediaType === 'image' ? 'image/jpeg' : 'application/octet-stream')

  const uploaded = await supabase.storage.from(MEDIA_LIBRARY_BUCKET).upload(storagePath, bytes, {
    contentType: mime,
    upsert: true,
  })
  if (uploaded && uploaded.error) {
    return { saved: false, reason: `upload_failed: ${uploaded.error.message}` }
  }

  const inserted = await supabase.from('line_message_media').insert({
    message_id: null,
    line_message_id: lineMessageId,
    room_id: roomId,
    user_id: params.userId ? String(params.userId) : null,
    sender_display_name: null,
    media_type: mediaType,
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
