/** LINE Flex（カード）メッセージの共通ビルダー */

export function lineSafeFlexText(value: string, maxLen: number): string {
  return String(value ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, maxLen)
}

/** 売上検索・レシート修正などで共通の青ヘッダー */
export function buildLineFlexBlueHeader(title: string, subtitle: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#1E4FB1',
    paddingTop: 'md',
    paddingBottom: 'md',
    paddingStart: 'md',
    paddingEnd: 'md',
    contents: [
      { type: 'text', text: lineSafeFlexText(title, 80), size: 'lg', weight: 'bold', color: '#FFFFFF' },
      { type: 'text', text: lineSafeFlexText(subtitle, 200), size: 'sm', color: '#D7E6FF', margin: 'sm', wrap: true },
    ],
  }
}

export type FlexButtonAction =
  | { type: 'postback'; label: string; data: string; displayText?: string }
  | { type: 'message'; label: string; text: string }

export type FlexButtonSpec = {
  label: string
  style?: 'primary' | 'secondary' | 'link'
  color?: string
  action: FlexButtonAction
}

function flexButton(spec: FlexButtonSpec): Record<string, unknown> {
  const action = spec.action.type === 'postback'
    ? {
      type: 'postback',
      label: spec.label,
      data: spec.action.data,
      displayText: spec.action.displayText ?? spec.label,
    }
    : {
      type: 'message',
      label: spec.label,
      text: spec.action.text,
    }
  return {
    type: 'button',
    style: spec.style ?? 'secondary',
    height: 'sm',
    ...(spec.color ? { color: spec.color } : {}),
    action,
  }
}

/** 情報カード＋任意のフッターボタン（最大4列） */
export function buildFlexInfoCard(params: {
  altText: string
  title: string
  lines: string[]
  footerNote?: string
  buttons?: FlexButtonSpec[]
  buttonLayout?: 'horizontal' | 'vertical'
}): Record<string, unknown> {
  const bodyContents: Array<Record<string, unknown>> = [
    { type: 'text', text: params.title, weight: 'bold', size: 'md', wrap: true },
  ]
  for (const line of params.lines) {
    if (!line) continue
    bodyContents.push({
      type: 'text',
      text: line,
      size: 'sm',
      color: '#666666',
      wrap: true,
      margin: 'sm',
    })
  }
  if (params.footerNote) {
    bodyContents.push({
      type: 'text',
      text: params.footerNote,
      size: 'xs',
      color: '#888888',
      wrap: true,
      margin: 'md',
    })
  }

  const bubble: Record<string, unknown> = {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: bodyContents,
    },
  }

  const buttons = (params.buttons ?? []).slice(0, 4)
  if (buttons.length > 0) {
    const layout = params.buttonLayout ?? (buttons.length <= 2 ? 'horizontal' : 'vertical')
    bubble.footer = {
      type: 'box',
      layout,
      spacing: 'sm',
      contents: buttons.map((b) => flexButton(b)),
    }
  }

  return {
    type: 'flex',
    altText: params.altText,
    contents: bubble,
  }
}
