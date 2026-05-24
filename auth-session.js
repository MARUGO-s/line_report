/**
 * 管理トークンの保持
 * - 通常: lrst_ セッションは sessionStorage のみ
 * - LINE 経由: lrst_ を localStorage（line_summary_admin_session__line）にも保存（サーバー TTL 3 日）
 * - 旧 localStorage の生トークンは初回読込時に削除
 * - 旧 `?t=` ログインは受け付けず、URL から除去のみ行う
 */
(function (global) {
  'use strict';

  var PERSIST_TOKEN_KEY = 'line_summary_admin_token';
  var SESSION_TOKEN_KEY = 'line_summary_admin_token__session';
  /** LINE 経由で交換した session token（lrst_）のみ端末に保持 */
  var LINE_SESSION_TOKEN_KEY = 'line_summary_admin_session__line';
  var REMEMBER_KEY = 'line_summary_remember_login';
  var SESSION_PREFIX = 'lrst_';
  var LEGACY_TOKEN_NOTICE_KEY = 'line_report_legacy_token_notice';

  function isLineEntryUrl() {
    try {
      var params = new URLSearchParams(global.location.search);
      if (params.get('from') === 'line') return true;
    } catch (_) {}
    return /Line\//i.test(String(global.navigator && global.navigator.userAgent || ''));
  }

  function purgeLegacyPersistentToken() {
    try {
      var legacy = localStorage.getItem(PERSIST_TOKEN_KEY) || '';
      if (legacy) {
        sessionStorage.setItem(LEGACY_TOKEN_NOTICE_KEY, '1');
      }
      localStorage.removeItem(PERSIST_TOKEN_KEY);
      localStorage.removeItem(REMEMBER_KEY);
    } catch (_) {}
  }

  function isRememberEnabled() {
    return false;
  }

  function shouldPersistLineSession(token, options) {
    options = options || {};
    if (options.persistLine === true) return true;
    if (options.persistLine === false) return false;
    return isLineEntryUrl() && isSessionToken(token);
  }

  function setRememberEnabled() {
    try {
      localStorage.removeItem(REMEMBER_KEY);
    } catch (_) {}
  }

  function readTokenFromAnyStorage() {
    purgeLegacyPersistentToken();
    return sessionStorage.getItem(SESSION_TOKEN_KEY)
      || localStorage.getItem(LINE_SESSION_TOKEN_KEY)
      || '';
  }

  function clearTokenStorage() {
    try {
      localStorage.removeItem(PERSIST_TOKEN_KEY);
      localStorage.removeItem(REMEMBER_KEY);
      localStorage.removeItem(LINE_SESSION_TOKEN_KEY);
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
    } catch (_) {}
  }

  function writeToken(value, options) {
    var next = String(value || '').trim();
    clearTokenStorage();
    if (!next) return;
    sessionStorage.setItem(SESSION_TOKEN_KEY, next);
    if (shouldPersistLineSession(next, options)) {
      localStorage.setItem(LINE_SESSION_TOKEN_KEY, next);
    }
  }

  function getToken() {
    purgeLegacyPersistentToken();
    return sessionStorage.getItem(SESSION_TOKEN_KEY)
      || localStorage.getItem(LINE_SESSION_TOKEN_KEY)
      || '';
  }

  function setToken(value, options) {
    writeToken(value, options || {});
  }

  function clearToken() {
    clearTokenStorage();
  }

  function stripUrlParams(paramNames) {
    try {
      var params = new URLSearchParams(global.location.search);
      var changed = false;
      (paramNames || []).forEach(function (name) {
        if (params.has(name)) {
          params.delete(name);
          changed = true;
        }
      });
      if (!changed) return false;
      var qs = params.toString();
      var nextUrl = global.location.pathname + (qs ? ('?' + qs) : '') + (global.location.hash || '');
      global.history.replaceState(null, '', nextUrl);
      return true;
    } catch (_) {
      return false;
    }
  }

  function consumeUrlTokenParam() {
    try {
      var params = new URLSearchParams(global.location.search);
      if (!params.has('t')) return false;
      stripUrlParams(['t']);
      return true;
    } catch (_) {
      return false;
    }
  }

  function isSessionToken(value) {
    return String(value || '').trim().indexOf(SESSION_PREFIX) === 0;
  }

  async function logout(options) {
    options = options || {};
    var token = getToken();
    var logoutUrl = String(options.logoutUrl || '').trim();
    var adminSurface = String(options.adminSurface || '').trim() || 'line_report';
    try {
      if (token && isSessionToken(token) && logoutUrl) {
        await fetch(logoutUrl, {
          method: 'POST',
          keepalive: true,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'x-admin-token': token,
            'x-admin-surface': adminSurface,
          },
          body: JSON.stringify({}),
        });
      }
    } finally {
      clearTokenStorage();
    }
  }

  async function consumeUrlLoginTicketParam(options) {
    options = options || {};
    var exchangeUrl = String(options.exchangeUrl || '').trim();
    if (!exchangeUrl) return false;
    var adminSurface = String(options.adminSurface || '').trim() || 'line_report';
    var params = new URLSearchParams(global.location.search);
    var loginToken = String(params.get('lt') || '').trim();
    if (!loginToken) return false;
    var existing = getToken();
    if (existing && isSessionToken(existing)) {
      stripUrlParams(['lt']);
      return true;
    }
    var response = await fetch(exchangeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-admin-surface': adminSurface,
      },
      body: JSON.stringify({
        login_token: loginToken,
        remember_login: isLineEntryUrl(),
      }),
    });
    if (!response.ok) {
      var text = await response.text().catch(function () { return ''; });
      throw new Error('自動ログインに失敗しました (' + response.status + '): ' + text.slice(0, 160));
    }
    var body = await response.json().catch(function () { return {}; });
    var sessionToken = String(body && body.session_token || '').trim();
    if (!sessionToken) {
      throw new Error('自動ログインに失敗しました。session_token がありません。');
    }
    var persistLine = isLineEntryUrl();
    setToken(sessionToken, { persistLine: persistLine });
    stripUrlParams(['lt']);
    return true;
  }

  async function consumeUrlAuthParams(options) {
    var consumedLoginTicket = await consumeUrlLoginTicketParam(options || {});
    if (consumedLoginTicket) return true;
    return consumeUrlTokenParam();
  }

  function consumeLegacyTokenNotice() {
    try {
      var raw = sessionStorage.getItem(LEGACY_TOKEN_NOTICE_KEY);
      if (!raw) return false;
      sessionStorage.removeItem(LEGACY_TOKEN_NOTICE_KEY);
      return true;
    } catch (_) {
      return false;
    }
  }

  function syncRememberCheckbox(checkbox) {
    if (!(checkbox instanceof HTMLInputElement)) return;
    checkbox.checked = false;
    checkbox.disabled = true;
    checkbox.setAttribute('aria-disabled', 'true');
  }

  function bindRememberCheckbox(checkbox, onChange) {
    if (!(checkbox instanceof HTMLInputElement)) return;
    syncRememberCheckbox(checkbox);
    if (typeof onChange === 'function') onChange();
  }

  purgeLegacyPersistentToken();

  global.LINE_REPORT_AUTH = {
    PERSIST_TOKEN_KEY: PERSIST_TOKEN_KEY,
    SESSION_TOKEN_KEY: SESSION_TOKEN_KEY,
    LINE_SESSION_TOKEN_KEY: LINE_SESSION_TOKEN_KEY,
    REMEMBER_KEY: REMEMBER_KEY,
    isLineEntryUrl: isLineEntryUrl,
    SESSION_PREFIX: SESSION_PREFIX,
    supportsPersistentLogin: false,
    isRememberEnabled: isRememberEnabled,
    setRememberEnabled: setRememberEnabled,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    isSessionToken: isSessionToken,
    logout: logout,
    consumeLegacyTokenNotice: consumeLegacyTokenNotice,
    consumeUrlTokenParam: consumeUrlTokenParam,
    consumeUrlLoginTicketParam: consumeUrlLoginTicketParam,
    consumeUrlAuthParams: consumeUrlAuthParams,
    syncRememberCheckbox: syncRememberCheckbox,
    bindRememberCheckbox: bindRememberCheckbox,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
