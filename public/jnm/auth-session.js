/**
 * 管理トークンの保持
 * - 生の固定トークンは永続化しない
 * - lrst_ セッションは sessionStorage + 同じアプリ配下だけ localStorage に保持
 * - 旧 localStorage の生トークンは初回読込時に削除
 * - 旧 `?t=` ログインは受け付けず、URL から除去のみ行う
 */
(function (global) {
  'use strict';

  var PERSIST_TOKEN_KEY = 'line_summary_admin_token';
  var SESSION_TOKEN_KEY = 'line_summary_admin_token__session';
  var SCOPED_SESSION_PREFIX = 'line_summary_admin_session__scope__';
  var LEGACY_LINE_SESSION_TOKEN_KEY = 'line_summary_admin_session__line';
  var REMEMBER_KEY = 'line_summary_remember_login';
  var SESSION_PREFIX = 'lrst_';
  var LEGACY_TOKEN_NOTICE_KEY = 'line_report_legacy_token_notice';

  function hashString(input) {
    var h = 2166136261;
    var s = String(input || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function currentAppScope() {
    try {
      var origin = String(global.location && global.location.origin || '');
      var path = String(global.location && global.location.pathname || '/');
      if (!/\/$/.test(path)) path = path.replace(/[^/]*$/, '');
      return origin + path;
    } catch (_) {
      return '';
    }
  }

  function scopedSessionTokenKey() {
    return SCOPED_SESSION_PREFIX + hashString(currentAppScope());
  }

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
    return true;
  }

  function shouldPersistScopedSession(token, options) {
    options = options || {};
    if (options.persistCurrentScope === false) return false;
    return isSessionToken(token);
  }

  function setRememberEnabled() {
    return true;
  }

  function readScopedPersistentToken() {
    try {
      var currentKey = scopedSessionTokenKey();
      var scoped = localStorage.getItem(currentKey) || '';
      if (scoped) return scoped;
      var legacy = localStorage.getItem(LEGACY_LINE_SESSION_TOKEN_KEY) || '';
      if (legacy && isSessionToken(legacy)) {
        localStorage.setItem(currentKey, legacy);
        localStorage.removeItem(LEGACY_LINE_SESSION_TOKEN_KEY);
        return legacy;
      }
    } catch (_) {}
    return '';
  }

  function readTokenFromAnyStorage() {
    purgeLegacyPersistentToken();
    return sessionStorage.getItem(SESSION_TOKEN_KEY)
      || readScopedPersistentToken()
      || '';
  }

  function clearTokenStorage() {
    try {
      localStorage.removeItem(PERSIST_TOKEN_KEY);
      localStorage.removeItem(REMEMBER_KEY);
      localStorage.removeItem(LEGACY_LINE_SESSION_TOKEN_KEY);
      localStorage.removeItem(scopedSessionTokenKey());
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
    } catch (_) {}
  }

  function writeToken(value, options) {
    var next = String(value || '').trim();
    clearTokenStorage();
    if (!next) return;
    sessionStorage.setItem(SESSION_TOKEN_KEY, next);
    if (shouldPersistScopedSession(next, options)) {
      localStorage.setItem(scopedSessionTokenKey(), next);
    }
  }

  function getToken() {
    purgeLegacyPersistentToken();
    return sessionStorage.getItem(SESSION_TOKEN_KEY)
      || readScopedPersistentToken()
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

    // 既に unexpired なセッションがあり、かつアクセス対象の店舗/ルームスコープと一致していれば、
    // 使い捨ての lt を重複消費せず、既存セッションを再利用して速やかにログイン状態に入る。
    // これにより、ページ更新(リロード)やバックボタン等で lt が再送されても「既に使用済み」で
    // ログアウトさせられてしまう現象を防ぐ。
    var existing = getToken();
    if (existing && isSessionToken(existing)) {
      try {
        var verifyUrl = exchangeUrl.replace(/\/auth\/link-login$/, '/auth/verify');
        var verifyResponse = await fetch(verifyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'x-admin-token': existing,
            'x-admin-surface': adminSurface,
          },
        });
        if (verifyResponse.ok) {
          var verifyBody = await verifyResponse.json().catch(function () { return {}; });
          var targetStore = String(options.targetStore || params.get('store_key') || params.get('store') || '').trim();
          var targetRoom = String(options.targetRoom || params.get('room_id') || '').trim();

          var isStoreMatched = !targetStore || !verifyBody.storeScope || verifyBody.storeScope === targetStore;
          var isRoomMatched = !targetRoom || !verifyBody.roomScope || verifyBody.roomScope === targetRoom;

          if (isStoreMatched && isRoomMatched) {
            // 既存セッションが有効でスコープも一致！新しい lt の消費（とそれに伴う失敗・クリア）をスキップ
            stripUrlParams(['lt']);
            return true;
          }
        }
      } catch (verifyErr) {
        console.warn('Session verification failed, will attempt loginToken exchange:', verifyErr);
      }
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
      // ログインリンクは使い捨て(単一使用)。既に使用済み/期限切れ/無効(4xx)なら静かに失敗させ、
      // URLから lt を除去して通常のログイン画面へフォールバックする(別端末での再タップ対策)。
      // LINE導線では、端末に残っている古い/期限切れセッションを温存すると、その後のAPI呼び出しが
      // 401 のまま走って「画面は開くが何も操作できない」状態になる。lt が無効なら一旦セッションも消す。
      stripUrlParams(['lt']);
      if (response.status >= 400 && response.status < 500) {
        if (isLineEntryUrl()) {
          clearTokenStorage();
        }
        return false;
      }
      var text = await response.text().catch(function () { return ''; });
      throw new Error('自動ログインに失敗しました (' + response.status + '): ' + text.slice(0, 160));
    }
    var body = await response.json().catch(function () { return {}; });
    var sessionToken = String(body && body.session_token || '').trim();
    if (!sessionToken) {
      throw new Error('自動ログインに失敗しました。session_token がありません。');
    }
    setToken(sessionToken, { persistCurrentScope: true });
    stripUrlParams(['lt']);
    return true;
  }

  function wrapNetworkFetchError(error, contextLabel) {
    var msg = String(error && error.message || error || '');
    if (error && error.name === 'TypeError' && /fetch|network|load failed|Failed to fetch/i.test(msg)) {
      return new Error(
        (contextLabel || 'API') + 'に接続できません。インターネット接続を確認し、'
        + 'ローカルでは http://127.0.0.1:8765/line_report/ を開いてください。',
      );
    }
    return error;
  }

  async function exchangeAdminTokenForSession(adminToken, options) {
    options = options || {};
    var token = String(adminToken || '').trim();
    if (!token) throw new Error('管理トークンを入力してください。');
    var sessionUrl = String(options.sessionUrl || '').trim();
    if (!sessionUrl) throw new Error('sessionUrl is required.');
    var adminSurface = String(options.adminSurface || '').trim() || 'line_report';
    var response;
    try {
      response = await fetch(sessionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-admin-surface': adminSurface,
        },
        body: JSON.stringify({
          admin_token: token,
          remember_login: true,
        }),
      });
    } catch (error) {
      throw wrapNetworkFetchError(error, '管理API');
    }
    if (!response.ok) {
      var text = await response.text().catch(function () { return ''; });
      throw new Error('ログインに失敗しました (' + response.status + '): ' + text.slice(0, 160));
    }
    var body = await response.json().catch(function () { return {}; });
    var sessionToken = String(body && body.session_token || '').trim();
    if (!sessionToken) {
      throw new Error('ログインに失敗しました。session_token がありません。');
    }
    return sessionToken;
  }

  async function loginWithToken(adminToken, options) {
    var token = String(adminToken || '').trim();
    if (!token) {
      clearTokenStorage();
      throw new Error('トークンを入力してください。');
    }
    if (isSessionToken(token)) {
      setToken(token, { persistCurrentScope: true });
      return token;
    }
    var sessionToken = await exchangeAdminTokenForSession(token, options || {});
    setToken(sessionToken, { persistCurrentScope: true });
    return sessionToken;
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
    checkbox.checked = true;
    checkbox.disabled = true;
    checkbox.setAttribute('aria-disabled', 'true');
    try {
      var label = checkbox.parentElement;
      var text = label ? label.querySelector('span') : null;
      if (text) text.textContent = '同じアドレスなら自動ログイン';
    } catch (_) {}
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
    LINE_SESSION_TOKEN_KEY: LEGACY_LINE_SESSION_TOKEN_KEY,
    REMEMBER_KEY: REMEMBER_KEY,
    isLineEntryUrl: isLineEntryUrl,
    SESSION_PREFIX: SESSION_PREFIX,
    supportsPersistentLogin: true,
    isRememberEnabled: isRememberEnabled,
    setRememberEnabled: setRememberEnabled,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    isSessionToken: isSessionToken,
    exchangeAdminTokenForSession: exchangeAdminTokenForSession,
    loginWithToken: loginWithToken,
    logout: logout,
    consumeLegacyTokenNotice: consumeLegacyTokenNotice,
    consumeUrlTokenParam: consumeUrlTokenParam,
    consumeUrlLoginTicketParam: consumeUrlLoginTicketParam,
    consumeUrlAuthParams: consumeUrlAuthParams,
    syncRememberCheckbox: syncRememberCheckbox,
    bindRememberCheckbox: bindRememberCheckbox,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
