/*
 * menu-logout.js — 全ページ共通のサイドメニュー「ログアウト」ボタン。
 *
 * サイドメニューのフッター（.ms-side-foot / .lsa-side-foot）に #logoutBtn を注入する。
 * ページ個別の関数（getToken / logoutToken / clearSiteCacheForToken 等）には依存せず、
 * pages-config.js の LINE_REPORT_PAGES と auth-session.js の LINE_REPORT_AUTH だけで完結する。
 *
 * 冪等: 既に #logoutBtn があるページ（media.html は独自実装）では何もしない。
 * メニューフッターが無いページ（接続設定 index.html 等）でもスキップする。
 */
(function () {
  'use strict';

  function resolveLogoutUrl() {
    try {
      var P = window.LINE_REPORT_PAGES;
      if (P && typeof P.receiptAdminApiUrl === 'function') return P.receiptAdminApiUrl('/auth/logout');
      if (P && typeof P.adminApiUrl === 'function') return P.adminApiUrl('/auth/logout', P.PROJECT_URL);
    } catch (_) {}
    return '';
  }

  async function doLogout() {
    try {
      var A = window.LINE_REPORT_AUTH;
      if (A && typeof A.logout === 'function') {
        var opts = {};
        var url = resolveLogoutUrl();
        if (url) opts.logoutUrl = url;
        var P = window.LINE_REPORT_PAGES;
        if (P && P.ADMIN_SURFACE) opts.adminSurface = P.ADMIN_SURFACE;
        await A.logout(opts);
      } else if (A && typeof A.clearToken === 'function') {
        A.clearToken();
      }
    } catch (_) {
      /* 失敗してもローカルのトークンは概ね消えている。続行して接続設定へ戻す。 */
    }
    window.location.href = './index.html';
  }

  function injectStyle() {
    if (document.getElementById('logoutBtnStyle')) return;
    var st = document.createElement('style');
    st.id = 'logoutBtnStyle';
    st.textContent =
      '#logoutBtn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;' +
      'margin-top:12px;padding:9px 12px;border-radius:9px;border:1px solid rgba(255,255,255,.12);' +
      'background:transparent;color:#aeb8c4;font-size:13px;font-weight:700;cursor:pointer;' +
      'font-family:inherit;line-height:1.2;transition:background .12s,color .12s,border-color .12s;}' +
      '#logoutBtn:hover{background:rgba(220,53,69,.14);color:#ff8f9a;border-color:rgba(220,53,69,.4);}' +
      '#logoutBtn:disabled{opacity:.6;cursor:default;}' +
      '#logoutBtn svg{flex:none;}';
    document.head.appendChild(st);
  }

  function inject() {
    if (document.getElementById('logoutBtn')) return; // 既に有る（media.html 等）→ 何もしない
    var foot = document.querySelector('.ms-side-foot, .lsa-side-foot');
    if (!foot) return; // サイドメニューが無いページはスキップ
    injectStyle();
    var btn = document.createElement('button');
    btn.id = 'logoutBtn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'ログアウト');
    btn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>' +
      '<span>ログアウト</span>';
    var busy = false;
    btn.addEventListener('click', async function () {
      if (busy) return;
      if (!window.confirm('ログアウトします。よろしいですか？')) return;
      busy = true;
      btn.disabled = true;
      await doLogout();
    });
    foot.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
