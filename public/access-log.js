/**
 * 画面表示を admin-api へ送る。操作の正本はサーバー側の API 記録。
 */
(function (global) {
  'use strict';

  function pageKey() {
    try {
      var path = String(global.location && global.location.pathname || '');
      var file = path.split('/').pop() || 'index.html';
      return file.replace(/\.html$/i, '') || 'index';
    } catch (_) {
      return 'unknown';
    }
  }

  function getToken() {
    try {
      if (global.AUTH && typeof global.AUTH.getToken === 'function') return global.AUTH.getToken();
    } catch (_) {}
    return '';
  }

  function postPageView() {
    var token = getToken();
    var pages = global.LINE_REPORT_PAGES;
    if (!token || !pages || typeof pages.adminApiUrl !== 'function') return;
    if (postPageView.sent) return;
    postPageView.sent = true;
    var body = {
      event_kind: 'page_view',
      action: 'page_view',
      page: pageKey(),
      path: String(global.location && (global.location.pathname + global.location.search) || ''),
    };
    fetch(pages.adminApiUrl('/access/events', pages.PROJECT_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-admin-token': token,
        'x-admin-surface': pages.ADMIN_SURFACE || 'line_report',
      },
      body: JSON.stringify(body),
      keepalive: true,
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }).catch(function () {});
  }

  function start() {
    if (!getToken()) return;
    postPageView();
  }

  global.ACCESS_LOG = { pageView: function () { postPageView.sent = false; postPageView(); } };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window);
