/** ユーザー権限の役職ドロップダウン（運用定義） */
export const JOB_TITLE_OPTIONS = [
  "代表取締役",
  "取締役",
  "総務",
  "マネージャー",
  "アシスタントマネージャー",
  "店長",
  "店長補佐",
  "料理長",
  "一般社員",
] as const

const LABEL_SET = new Set<string>(JOB_TITLE_OPTIONS as unknown as string[])

const RANK_BY_LABEL = new Map<string, number>(
  (JOB_TITLE_OPTIONS as readonly string[]).map((label, index) => [label, index]),
)

/** 管理画面ユーザー一覧の並び: JOB_TITLE_OPTIONS の順を優先。未選択は末尾、定義外の文字列はその次。 */
export function jobTitleSortRank(value: string | null | undefined): number {
  const v = String(value ?? "").trim()
  if (!v) return JOB_TITLE_OPTIONS.length
  const r = RANK_BY_LABEL.get(v)
  if (r !== undefined) return r
  return JOB_TITLE_OPTIONS.length + 1
}

export function isJobTitleLabel(value: string): boolean {
  return LABEL_SET.has(value)
}
