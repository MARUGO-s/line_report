export type ChatPushPayloadInput = {
  title: string
  body: string
  navigatePath: string
  tag?: string
  groupId?: number | null
  messageId?: number | null
  badgeCount?: number | null
}

const CHAT_PUBLIC_ORIGIN = "https://marugo-s.github.io"
const CHAT_DEFAULT_PATH = "/line_report/chat.html"

function absoluteChatUrl(path: string): string {
  const value = String(path ?? "").trim() || CHAT_DEFAULT_PATH
  try {
    const resolved = new URL(value, CHAT_PUBLIC_ORIGIN)
    if (resolved.origin !== CHAT_PUBLIC_ORIGIN) return `${CHAT_PUBLIC_ORIGIN}${CHAT_DEFAULT_PATH}`
    return resolved.href
  } catch {
    return `${CHAT_PUBLIC_ORIGIN}${CHAT_DEFAULT_PATH}`
  }
}

export function buildDeclarativeChatPushPayload(input: ChatPushPayloadInput): Record<string, unknown> {
  const title = String(input.title ?? "").trim() || "M-talk"
  const body = String(input.body ?? "").trim() || "新しいメッセージがあります"
  const navigate = absoluteChatUrl(input.navigatePath)
  const badgeCount = Number(input.badgeCount)
  const notification: Record<string, unknown> = {
    title,
    body,
    navigate,
    lang: "ja",
    dir: "auto",
    silent: false,
    data: {
      url: navigate,
      group_id: Number.isSafeInteger(input.groupId) ? input.groupId : null,
      message_id: Number.isSafeInteger(input.messageId) ? input.messageId : null,
    },
  }
  if (String(input.tag ?? "").trim()) notification.tag = String(input.tag).trim()
  const payload: Record<string, unknown> = {
    web_push: 8030,
    notification,
  }
  // WebKitのDeclarative Web Pushではapp_badgeはトップレベルの文字列。
  if (Number.isSafeInteger(badgeCount) && badgeCount >= 0) {
    payload.app_badge = String(badgeCount)
  }
  return payload
}
