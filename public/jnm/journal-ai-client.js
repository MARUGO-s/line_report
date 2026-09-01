/**
 * Journal Report → ai-analyze 共通クライアント。
 * 公開anonキーだけで有料AIを呼ばせず、必ず現在のlrst_管理セッションを送る。
 */
(function (global) {
  'use strict';

  // チャット画面の待機状態を永続させないための上限。Edge Function 側の
  // 全体締切（85秒）より少し余裕を持たせ、失敗時は呼び出し元のローカル回答へ退避する。
  // Supabase の request idle timeout は 150s。そこに達すると 504 になり
  // フォールバック文言すら出せないため、その内側で待つ。
  // ai-analyze 側は 115s で自ら打ち切って説明付きの応答を返すので、
  // クライアントはそれより長く待ち、サーバーの説明を優先させる。
  var DEFAULT_AI_REQUEST_TIMEOUT_MS = 140000;

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
    var requestedTimeout = Number(opts.timeoutMs);
    var timeoutMs = requestedTimeout > 0 ? requestedTimeout : DEFAULT_AI_REQUEST_TIMEOUT_MS;
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timedOut = false;
    var abortFromCaller = function () {
      if (controller) controller.abort();
    };
    if (opts.signal) {
      if (opts.signal.aborted) abortFromCaller();
      else if (typeof opts.signal.addEventListener === 'function') {
        opts.signal.addEventListener('abort', abortFromCaller, { once: true });
      }
    }
    var timer = controller ? setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs) : null;
    try {
      var response = await fetch(String(endpoint || ''), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + String(opts.anonKey || ''),
          'x-admin-token': token,
          'x-admin-surface': pages.ADMIN_SURFACE || 'line_report'
        },
        signal: controller ? controller.signal : opts.signal,
        body: JSON.stringify(safePayload)
      });
      var body = await response.json().catch(function () { return {}; });
      return { response: response, body: body };
    } catch (error) {
      if (timedOut) {
        throw new Error('AIの応答が' + Math.round(timeoutMs / 1000) + '秒以内に完了しませんでした。ローカル集計による回答に切り替えます。');
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (opts.signal && typeof opts.signal.removeEventListener === 'function') {
        opts.signal.removeEventListener('abort', abortFromCaller);
      }
    }
  }

  global.JOURNAL_AI_CLIENT = { request: request };
})(typeof globalThis !== 'undefined' ? globalThis : window);
