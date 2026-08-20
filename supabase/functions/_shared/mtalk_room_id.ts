/** M-talk グループを room_summary_settings.room_id に載せるときの ID。 */
export function mtalkSyntheticRoomId(groupId: number): string {
  const id = Number(groupId)
  if (!Number.isSafeInteger(id) || id <= 0) return ""
  return `mtalk-group-${id}`
}

export function parseMtalkSyntheticRoomId(roomId: string): number | null {
  const m = /^mtalk-group-(\d+)$/.exec(String(roomId ?? "").trim())
  if (!m) return null
  const id = Number(m[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function isMtalkSyntheticRoomId(roomId: string): boolean {
  return parseMtalkSyntheticRoomId(roomId) != null
}
