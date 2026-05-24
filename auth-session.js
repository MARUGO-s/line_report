/**
 * 管理トークンの保持
 * - セッショントークンは常に sessionStorage のみ
 * - 旧 localStorage 保存は初回読込時に sessionStorage へ移して削除
 * - 旧 `?t=` ログインは受け付けず、URL から除去のみ行う
 */
(function (global) {
  'use strict';

  var PERSIST_TOKEN_KEY = 'line_summary_admin_token';
  var SESSION_TOKEN_KEY = 'line_summary_admin_token__session';
  var REMEMBER_KEY = 'line_summary_remember_login';
  var SESSION_PREFIX = 'lrst_';

  function migrateLegacyPersistentToken() {
    try {
      var existing = sessionStorage.getItem(SESSION_TOKEN_KEY) || '';
      var legacy = localStorage.getItem(PERSIST_TOKEN_KEY) || '';
      if (!existing && legacy) {
        sessionStorage.setItem(SESSION_TOKEN_KEY, legacy);
      }
      localStorage.removeItem(PERSIST_TOKEN_KEY);
      localStorage.removeItem(REMEMBER_KEY);
    } catch (_) {}
  }

  function isRememberEnabled() {
    return false;
  }

  function setRememberEnabled() {
    try {
      localStorage.removeItem(REMEMBER_KEY);
    } catch (_) {}
  }

  function readTokenFromAnyStorage() {
    migrateLegacyPersistentToken();
    return sessionStorage.getItem(SESSION_TOKEN_KEY) || localStorage.getItem(PERSIST_TOKEN_KEY) || '';
  }

  function clearTokenStorage() {
    try {
      localStorage.removeItem(PERSIST_TOKEN_KEY);
      localStorage.removeItem(REMEMBER_KEY);
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
    } catch (_) {}
  }

  function writeToken(value) {
    var next = String(value || '').trim();
    clearTokenStorage();
    if (!next) return;
    sessionStorage.setItem(SESSION_TOKEN_KEY, next);
  }

  function getToken() {
    migrateLegacyPersistentToken();
    return sessionStorage.getItem(SESSION_TOKEN_KEY) || '';
  }

  function setToken(value) {
    writeToken(value);
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
    var response = await fetch(exchangeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-admin-surface': adminSurface,
      },
      body: JSON.stringify({
        login_token: loginToken,
        remember_login: isRememberEnabled(),
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
    setToken(sessionToken);
    stripUrlParams(['lt']);
    return true;
  }

  async function consumeUrlAuthParams(options) {
    var consumedLoginTicket = await consumeUrlLoginTicketParam(options || {});
    if (consumedLoginTicket) return true;
    return consumeUrlTokenParam();
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

  migrateLegacyPersistentToken();

  global.LINE_REPORT_AUTH = {
    PERSIST_TOKEN_KEY: PERSIST_TOKEN_KEY,
    SESSION_TOKEN_KEY: SESSION_TOKEN_KEY,
    REMEMBER_KEY: REMEMBER_KEY,
    SESSION_PREFIX: SESSION_PREFIX,
    supportsPersistentLogin: false,
    isRememberEnabled: isRememberEnabled,
    setRememberEnabled: setRememberEnabled,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    isSessionToken: isSessionToken,
    logout: logout,
    consumeUrlTokenParam: consumeUrlTokenParam,
    consumeUrlLoginTicketParam: consumeUrlLoginTicketParam,
    consumeUrlAuthParams: consumeUrlAuthParams,
    syncRememberCheckbox: syncRememberCheckbox,
    bindRememberCheckbox: bindRememberCheckbox,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
