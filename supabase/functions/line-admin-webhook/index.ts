import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { serveAdminApprovalWebhook } from '../_shared/line_admin_webhook.ts'

/** 管理Bot（@392hdime）専用 — 利用許可の承認のみ */
Deno.serve((req) => serveAdminApprovalWebhook(req))
