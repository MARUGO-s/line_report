import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'

export const MESSAGE_SEARCH_DEFAULT_LIMIT = 30
export const MESSAGE_SEARCH_MAX_LIMIT = 100
export const MESSAGE_SEARCH_MIN_QUERY_LEN = 1

type AppError = { status: number; message: string }

export type MessageSearchRow = {
  id: number
  room_id: string
  room_message_id: number
  line_message_id: string | null
  user_id: string | null
  message_type: string
  text_content: string
  created_at: string
}

export type CalendarSearchRow = {
  id: number
  room_id: string
  event_title: string
  event_description: string
  starts_at: string | null
  ends_at: string | null
  source: string
  external_event_id: string | null
  created_at: string
}

function normalizeQuery(raw: string | null): string {
  return String(raw ?? '').trim()
}

function clampLimit(raw: string | null, defaultLimit: number, maxLimit: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return defaultLimit
  return Math.max(1, Math.min(n, maxLimit))
}

function clampOffset(raw: string | null): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

async function loadRoomNameMap(
  supabase: SupabaseClient,
  roomIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(roomIds.filter(Boolean))]
  const map = new Map<string, string>()
  if (!unique.length) return map

  const [{ data: settings }, { data: names }] = await Promise.all([
    supabase.from('room_summary_settings').select('room_id, room_name').in('room_id', unique),
    supabase.from('line_room_names').select('room_id, room_name').in('room_id', unique),
  ])

  for (const row of names || []) {
    const id = String((row as { room_id?: unknown }).room_id || '').trim()
    const name = String((row as { room_name?: unknown }).room_name || '').trim()
    if (id && name) map.set(id, name)
  }
  for (const row of settings || []) {
    const id = String((row as { room_id?: unknown }).room_id || '').trim()
    const name = String((row as { room_name?: unknown }).room_name || '').trim()
    if (id && name && !map.has(id)) map.set(id, name)
  }

  return map
}

export async function fetchLineRoomMessageSearchState(
  supabase: SupabaseClient,
  url: URL,
): Promise<Record<string, unknown>> {
  const query = normalizeQuery(url.searchParams.get('q'))
  if (query.length < MESSAGE_SEARCH_MIN_QUERY_LEN) {
    throw { status: 400, message: 'q is required.' } satisfies AppError
  }

  const roomId = normalizeQuery(url.searchParams.get('room_id')) || null
  const scope = normalizeQuery(url.searchParams.get('scope')).toLowerCase()
  const globalSearch = scope === 'global' || scope === 'all' || !roomId

  const limit = clampLimit(url.searchParams.get('limit'), MESSAGE_SEARCH_DEFAULT_LIMIT, MESSAGE_SEARCH_MAX_LIMIT)
  const offset = clampOffset(url.searchParams.get('offset'))

  const { data, error } = await supabase.rpc('search_line_room_messages', {
    p_query: query,
    p_room_id: globalSearch ? null : roomId,
    p_limit: limit,
    p_offset: offset,
  })

  if (error) {
    throw { status: 500, message: `Message search failed: ${error.message}` } satisfies AppError
  }

  const rows = Array.isArray(data) ? data : []
  const totalCount = rows.length
    ? Number((rows[0] as { total_count?: unknown }).total_count ?? 0)
    : 0

  const roomIds = rows.map((r) => String((r as { room_id?: unknown }).room_id || '').trim()).filter(Boolean)
  const roomNames = await loadRoomNameMap(supabase, roomIds)

  const items: Array<MessageSearchRow & { room_name: string | null; snippet: string }> = rows.map((row) => {
    const r = row as Record<string, unknown>
    const text = String(r.text_content || '')
    const room_id = String(r.room_id || '')
    return {
      id: Number(r.id),
      room_id,
      room_name: roomNames.get(room_id) || null,
      room_message_id: Number(r.room_message_id),
      line_message_id: r.line_message_id ? String(r.line_message_id) : null,
      user_id: r.user_id ? String(r.user_id) : null,
      message_type: String(r.message_type || 'unknown'),
      text_content: text,
      snippet: buildSnippet(text, query),
      created_at: String(r.created_at || ''),
    }
  })

  return {
    scope: globalSearch ? 'global' : 'room',
    room_id: globalSearch ? null : roomId,
    query,
    limit,
    offset,
    total_count: totalCount,
    items,
    retention_days: 365,
    generated_at: new Date().toISOString(),
  }
}

export async function fetchLineRoomCalendarSearchState(
  supabase: SupabaseClient,
  url: URL,
): Promise<Record<string, unknown>> {
  const query = normalizeQuery(url.searchParams.get('q'))
  if (query.length < MESSAGE_SEARCH_MIN_QUERY_LEN) {
    throw { status: 400, message: 'q is required.' } satisfies AppError
  }

  const roomId = normalizeQuery(url.searchParams.get('room_id'))
  if (!roomId) {
    throw { status: 400, message: 'room_id is required for calendar search.' } satisfies AppError
  }

  const limit = clampLimit(url.searchParams.get('limit'), MESSAGE_SEARCH_DEFAULT_LIMIT, MESSAGE_SEARCH_MAX_LIMIT)
  const offset = clampOffset(url.searchParams.get('offset'))

  const { data, error } = await supabase.rpc('search_line_room_calendar_events', {
    p_query: query,
    p_room_id: roomId,
    p_limit: limit,
    p_offset: offset,
  })

  if (error) {
    throw { status: 500, message: `Calendar search failed: ${error.message}` } satisfies AppError
  }

  const rows = Array.isArray(data) ? data : []
  const totalCount = rows.length
    ? Number((rows[0] as { total_count?: unknown }).total_count ?? 0)
    : 0

  const roomNames = await loadRoomNameMap(supabase, [roomId])

  const items: Array<CalendarSearchRow & { room_name: string | null }> = rows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: Number(r.id),
      room_id: String(r.room_id || ''),
      room_name: roomNames.get(roomId) || null,
      event_title: String(r.event_title || ''),
      event_description: String(r.event_description || ''),
      starts_at: r.starts_at ? String(r.starts_at) : null,
      ends_at: r.ends_at ? String(r.ends_at) : null,
      source: String(r.source || ''),
      external_event_id: r.external_event_id ? String(r.external_event_id) : null,
      created_at: String(r.created_at || ''),
    }
  })

  return {
    scope: 'room',
    room_id: roomId,
    query,
    limit,
    offset,
    total_count: totalCount,
    items,
    retention_days: 365,
    generated_at: new Date().toISOString(),
  }
}

function buildSnippet(text: string, query: string, radius = 48): string {
  const hay = String(text || '')
  const needle = String(query || '').trim()
  if (!hay) return ''
  if (!needle) return hay.slice(0, radius * 2)

  const lowerHay = hay.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  const idx = lowerHay.indexOf(lowerNeedle)
  if (idx < 0) return hay.slice(0, radius * 2)

  const start = Math.max(0, idx - radius)
  const end = Math.min(hay.length, idx + needle.length + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < hay.length ? '…' : ''
  return prefix + hay.slice(start, end) + suffix
}
