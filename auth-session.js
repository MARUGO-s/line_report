/**
 * 管理トークンの保持（ログイン状態を保持）
 * - ON（既定）: localStorage → 次回アクセス時も自動ログイン
 * - OFF: sessionStorage → タブを閉じるとログアウト
 */
(function (global) {
  'use strict';

  var PERSIST_TOKEN_KEY = 'line_summary_admin_token';
  var SESSION_TOKEN_KEY = 'line_summary_admin_token__session';
  var REMEMBER_KEY = 'line_summary_remember_login';

  function isRememberEnabled() {
    var raw = localStorage.getItem(REMEMBER_KEY);
    if (raw == null) return true;
    var normalized = String(raw).trim().toLowerCase();
    return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no');
  }

  function setRememberEnabled(value) {
    localStorage.setItem(REMEMBER_KEY, value ? '1' : '0');
    var token = readTokenFromAnyStorage();
    if (token) {
      writeToken(token);
    }
  }

  function readTokenFromAnyStorage() {
    return localStorage.getItem(PERSIST_TOKEN_KEY) || sessionStorage.getItem(SESSION_TOKEN_KEY) || '';
  }

  function clearTokenStorage() {
    localStorage.removeItem(PERSIST_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  }

  function writeToken(value) {
    var next = String(value || '').trim();
    clearTokenStorage();
    if (!next) return;
    if (isRememberEnabled()) {
      localStorage.setItem(PERSIST_TOKEN_KEY, next);
    } else {
      sessionStorage.setItem(SESSION_TOKEN_KEY, next);
    }
  }

  function getToken() {
    if (isRememberEnabled()) {
      return localStorage.getItem(PERSIST_TOKEN_KEY) || '';
    }
    return sessionStorage.getItem(SESSION_TOKEN_KEY) || localStorage.getItem(PERSIST_TOKEN_KEY) || '';
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
      var urlToken = String(params.get('t') || '').trim();
      if (!urlToken) return false;
      setToken(urlToken);
      stripUrlParams(['t']);
      return true;
    } catch (_) {
      return false;
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
    checkbox.checked = isRememberEnabled();
  }

  function bindRememberCheckbox(checkbox, onChange) {
    if (!(checkbox instanceof HTMLInputElement)) return;
    syncRememberCheckbox(checkbox);
    checkbox.addEventListener('change', function () {
      setRememberEnabled(!!checkbox.checked);
      if (typeof onChange === 'function') onChange();
    });
  }

  global.LINE_REPORT_AUTH = {
    PERSIST_TOKEN_KEY: PERSIST_TOKEN_KEY,
    SESSION_TOKEN_KEY: SESSION_TOKEN_KEY,
    REMEMBER_KEY: REMEMBER_KEY,
    isRememberEnabled: isRememberEnabled,
    setRememberEnabled: setRememberEnabled,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    consumeUrlTokenParam: consumeUrlTokenParam,
    consumeUrlLoginTicketParam: consumeUrlLoginTicketParam,
    consumeUrlAuthParams: consumeUrlAuthParams,
    syncRememberCheckbox: syncRememberCheckbox,
    bindRememberCheckbox: bindRememberCheckbox,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
