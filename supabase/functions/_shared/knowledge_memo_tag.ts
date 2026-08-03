// 店舗ナレッジ投稿タグ（#メモ / #日報 / #note）の判定を一箇所に集約する。
//
// 経緯: 同じ正規表現が line-webhook と admin-api に計4箇所コピーされており、
// いずれも半角 '#' (U+0023) しか見ていなかった。日本語入力では全角 '＃' (U+FF03)
// になりやすく、実際に「＃メモ」と送られた投稿がタグ無し扱いで素通りしていた
// （2026-08-03、引用返信が完全に無反応になる事象）。判定を分散させると再発するため、
// ここを唯一の定義とする。

/** タグの本体（半角 '#' と全角 '＃' の両方を受け付ける）。 */
const MEMO_TAG_SOURCE = '[#＃](?:メモ|日報|note)'

/**
 * テキストに #メモ / #日報 / #note（全角シャープ可）が含まれるか。
 *
 * 注意: `g` フラグ付き正規表現は `lastIndex` を持ち回るため `test()` には使わない。
 * 呼び出しごとに新しい正規表現を作って状態を持たせない。
 */
export function hasKnowledgeMemoTag(text: string): boolean {
  return new RegExp(MEMO_TAG_SOURCE, 'i').test(String(text ?? ''))
}

/** タグ部分を取り除いた本文を返す（前後の空白は落とす）。 */
export function stripKnowledgeMemoTag(text: string): string {
  return String(text ?? '').replace(new RegExp(MEMO_TAG_SOURCE, 'gi'), '').trim()
}
