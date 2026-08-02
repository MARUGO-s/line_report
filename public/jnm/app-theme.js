/*
 * app-theme.js — 全ページ共通のダーク/ライトテーマ。
 *
 * 保存キーは全ページ共通の 'line_reservation_calendar_theme'。
 * data-theme を <body> と <html>(documentElement) の両方へ設定するため、
 * CSS が body[data-theme] / :root[data-theme] のどちらを基準にしていても効く。
 * ページに #themeToggleBtn があれば「ライトモード/ダークモード」トグルとして配線する。
 *
 * 冪等: 同じボタンに二重の click ハンドラを付けない（data 属性でガード）。
 * 依存なし: ページ個別の state / dom / 関数には一切依存しない。
 */
(function () {
  'use strict';

  var KEY = 'line_reservation_calendar_theme';

  function normalize(v) {
    return String(v || 'light').trim().toLowerCase() === 'dark' ? 'dark' : 'light';
  }
  function current() {
    try { return normalize(localStorage.getItem(KEY)); } catch (_) { return 'light'; }
  }
  function apply(theme) {
    var t = normalize(theme);
    try { if (document.body) document.body.setAttribute('data-theme', t); } catch (_) {}
    try { document.documentElement.setAttribute('data-theme', t); } catch (_) {}
    var btn = document.getElementById('themeToggleBtn');
    if (btn) {
      var isLight = t === 'light';
      btn.textContent = isLight ? 'ダークモード' : 'ライトモード';
      btn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
      btn.title = isLight ? 'ダークモードに切り替え' : 'ライトモードに切り替え';
    }
  }
  function set(theme) {
    var t = normalize(theme);
    try { localStorage.setItem(KEY, t); } catch (_) {}
    apply(t);
  }
  function wire() {
    apply(current());
    var btn = document.getElementById('themeToggleBtn');
    if (btn && !btn.dataset.appThemeWired) {
      btn.dataset.appThemeWired = '1';
      btn.addEventListener('click', function () {
        set(current() === 'light' ? 'dark' : 'light');
      });
    }
  }

  // FOUC 低減: <html> には即座に反映（body 反映とボタン配線は DOM 構築後）。
  try { document.documentElement.setAttribute('data-theme', current()); } catch (_) {}
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // 互換 API（任意で参照できるように公開）
  window.LINE_REPORT_THEME = { get: current, set: set, apply: apply, STORAGE_KEY: KEY };
})();
