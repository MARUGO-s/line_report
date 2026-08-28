/**
 * LINE Report 静的 UI 向け sessionStorage キャッシュ
 * 認証済みレスポンスをタブ単位に閉じ込め、ブラウザ再起動後へは持ち越さない。
 */
(function (global) {
  'use strict';

  var CACHE_VERSION = 1;
  var STORAGE_PREFIX = 'line_report_site_cache__';
  /** キャッシュを破棄するまでの最大保持時間 */
  var DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  /** 1認証あたりの sessionStorage 上限目安 */
  var MAX_STORE_BYTES = 4 * 1024 * 1024;

  function activeStorage() {
    return sessionStorage;
  }

  function clearLegacyPersistentCaches() {
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(STORAGE_PREFIX) === 0) keys.push(k);
      }
      keys.forEach(function (k) {
        localStorage.removeItem(k);
      });
    } catch (_) {}
  }

  function hashString(input) {
    var h = 2166136261;
    var s = String(input || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function storageKey(token, projectUrl) {
    return STORAGE_PREFIX + hashString(String(projectUrl || '') + '\0' + String(token || ''));
  }

  function readStore(token, projectUrl) {
    try {
      var raw = activeStorage().getItem(storageKey(token, projectUrl));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== CACHE_VERSION || !parsed.entries) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function pruneStore(store, aggressive) {
    var entries = store.entries || {};
    var keys = Object.keys(entries);
    keys.sort(function (a, b) {
      return (entries[a].t || 0) - (entries[b].t || 0);
    });
    var removeCount = aggressive ? Math.max(1, Math.ceil(keys.length * 0.5)) : Math.max(1, Math.ceil(keys.length * 0.25));
    for (var i = 0; i < removeCount && i < keys.length; i++) {
      delete entries[keys[i]];
    }
  }

  function writeStore(token, projectUrl, store) {
    try {
      var json = JSON.stringify(store);
      if (json.length > MAX_STORE_BYTES) {
        pruneStore(store, false);
        json = JSON.stringify(store);
      }
      activeStorage().setItem(storageKey(token, projectUrl), json);
      return true;
    } catch (_) {
      try {
        pruneStore(store, true);
        activeStorage().setItem(storageKey(token, projectUrl), JSON.stringify(store));
        return true;
      } catch (__) {
        return false;
      }
    }
  }

  function normalizeEntryKey(method, path) {
    var full = String(path || '');
    var pathOnly = full;
    var query = '';
    var qIndex = full.indexOf('?');
    if (qIndex >= 0) {
      pathOnly = full.slice(0, qIndex);
      query = full.slice(qIndex + 1);
    }
    if (query) {
      var params = new URLSearchParams(query);
      params.delete('_ts');
      var pairs = Array.from(params.entries()).sort(function (a, b) {
        return a[0].localeCompare(b[0]);
      });
      var qs = pairs.map(function (pair) {
        return pair[0] + '=' + pair[1];
      }).join('&');
      pathOnly = qs ? (pathOnly + '?' + qs) : pathOnly;
    }
    return String(method || 'GET').toUpperCase() + ' ' + pathOnly;
  }

  function buildEntryKey(namespace, method, path) {
    return String(namespace || 'default') + '|' + normalizeEntryKey(method, path);
  }

  var SiteCache = {
    get: function (token, projectUrl, namespace, method, path, options) {
      var opts = options || {};
      var maxAge = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
      var store = readStore(token, projectUrl);
      if (!store) return null;
      var key = buildEntryKey(namespace, method, path);
      var entry = store.entries[key];
      if (!entry || entry.d === undefined) return null;
      var age = Date.now() - (entry.t || 0);
      if (age > maxAge) return null;
      var freshMs = Number.isFinite(opts.freshMs) ? opts.freshMs : 60 * 1000;
      return {
        data: entry.d,
        savedAt: entry.t,
        ageMs: age,
        stale: age > freshMs,
      };
    },

    set: function (token, projectUrl, namespace, method, path, data) {
      if (!token || !projectUrl) return false;
      var store = readStore(token, projectUrl) || { v: CACHE_VERSION, entries: {} };
      var key = buildEntryKey(namespace, method, path);
      store.entries[key] = { d: data, t: Date.now() };
      return writeStore(token, projectUrl, store);
    },

    clearAuth: function (token, projectUrl) {
      try {
        activeStorage().removeItem(storageKey(token, projectUrl));
        localStorage.removeItem(storageKey(token, projectUrl));
      } catch (_) {}
    },

    clearAll: function () {
      try {
        var keys = [];
        var storage = activeStorage();
        for (var i = 0; i < storage.length; i++) {
          var k = storage.key(i);
          if (k && k.indexOf(STORAGE_PREFIX) === 0) keys.push(k);
        }
        keys.forEach(function (k) {
          storage.removeItem(k);
        });
      } catch (_) {}
      clearLegacyPersistentCaches();
    },
  };

  clearLegacyPersistentCaches();

  global.LINE_REPORT_SITE_CACHE = SiteCache;
})(typeof globalThis !== 'undefined' ? globalThis : window);
