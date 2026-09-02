import type { ChatCard } from "./chat_bridge.ts"

export const MTALK_MENU_KNOWLEDGE_COMMAND_RE =
  /^mtalk-menu-knowledge:(register|decline):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export type MtalkMenuKnowledgeStatus =
  | "pending"
  | "registering"
  | "registered"
  | "declined"
  | "failed"

export type MtalkMenuKnowledgeItem = {
  section: string
  name: string
  price: string
  description: string
}

export type MtalkMenuKnowledgeAnalysis = {
  title: string
  category: string
  summary: string
  body_text: string
  tags: string[]
  menu_items: MtalkMenuKnowledgeItem[]
  menu_item_count: number
  priced_item_count: number
  unpriced_item_count: number
  needs_review: boolean
  warnings: string[]
}

function text(value: unknown, max = 2000): string {
  return String(value ?? "").trim().slice(0, max)
}

function boundedStrings(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => text(item, maxChars)).filter(Boolean).slice(0, maxItems)
}

export function normalizeMtalkMenuKnowledgeAnalysis(
  value: unknown,
): MtalkMenuKnowledgeAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const category = text(raw.category, 80)
  if (category !== "メニュー") return null
  const menuItems = (Array.isArray(raw.menu_items) ? raw.menu_items : [])
    .flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return []
      const row = item as Record<string, unknown>
      const name = text(row.name, 300)
      if (!name) return []
      return [{
        section: text(row.section, 120),
        name,
        price: text(row.price, 240),
        description: text(row.description, 1000),
      }]
    })
    .slice(0, 300)
  const bodyText = text(raw.body_text, 60_000)
  if (!menuItems.length && !bodyText) return null
  const priced = menuItems.filter((item) => item.price).length
  return {
    title: text(raw.title, 200) || "M-talk メニュー画像",
    category,
    summary: text(raw.summary, 2000),
    body_text: bodyText,
    tags: boundedStrings(raw.tags, 30, 80),
    menu_items: menuItems,
    menu_item_count: Number.isFinite(Number(raw.menu_item_count))
      ? Math.max(menuItems.length, Math.trunc(Number(raw.menu_item_count)))
      : menuItems.length,
    priced_item_count: Number.isFinite(Number(raw.priced_item_count))
      ? Math.max(0, Math.trunc(Number(raw.priced_item_count)))
      : priced,
    unpriced_item_count: Number.isFinite(Number(raw.unpriced_item_count))
      ? Math.max(0, Math.trunc(Number(raw.unpriced_item_count)))
      : Math.max(0, menuItems.length - priced),
    needs_review: raw.needs_review === true,
    warnings: boundedStrings(raw.warnings, 12, 300),
  }
}

export function parseMtalkMenuKnowledgeCommand(value: unknown): {
  decision: "register" | "decline"
  draftId: string
} | null {
  const match = MTALK_MENU_KNOWLEDGE_COMMAND_RE.exec(text(value, 180))
  if (!match) return null
  return {
    decision: match[1].toLowerCase() as "register" | "decline",
    draftId: match[2].toLowerCase(),
  }
}

export function buildMtalkMenuKnowledgeCard(params: {
  draftId: string
  analysis: MtalkMenuKnowledgeAnalysis
  status?: MtalkMenuKnowledgeStatus
  documentId?: number | null
}): ChatCard {
  const status = params.status || "pending"
  const analysis = params.analysis
  const previewItems = analysis.menu_items.slice(0, 8)
  const sections: ChatCard["sections"] = [
    {
      type: "fields",
      rows: [
        {
          label: "抽出結果",
          value: `${analysis.menu_item_count}品（価格あり ${analysis.priced_item_count}品）`,
        },
      ],
    },
  ]
  if (analysis.summary) sections.push({ type: "note", text: analysis.summary })
  if (previewItems.length) {
    sections.push({ type: "heading", text: "抽出したメニュー（先頭）" })
    sections.push({
      type: "list",
      items: previewItems.map((item) => ({
        time: item.section || null,
        name: item.name,
        size: null,
        note: [item.price ? `価格：${item.price}` : "価格未判読", item.description]
          .filter(Boolean)
          .join(" ／ "),
        warn: item.price ? null : "価格を確認してください",
      })),
    })
    if (analysis.menu_items.length > previewItems.length) {
      sections.push({
        type: "note",
        text: `ほか ${analysis.menu_items.length - previewItems.length}品も解析済みです。登録すると全文を資料へ保存します。`,
        size: "xs",
      })
    }
  }
  if (analysis.needs_review || analysis.unpriced_item_count > 0 || analysis.warnings.length) {
    const detail = analysis.warnings[0] ||
      `価格未判読が ${analysis.unpriced_item_count}品あります。登録後にJournal Reportの資料タブで修正できます。`
    sections.push({ type: "note", text: `⚠ ${detail}`, color: "#b45309", weight: "bold" })
  }

  let subtitle = "内容を確認し、資料へ登録するか選んでください"
  let actions: ChatCard["actions"] = [
    {
      label: "この内容で資料へ登録",
      command: `mtalk-menu-knowledge:register:${params.draftId}`,
      style: "primary",
    },
    {
      label: "今回は登録しない",
      command: `mtalk-menu-knowledge:decline:${params.draftId}`,
      style: "secondary",
    },
  ]
  if (status === "registered") {
    subtitle = params.documentId
      ? `店舗資料へ登録済み（資料ID ${params.documentId}）`
      : "店舗資料へ登録済み"
    actions = []
    sections.push({ type: "note", text: "✅ Journal Reportの「資料」から確認できます。", weight: "bold" })
  } else if (status === "declined") {
    subtitle = "今回は登録しませんでした"
    actions = []
  } else if (status === "failed") {
    subtitle = "登録処理に失敗しました。もう一度お試しください"
  }

  return {
    header: {
      eyebrow: "AIメニュー解析",
      title: analysis.title,
      subtitle,
    },
    sections,
    actions,
  }
}
