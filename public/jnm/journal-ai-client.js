/**
 * Journal Report → ai-analyze 共通クライアント。
 * 公開anonキーだけで有料AIを呼ばせず、必ず現在のlrst_管理セッションを送る。
 */
(function (global) {
  'use strict';

  async function request(endpoint, payload, options) {
    var opts = options || {};
    var auth = global.LINE_REPORT_AUTH || null;
    var pages = global.LINE_REPORT_PAGES || {};
    var token = auth && typeof auth.getToken === 'function' ? auth.getToken() : '';
    if (!token) {
      throw new Error('AI機能にはログインが必要です。管理トークンで接続するか、LINEの最新リンクから開いてください。');
    }
    var privacy = global.JOURNAL_AI_PRIVACY || null;
    var safePayload = privacy && typeof privacy.sanitizePayload === 'function'
      ? privacy.sanitizePayload(payload || {})
      : (payload || {});
    var response = await fetch(String(endpoint || ''), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + String(opts.anonKey || ''),
        'x-admin-token': token,
        'x-admin-surface': pages.ADMIN_SURFACE || 'line_report'
      },
      signal: opts.signal,
      body: JSON.stringify(safePayload)
    });
    var body = await response.json().catch(function () { return {}; });
    return { response: response, body: body };
  }

  global.JOURNAL_AI_CLIENT = { request: request };
})(typeof globalThis !== 'undefined' ? globalThis : window);
