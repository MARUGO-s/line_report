'use strict';

// ============================================================================
// M-talk 管理画面：通話時間・AI API料金（日別・月別）ダッシュボード
// 本番 Edge Function `chat-admin-usage` と連携（アプリ版と同一集計・同一認証）
// ============================================================================

(function () {
  const usageState = {
    granularity: 'month',
    date: '',
    userId: '',
    usdJpyRate: 155,
    metric: 'ai', // 'ai' | 'call'
    tab: 'users', // 'users' | 'modes' | 'calls' | 'ai'
    userSort: 'cost', // 'cost' | 'call' | 'req'
    loading: false,
    report: null,
    error: '',
  };

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function jstNowParts() {
    const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return { y, m, day, dayKey: `${y}-${m}-${day}`, monthKey: `${y}-${m}` };
  }

  function shiftPeriodKey(granularity, key, delta) {
    if (granularity === 'day') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
      const base = m
        ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        : Date.UTC(...Object.values(jstNowParts()).slice(0, 3).map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
      const next = new Date(base + delta * 86400000);
      return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
    }
    const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
    const now = jstNowParts();
    const y = m ? Number(m[1]) : now.y;
    const mo = m ? Number(m[2]) : Number(now.m);
    const total = y * 12 + (mo - 1) + delta;
    const ny = Math.floor(total / 12);
    const nm = ((total % 12) + 12) % 12 + 1;
    return `${ny}-${String(nm).padStart(2, '0')}`;
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}時間${String(m).padStart(2, '0')}分${String(r).padStart(2, '0')}秒`;
    if (m > 0) return `${m}分${String(r).padStart(2, '0')}秒`;
    return `${r}秒`;
  }

  function formatJpy(value) {
    const n = Number(value) || 0;
    if (n === 0) return '¥0';
    if (n < 1) return `¥${n.toFixed(2)}`;
    if (n < 100) return `¥${n.toFixed(1)}`;
    return `¥${Math.round(n).toLocaleString('ja-JP')}`;
  }

  function formatUsd(value) {
    const n = Number(value) || 0;
    if (n === 0) return '$0.0000';
    if (n < 0.01) return `$${n.toFixed(6)}`;
    return `$${n.toFixed(4)}`;
  }

  function formatNum(value) {
    return (Number(value) || 0).toLocaleString('ja-JP');
  }

  function getAuthContext() {
    const pages = window.LINE_REPORT_PAGES || {};
    const auth = window.LINE_REPORT_AUTH;
    const projectUrl = pages.PROJECT_URL || 'https://hocbnifuactbvmyjraxy.supabase.co';
    const adminSurface = pages.ADMIN_SURFACE || 'line_report';
    const anonKey = pages.RECEIPT_ADMIN_ANON_KEY || pages.SUPABASE_ANON_KEY || '';
    const adminToken = auth && typeof auth.getToken === 'function' ? auth.getToken() : '';
    return { projectUrl, adminSurface, anonKey, adminToken };
  }

  function ensureDefaultDate() {
    const now = jstNowParts();
    if (usageState.granularity === 'day') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(usageState.date)) usageState.date = now.dayKey;
    } else {
      if (!/^\d{4}-\d{2}$/.test(usageState.date)) usageState.date = now.monthKey;
    }
  }

  async function fetchUsageReport() {
    const { projectUrl, adminSurface, anonKey, adminToken } = getAuthContext();
    if (!adminToken) return;
    ensureDefaultDate();
    usageState.loading = true;
    usageState.error = '';
    renderUsageView();
    try {
      const headers = {
        'x-admin-token': adminToken,
        'x-admin-surface': adminSurface,
        'Content-Type': 'application/json',
      };
      if (anonKey) headers['apikey'] = anonKey;
      const resp = await fetch(`${projectUrl}/functions/v1/chat-admin-usage`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          granularity: usageState.granularity,
          date: usageState.date,
          user_id: usageState.userId || '',
          usd_jpy_rate: usageState.usdJpyRate,
        }),
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(body.error || `集計の取得に失敗しました (${resp.status})`);
      }
      usageState.report = body;
      if (body.period && body.period.key) usageState.date = body.period.key;
      if (Number.isFinite(Number(body.usd_jpy_rate))) usageState.usdJpyRate = Number(body.usd_jpy_rate);
    } catch (err) {
      usageState.error = err.message || String(err);
    } finally {
      usageState.loading = false;
      renderUsageView();
    }
  }

  function renderBarSeries(series, title, clickableKind) {
    const list = Array.isArray(series) ? series : [];
    const metric = usageState.metric;
    const values = list.map((item) => metric === 'ai' ? Number(item.total_cost_jpy || 0) : Number(item.total_call_seconds || 0));
    const maxVal = Math.max(0, ...values);
    if (!list.length) return `<div class="empty">${esc(title)}のデータはありません</div>`;

    const bars = list.map((item, idx) => {
      const val = values[idx];
      const pct = maxVal > 0 ? Math.max(val > 0 ? 4 : 0, Math.round((val / maxVal) * 100)) : 0;
      const valueText = metric === 'ai'
        ? `${formatJpy(item.total_cost_jpy)} (${formatNum(item.ai_request_count)}回)`
        : `${formatDuration(item.total_call_seconds)} (${formatNum(item.call_count)}件)`;
      const isSelected = usageState.report && usageState.report.period && usageState.report.period.key === item.key;
      const clickable = clickableKind ? ` data-usage-drill="${esc(clickableKind)}" data-usage-key="${esc(item.key)}"` : '';
      return `<div class="usage-bar-row${isSelected ? ' is-current' : ''}${clickable ? ' is-clickable' : ''}"${clickable} title="${esc(`${item.label}: ${valueText}`)}">
        <span class="usage-bar-label">${esc(item.label)}</span>
        <span class="usage-bar-track"><span class="usage-bar-fill ${metric}" style="width:${pct}%"></span></span>
        <span class="usage-bar-val">${esc(valueText)}</span>
      </div>`;
    }).join('');
    return `<div class="usage-chart-card">
      <div class="usage-chart-head">
        <strong>${esc(title)}</strong>
        <span class="badge">${metric === 'ai' ? 'AI API料金 (JPY)' : '通話時間'}</span>
      </div>
      <div class="usage-bar-list">${bars}</div>
    </div>`;
  }

  function renderDetailTable(report) {
    const tab = usageState.tab;
    if (tab === 'users') {
      const rows = (Array.isArray(report.by_user) ? report.by_user : []).slice();
      rows.sort((a, b) => {
        if (usageState.userSort === 'call') return (b.total_call_seconds - a.total_call_seconds) || (b.total_cost_usd - a.total_cost_usd);
        if (usageState.userSort === 'req') return (b.ai_request_count - a.ai_request_count) || (b.total_cost_usd - a.total_cost_usd);
        return (b.total_cost_usd - a.total_cost_usd) || (b.total_call_seconds - a.total_call_seconds);
      });
      if (!rows.length) return '<div class="empty">対象期間のユーザー実績はありません</div>';
      return `<div class="usage-sort-bar">
        <span>並び替え:</span>
        <button type="button" class="tab${usageState.userSort === 'cost' ? ' active' : ''}" data-usage-sort="cost">AI料金順</button>
        <button type="button" class="tab${usageState.userSort === 'call' ? ' active' : ''}" data-usage-sort="call">通話時間順</button>
        <button type="button" class="tab${usageState.userSort === 'req' ? ' active' : ''}" data-usage-sort="req">AI回数順</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>ユーザー</th><th>通話時間</th><th>発信/着信</th><th>AI回数</th><th>トークン(入力/出力)</th><th>音声秒</th><th>AI料金 (JPY / USD)</th><th></th></tr></thead>
        <tbody>${rows.map((u) => `<tr>
          <td><strong>${esc(u.username)}</strong><br><small style="color:var(--muted)">${esc(u.user_id)}</small></td>
          <td>${esc(formatDuration(u.total_call_seconds))}<br><small style="color:var(--muted)">成立 ${formatNum(u.answered_call_count)} / ${formatNum(u.call_count)}件</small></td>
          <td>発 ${formatNum(u.outgoing_count)} (${esc(formatDuration(u.outgoing_seconds))})<br>着 ${formatNum(u.incoming_count)} (${esc(formatDuration(u.incoming_seconds))})</td>
          <td>${formatNum(u.ai_request_count)}回</td>
          <td>${formatNum(u.total_prompt_tokens)} / ${formatNum(u.total_completion_tokens)}<br><small style="color:var(--muted)">キャッシュ ${formatNum(u.total_cached_tokens)}</small></td>
          <td>${Number(u.total_audio_seconds || 0).toFixed(1)}秒</td>
          <td><strong>${esc(formatJpy(u.total_cost_jpy))}</strong><br><small style="color:var(--muted)">${esc(formatUsd(u.total_cost_usd))}</small></td>
          <td><button type="button" class="btn" data-usage-filter-user="${esc(u.user_id)}">絞込</button></td>
        </tr>`).join('')}</tbody>
      </table></div>`;
    }

    if (tab === 'modes') {
      const rows = Array.isArray(report.by_mode) ? report.by_mode : [];
      if (!rows.length) return '<div class="empty">対象期間のAI利用実績はありません</div>';
      return `<div class="table-wrap"><table>
        <thead><tr><th>機能</th><th>モデル</th><th>呼出回数</th><th>入力トークン</th><th>キャッシュ</th><th>出力(思考)</th><th>音声秒</th><th>料金 (JPY / USD)</th></tr></thead>
        <tbody>${rows.map((m) => `<tr>
          <td><strong>${esc(m.mode_label || m.mode)}</strong></td>
          <td><span class="badge">${esc(m.model)}</span></td>
          <td>${formatNum(m.request_count)}回</td>
          <td>${formatNum(m.prompt_tokens)}</td>
          <td>${formatNum(m.cached_prompt_tokens)}</td>
          <td>${formatNum(m.completion_tokens)}${m.reasoning_tokens ? ` <small>(思考 ${formatNum(m.reasoning_tokens)})</small>` : ''}</td>
          <td>${Number(m.audio_seconds || 0).toFixed(1)}秒</td>
          <td><strong>${esc(formatJpy(m.total_cost_jpy))}</strong><br><small style="color:var(--muted)">${esc(formatUsd(m.total_cost_usd))}</small></td>
        </tr>`).join('')}</tbody>
      </table></div>`;
    }

    if (tab === 'calls') {
      const rows = Array.isArray(report.call_history) ? report.call_history : [];
      if (!rows.length) return '<div class="empty">対象期間の電話履歴はありません</div>';
      return `<div class="table-wrap"><table>
        <thead><tr><th>日時 (JST)</th><th>発信</th><th>着信</th><th>種別</th><th>状態</th><th>通話時間</th></tr></thead>
        <tbody>${rows.map((c) => `<tr>
          <td>${esc(c.jst_label || c.created_at)}</td>
          <td>${esc(c.caller_name)}</td>
          <td>${esc(c.callee_name)}</td>
          <td><span class="badge">${c.is_group ? 'グループ' : '1対1'}・${c.call_type === 'video' ? 'ビデオ' : '音声'}</span></td>
          <td><span class="badge ${c.duration_seconds > 0 ? 'ok' : (c.status === 'missed' ? 'danger' : 'warn')}">${esc(c.status_label || c.status)}</span></td>
          <td><strong>${esc(formatDuration(c.duration_seconds))}</strong></td>
        </tr>`).join('')}</tbody>
      </table></div>${Number(report.call_history_total || 0) > rows.length ? `<div class="usage-foot-note">最新 ${rows.length} 件を表示中（全 ${formatNum(report.call_history_total)} 件）</div>` : ''}`;
    }

    const rows = Array.isArray(report.ai_history) ? report.ai_history : [];
    if (!rows.length) return '<div class="empty">対象期間のAI利用履歴はありません</div>';
    return `<div class="table-wrap"><table>
      <thead><tr><th>日時 (JST)</th><th>ユーザー</th><th>機能 / モデル</th><th>トークン / 音声</th><th>根拠</th><th>料金 (JPY / USD)</th></tr></thead>
      <tbody>${rows.map((a) => `<tr>
        <td>${esc(a.jst_label || a.created_at)}</td>
        <td>${esc(a.username)}</td>
        <td><strong>${esc(a.mode_label || a.mode)}</strong><br><span class="badge">${esc(a.model)}</span></td>
        <td>${a.audio_seconds > 0 ? `音声 ${Number(a.audio_seconds).toFixed(1)}秒` : `入 ${formatNum(a.prompt_tokens)} (cache ${formatNum(a.cached_prompt_tokens)}) / 出 ${formatNum(a.completion_tokens)}`}</td>
        <td><span class="badge">${esc(a.pricing_basis || '')}</span></td>
        <td><strong>${esc(formatJpy(a.total_cost_jpy))}</strong><br><small style="color:var(--muted)">${esc(formatUsd(a.total_cost_usd))}</small></td>
      </tr>`).join('')}</tbody>
    </table></div>${Number(report.ai_history_total || 0) > rows.length ? `<div class="usage-foot-note">最新 ${rows.length} 件を表示中（全 ${formatNum(report.ai_history_total)} 件）</div>` : ''}`;
  }

  function buildCsvText(report) {
    const lines = [];
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    lines.push(['期間', 'ユーザー', '通話件数', '成立件数', '通話秒数', 'AI呼出回数', '入力トークン', 'キャッシュトークン', '出力トークン', '音声秒', 'AI料金USD', 'AI料金JPY'].map(q).join(','));
    const label = report.period ? report.period.label : usageState.date;
    for (const u of (report.by_user || [])) {
      lines.push([
        label, u.username, u.call_count, u.answered_call_count, u.total_call_seconds,
        u.ai_request_count, u.total_prompt_tokens, u.total_cached_tokens, u.total_completion_tokens,
        u.total_audio_seconds, u.total_cost_usd, u.total_cost_jpy,
      ].map(q).join(','));
    }
    return lines.join('\n');
  }

  function downloadUsageCsv() {
    if (!usageState.report) return;
    const csv = '\uFEFF' + buildCsvText(usageState.report);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mtalk-usage-${(usageState.report.period && usageState.report.period.key) || 'report'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderUsageView() {
    const root = $('usageBody');
    if (!root) return;
    ensureDefaultDate();
    const report = usageState.report;
    const usersDir = (report && Array.isArray(report.users_directory)) ? report.users_directory : [];
    const totals = (report && report.totals) || {};
    const periodLabel = (report && report.period && report.period.label) || usageState.date;
    const cacheRate = Number(totals.total_prompt_tokens || 0) > 0
      ? `${Math.round((Number(totals.total_cached_tokens || 0) / Number(totals.total_prompt_tokens || 1)) * 100)}%`
      : '0%';

    const controlsHtml = `<div class="usage-toolbar">
      <div class="tabs">
        <button type="button" class="tab${usageState.granularity === 'day' ? ' active' : ''}" data-usage-granularity="day">日別</button>
        <button type="button" class="tab${usageState.granularity === 'month' ? ' active' : ''}" data-usage-granularity="month">月別</button>
      </div>
      <div class="usage-period-nav">
        <button type="button" class="btn" id="usagePrevBtn">◀ 前${usageState.granularity === 'day' ? '日' : '月'}</button>
        <input id="usageDateInput" type="${usageState.granularity === 'day' ? 'date' : 'month'}" value="${esc(usageState.date)}" style="width:auto">
        <button type="button" class="btn" id="usageNextBtn">次${usageState.granularity === 'day' ? '日' : '月'} ▶</button>
        <button type="button" class="btn" id="usageTodayBtn">${usageState.granularity === 'day' ? '今日' : '今月'}</button>
      </div>
      <div class="usage-filters">
        <select id="usageUserFilter" style="width:auto;min-width:160px">
          <option value="">全ユーザー</option>
          ${usersDir.map((u) => `<option value="${esc(u.id)}"${u.id === usageState.userId ? ' selected' : ''}>${esc(u.username)}</option>`).join('')}
        </select>
        <label class="usage-rate-field">USD/JPY <input id="usageRateInput" type="number" min="50" max="500" step="0.5" value="${esc(usageState.usdJpyRate)}" style="width:84px"></label>
        <button type="button" class="btn" id="usageReloadBtn"${usageState.loading ? ' disabled' : ''}>${usageState.loading ? '集計中…' : '再集計'}</button>
        <button type="button" class="btn" id="usageCsvBtn"${report ? '' : ' disabled'}>CSV保存</button>
      </div>
    </div>`;

    if (usageState.error) {
      root.innerHTML = controlsHtml + `<div class="notice error" style="margin:14px 18px">${esc(usageState.error)}</div>`;
      return;
    }
    if (!report) {
      root.innerHTML = controlsHtml + `<div class="empty">${usageState.loading ? '通話時間・AI API料金を集計しています…' : '再集計を押して読み込みます'}</div>`;
      return;
    }

    const truncHtml = report.truncated
      ? '<div class="notice" style="margin:12px 18px 0">対象期間のログが上限（15,000件）を超えたため、最新の15,000件で集計しています。日付を絞ると全件を確認できます。</div>'
      : '';

    const kpiHtml = `<div class="usage-kpi-grid">
      <div class="metric">
        <span>総通話時間（${esc(periodLabel)}）</span>
        <strong>${esc(formatDuration(totals.total_call_seconds))}</strong>
        <small>成立 ${formatNum(totals.answered_call_count)}件 / 不在・取消 ${formatNum(totals.missed_or_canceled_count)}件</small>
      </div>
      <div class="metric">
        <span>通話内訳（音声 / ビデオ / グループ）</span>
        <strong style="font-size:17px">${esc(formatDuration(totals.audio_call_seconds))}</strong>
        <small>ビデオ ${esc(formatDuration(totals.video_call_seconds))} ・ グループ ${esc(formatDuration(totals.group_call_seconds))}</small>
      </div>
      <div class="metric">
        <span>AI API料金合計（1 USD = ¥${esc(usageState.usdJpyRate)}）</span>
        <strong>${esc(formatJpy(totals.total_cost_jpy))}</strong>
        <small>${esc(formatUsd(totals.total_cost_usd))} ・ ${formatNum(totals.ai_request_count)}回呼出</small>
      </div>
      <div class="metric">
        <span>AIトークン / 音声文字起こし</span>
        <strong style="font-size:17px">キャッシュ率 ${esc(cacheRate)}</strong>
        <small>入 ${formatNum(totals.total_prompt_tokens)} / 出 ${formatNum(totals.total_completion_tokens)} ・ 音声 ${Number(totals.total_audio_seconds || 0).toFixed(1)}秒</small>
      </div>
    </div>`;

    const chartToggleHtml = `<div class="usage-metric-bar">
      <div class="tabs">
        <button type="button" class="tab${usageState.metric === 'ai' ? ' active' : ''}" data-usage-metric="ai">AI料金でグラフ表示</button>
        <button type="button" class="tab${usageState.metric === 'call' ? ' active' : ''}" data-usage-metric="call">通話時間でグラフ表示</button>
      </div>
      <small style="color:var(--muted)">棒グラフをクリックすると該当の${usageState.granularity === 'day' ? '日' : '月・日'}へ移動します</small>
    </div>`;

    const chartsHtml = `<div class="usage-charts-grid">
      ${renderBarSeries(report.trend_series, usageState.granularity === 'day' ? '直近14日間の推移' : '直近6ヶ月の推移', usageState.granularity)}
      ${renderBarSeries(report.breakdown_series, usageState.granularity === 'day' ? `${periodLabel} の時間帯別内訳` : `${periodLabel} の日別内訳`, usageState.granularity === 'month' ? 'day' : '')}
    </div>`;

    const tabsHtml = `<div class="usage-detail-tabs">
      <div class="tabs">
        <button type="button" class="tab${usageState.tab === 'users' ? ' active' : ''}" data-usage-tab="users">ユーザー別 (${(report.by_user || []).length})</button>
        <button type="button" class="tab${usageState.tab === 'modes' ? ' active' : ''}" data-usage-tab="modes">機能・モデル別 (${(report.by_mode || []).length})</button>
        <button type="button" class="tab${usageState.tab === 'calls' ? ' active' : ''}" data-usage-tab="calls">電話履歴 (${formatNum(report.call_history_total || 0)})</button>
        <button type="button" class="tab${usageState.tab === 'ai' ? ' active' : ''}" data-usage-tab="ai">AI料金履歴 (${formatNum(report.ai_history_total || 0)})</button>
      </div>
    </div>`;

    root.innerHTML = controlsHtml + truncHtml + kpiHtml + chartToggleHtml + chartsHtml + tabsHtml + renderDetailTable(report);
  }

  function bindUsageEvents() {
    const root = $('usageBody');
    if (!root) return;
    root.addEventListener('click', (event) => {
      const gBtn = event.target.closest('[data-usage-granularity]');
      if (gBtn) {
        const next = gBtn.dataset.usageGranularity === 'day' ? 'day' : 'month';
        if (usageState.granularity !== next) {
          usageState.granularity = next;
          const now = jstNowParts();
          usageState.date = next === 'day' ? now.dayKey : now.monthKey;
          fetchUsageReport();
        }
        return;
      }
      if (event.target.closest('#usagePrevBtn')) {
        usageState.date = shiftPeriodKey(usageState.granularity, usageState.date, -1);
        fetchUsageReport();
        return;
      }
      if (event.target.closest('#usageNextBtn')) {
        usageState.date = shiftPeriodKey(usageState.granularity, usageState.date, 1);
        fetchUsageReport();
        return;
      }
      if (event.target.closest('#usageTodayBtn')) {
        const now = jstNowParts();
        usageState.date = usageState.granularity === 'day' ? now.dayKey : now.monthKey;
        fetchUsageReport();
        return;
      }
      if (event.target.closest('#usageReloadBtn')) {
        const rateEl = $('usageRateInput');
        if (rateEl) {
          const r = Number(rateEl.value);
          if (Number.isFinite(r) && r >= 50 && r <= 500) usageState.usdJpyRate = r;
        }
        fetchUsageReport();
        return;
      }
      if (event.target.closest('#usageCsvBtn')) {
        downloadUsageCsv();
        return;
      }
      const mBtn = event.target.closest('[data-usage-metric]');
      if (mBtn) {
        usageState.metric = mBtn.dataset.usageMetric === 'call' ? 'call' : 'ai';
        renderUsageView();
        return;
      }
      const tBtn = event.target.closest('[data-usage-tab]');
      if (tBtn) {
        usageState.tab = tBtn.dataset.usageTab;
        renderUsageView();
        return;
      }
      const sBtn = event.target.closest('[data-usage-sort]');
      if (sBtn) {
        usageState.userSort = sBtn.dataset.usageSort;
        renderUsageView();
        return;
      }
      const uBtn = event.target.closest('[data-usage-filter-user]');
      if (uBtn) {
        const uid = uBtn.dataset.usageFilterUser || '';
        usageState.userId = usageState.userId === uid ? '' : uid;
        fetchUsageReport();
        return;
      }
      const drill = event.target.closest('[data-usage-drill]');
      if (drill) {
        const kind = drill.dataset.usageDrill;
        const key = drill.dataset.usageKey;
        if (kind && key) {
          usageState.granularity = kind === 'day' ? 'day' : 'month';
          usageState.date = key;
          fetchUsageReport();
        }
      }
    });

    root.addEventListener('change', (event) => {
      if (event.target.id === 'usageDateInput') {
        usageState.date = event.target.value;
        fetchUsageReport();
        return;
      }
      if (event.target.id === 'usageUserFilter') {
        usageState.userId = event.target.value;
        fetchUsageReport();
        return;
      }
      if (event.target.id === 'usageRateInput') {
        const r = Number(event.target.value);
        if (Number.isFinite(r) && r >= 50 && r <= 500) {
          usageState.usdJpyRate = r;
          fetchUsageReport();
        }
      }
    });
  }

  function clearUsageState() {
    usageState.report = null;
    usageState.error = '';
    usageState.loading = false;
    const root = $('usageBody');
    if (root) root.replaceChildren();
  }

  window.MTALK_ADMIN_USAGE = {
    load: fetchUsageReport,
    clear: clearUsageState,
    render: renderUsageView,
  };

  document.addEventListener('DOMContentLoaded', bindUsageEvents);
})();
