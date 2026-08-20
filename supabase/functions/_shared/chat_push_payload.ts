export type ChatPushPayloadInput = {
  title: string
  body: string
  navigatePath: string
  testId?: string | null
  tag?: string
  groupId?: number | null
  messageId?: number | null
  badgeCount?: number | null
}

const CHAT_PUBLIC_ORIGIN = "https://marugo-s.github.io"
const CHAT_DEFAULT_PATH = "/line_report/chat.html"
const CHAT_ICON_PATH = "/line_report/icons/chat-android-192x192-v3.png"

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
    dir: "ltr",
    silent: false,
    icon: `${CHAT_PUBLIC_ORIGIN}${CHAT_ICON_PATH}`,
    data: {
      url: navigate,
      test_id: String(input.testId ?? "").trim() || null,
      group_id: Number.isSafeInteger(input.groupId) ? input.groupId : null,
      message_id: Number.isSafeInteger(input.messageId) ? input.messageId : null,
    },
  }
  if (String(input.tag ?? "").trim()) notification.tag = String(input.tag).trim()
  // WebKit公式のDeclarative Web Pushでは app_badge は notification 内の文字列。
  if (Number.isSafeInteger(badgeCount) && badgeCount >= 0) {
    notification.app_badge = String(badgeCount)
  }
  return {
    web_push: 8030,
    notification,
  }
}
