/**
 * 全店舗: スプレッドシート ↔ Supabase 同期（GAS 経由）
 *
 * 1スプレッドシート内に店舗ごとのタブを作成し、それぞれ hocbn DB と同期します。
 * タブ名: {店舗キー}_月間予算 / {店舗キー}_過去売上 / {店舗キー}_日次売上
 *
 * スクリプト プロパティ（必須）:
 *   SUPABASE_RECEIPT_SHEETS_SYNC_URL
 *   RECEIPT_SHEETS_SYNC_SECRET
 */

var SYNC = {
  URL: 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/receipt-sheets-sync-cron',
  SITE_LABEL: 'line_report（hocbn）',
  LEGACY_PROJECT_REFS: ['jhpmzqxqvapdkyvvhyra'],
};

/** pages-config.js STORE_NAMES と同期 */
var STORE_CATALOG = [
  { key: 'marugo', name: 'マルゴ' },
  { key: 'marugosecond', name: 'マルゴ セカンド' },
  { key: 'marugogrande', name: 'マルゴ グランデ' },
  { key: 'sannanaichi', name: 'サンナナイチ バル' },
  { key: 'shenlong', name: 'シェンロン&クラウディア' },
  { key: 'claudia2', name: 'クラウディア2' },
  { key: 'sauvage', name: 'ソバージュ' },
  { key: 'barpelota', name: 'バルぺロタ' },
  { key: 'briccola', name: 'トラットリア ブリッコラ' },
  { key: 'violette', name: 'ヴィオレット' },
  { key: 'marugootto', name: 'マルゴ オット' },
  { key: 'donaiya', name: '元祖どないや 新宿三丁目店' },
  { key: 'marugoyotsuya', name: 'マルゴ 四谷' },
  { key: 'sushikoruri', name: '鮨こるり' },
  { key: 'bistrocavacava', name: 'ビストロ サヴァサヴァ' },
  { key: 'marugoS', name: 'マルゴエス' },
  { key: 'marugoshinbashi', name: 'マルゴ 新橋' },
  { key: 'marugomarunouchi', name: 'マルゴ丸の内' },
  { key: 'yakinikumarugo', name: '焼肉マルゴ' },
  { key: 'erics', name: 'エリックスバイエリックトロション' },
  { key: 'mitan', name: 'ミタン' },
  { key: 'marugoD', name: 'マルゴ D' },
];

var LEGACY_TAB_BUDGETS = ['月間予算', 'monthly_budgets'];
var LEGACY_TAB_PAST = ['過去売上', 'past_sales'];
var LEGACY_TAB_DAILY = ['日次売上', 'daily_sales'];
var TAB_LOG = ['同期ログ', 'sync_log'];
var TAB_OPS = ['操作', 'ops', '操作パネル'];
var TAB_README = ['使い方', 'readme'];
var TAB_STORE_INDEX = ['店舗一覧', 'stores'];
var TAB_TOC = ['目次', 'TOC', 'index'];
var TAB_CONFIG = ['設定', 'config'];
/** 各シート1行目の「目次に戻る」ボタン設置列（データ列と重ならない L 列） */
var BACK_TO_TOC_COL = 12;
/** GAS 実行上限 6 分の手前で打ち切る（ミリ秒） */
var SYNC_TIME_BUDGET_MS = 4.5 * 60 * 1000;
/** Supabase への同時リクエスト数（UrlFetchApp.fetchAll） */
var SYNC_PARALLEL_BATCH = 6;
var SYNC_RESUME_INDEX_KEY = 'SYNC_RESUME_INDEX';
var SYNC_RESUME_DIRECTION_KEY = 'SYNC_RESUME_DIRECTION';

function onOpen() {
  try {
    ensureOperationSheetCurrent_();
    ensureReadmeSheet_();
    ensureStoreIndexSheet_();
    ensureTableOfContentsSheet_();
  } catch (e) {
    Logger.log('onOpen setup: ' + e);
  }
  SpreadsheetApp.getUi()
    .createMenu('売上連携（全店舗）')
    .addItem('⚡ 全店舗 同期（約10秒で開始）', 'syncBothServerFast')
    .addSeparator()
    .addItem('全店舗 双方向同期（GAS経由・詳細）', 'syncBoth')
    .addItem('全店舗 取込のみ', 'syncPull')
    .addItem('全店舗 書出のみ', 'syncPush')
    .addItem('続きから全店舗同期', 'syncContinue')
    .addSeparator()
    .addItem('操作シートを作成・更新（スマホ用）', 'setupOperationSheet')
    .addItem('店舗タブを一括作成', 'setupAllStoreSheets')
    .addItem('目次を更新', 'setupTableOfContents')
    .addItem('目次に戻るボタンを全シートに設置', 'installBackToTocOnAllSheets')
    .addItem('接続設定を確認', 'showConnectionInfo')
    .addItem('接続設定タブを作成して Secret を入力', 'setupConfigSheetWizard')
    .addItem('接続設定を「設定」タブから読込', 'applySyncConfigFromSheet')
    .addItem('旧タブを店舗別タブへ移行', 'migrateLegacyTabs')
    .addToUi();
}

function syncBoth() { runSyncAllStores_('both'); }
function syncPull() { runSyncAllStores_('pull'); }
function syncPush() { runSyncAllStores_('push'); }

/** サーバーが Sheets API で全店舗同期（GAS は開始だけ ≈10秒） */
function syncBothServerFast() {
  triggerServerBackgroundSync_('both');
}
function syncPullServerFast() {
  triggerServerBackgroundSync_('pull');
}
function syncPushServerFast() {
  triggerServerBackgroundSync_('push');
}

/**
 * 毎日自動実行用（タイムトリガーから呼ぶ。UI なし）
 * GAS トリガー設定: 時間主導型 → 日付ベースのタイマー → 午前6時〜7時
 */
function dailyAutoSync() {
  var creds = getSyncCredentials_();
  try {
    var response = UrlFetchApp.fetch(
      creds.url,
      makeSyncFetchRequest_(creds.url, creds.secret, {
        direction: 'both',
        background_sync: true,
      })
    );
    console.log('dailyAutoSync: HTTP ' + response.getResponseCode());
  } catch (e) {
    console.error('dailyAutoSync failed: ' + e);
  }
}

function triggerServerBackgroundSync_(direction) {
  var creds = getSyncCredentials_();
  var issues = validateSyncConnection_(creds.url, creds.secret);
  if (issues.length) {
    SpreadsheetApp.getUi().alert(issues.join('\n\n'));
    return;
  }
  var startedAt = new Date().toISOString();
  var t0 = Date.now();
  var response = UrlFetchApp.fetch(
    creds.url,
    makeSyncFetchRequest_(creds.url, creds.secret, {
      direction: direction,
      background_sync: true,
    }),
  );
  var elapsed = Math.max(1, Math.round((Date.now() - t0) / 1000));
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code !== 202 && code !== 200) {
    SpreadsheetApp.getUi().alert('開始できませんでした (' + code + ')\n\n' + text.slice(0, 600));
    return;
  }
  // Store context for polling
  PropertiesService.getScriptProperties().setProperty('SYNC_BG_STARTED_AT', startedAt);
  PropertiesService.getScriptProperties().setProperty('SYNC_BG_ELAPSED', String(elapsed));
  // Show non-blocking sidebar that polls for completion
  showSyncProgressSidebar_();
}

/** ポーリングサイドバーを表示する（バックグラウンド同期の完了待ち） */
function showSyncProgressSidebar_() {
  var html = HtmlService.createHtmlOutput(buildSyncProgressHtml_())
    .setTitle('同期中...')
    .setWidth(320);
  SpreadsheetApp.getUi().showSidebar(html);
}

/** サーバーの同期完了ステータスを確認する（サイドバーから google.script.run で呼ばれる） */
// 注意: google.script.run から呼ぶ関数は _ で終わってはいけない（プライベート扱いになる）
function checkSyncComplete() {
  var props = PropertiesService.getScriptProperties();
  var startedAt = props.getProperty('SYNC_BG_STARTED_AT') || '';
  var elapsed = parseInt(props.getProperty('SYNC_BG_ELAPSED') || '1', 10);
  var creds = getSyncCredentials_();
  try {
    var response = UrlFetchApp.fetch(
      creds.url,
      makeSyncFetchRequest_(creds.url, creds.secret, { get_sync_status: true }),
    );
    var body = JSON.parse(response.getContentText());
    var lastCompleted = body.last_completed_at || '';
    var errorMsg = body.error_message || '';
    // 「進行中」メッセージは中間書き込みなので完了扱いにしない
    var isInProgress = errorMsg.indexOf('進行中') === 0;
    var done = lastCompleted && startedAt && lastCompleted > startedAt && !isInProgress;
    var failed = done && !!body.failed;
    return { done: !!done, failed: failed, errorMsg: errorMsg, lastCompleted: lastCompleted, startedAt: startedAt, elapsed: elapsed };
  } catch (e) {
    return { done: false, failed: false, errorMsg: '', error: String(e), startedAt: startedAt, elapsed: elapsed };
  }
}

function buildSyncProgressHtml_() {
  // MAX_WAIT_MS: 5分（300秒）待ってもサーバーから完了が来なければタイムアウト表示
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<style>body{font-family:sans-serif;padding:16px;margin:0;background:#fff}' +
    '.spinner{display:inline-block;width:20px;height:20px;border:3px solid #ddd;' +
    'border-top-color:#4285f4;border-radius:50%;animation:spin 1s linear infinite;vertical-align:middle;margin-right:8px}' +
    '@keyframes spin{to{transform:rotate(360deg)}}' +
    '.done{color:#188038;font-weight:bold;font-size:15px}' +
    '.err{color:#c62828;font-size:13px;margin-top:8px}' +
    '.small{font-size:12px;color:#888;margin-top:6px}' +
    '.btn{margin-top:12px;padding:6px 14px;background:#4285f4;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px}' +
    '.btn:hover{background:#3367d6}</style></head>' +
    '<body>' +
    '<div id="main"><span class="spinner"></span><span id="msg">同期中です...</span></div>' +
    '<div class="small" id="sub">完了したら自動で通知します（最大5分待機）</div>' +
    '<script>' +
    'var pollCount = 0;' +
    'var MAX_POLLS = 20;' + // 20回×15秒 = 5分
    'function poll() {' +
    '  if (pollCount >= MAX_POLLS) { showTimeout(); return; }' +
    '  google.script.run.withSuccessHandler(onResult).withFailureHandler(onErr).checkSyncComplete();' +
    '}' +
    'function onResult(r) {' +
    '  pollCount++;' +
    '  if (r.done && r.failed) {' +
    '    document.getElementById("main").innerHTML = \'<span style="font-size:22px">⚠️</span> <span class="err">同期中にエラーが発生しました</span>\';' +
    '    document.getElementById("sub").innerHTML = \'<span class="err">\' + (r.errorMsg || "詳細はサーバーログを確認してください") + \'</span><br><button class="btn" onclick="google.script.host.close()">閉じる</button>\';' +
    '  } else if (r.done) {' +
    '    document.getElementById("main").innerHTML = \'<span style="font-size:22px">✅</span> <span class="done">同期が完了しました！</span>\';' +
    '    document.getElementById("sub").innerHTML = \'<span class="small">スプレッドシートを再読み込みします...</span>\';' +
    '    setTimeout(function(){ google.script.run.closeSyncSidebar(); }, 1500);' +
    '  } else {' +
    '    var elapsed = pollCount * 15;' +
    '    var mins = Math.floor(elapsed / 60);' +
    '    var secs = elapsed % 60;' +
    '    document.getElementById("sub").textContent = "経過 " + (mins > 0 ? mins + "分" : "") + secs + "秒 — 確認中...（最大5分）";' +
    '    setTimeout(poll, 15000);' +
    '  }' +
    '}' +
    'function onErr(e) {' +
    '  pollCount++;' +
    '  document.getElementById("sub").innerHTML = \'<span class="err">確認エラー: \' + e + \'</span>\';' +
    '  if (pollCount < MAX_POLLS) setTimeout(poll, 20000);' +
    '  else showTimeout();' +
    '}' +
    'function showTimeout() {' +
    '  document.getElementById("main").innerHTML = \'<span style="font-size:22px">⏱</span> <span class="err">タイムアウト（5分経過）</span>\';' +
    '  document.getElementById("sub").innerHTML = \'<span class="small">同期が完了していない可能性があります。<br>スプレッドシートを手動で再読み込みしてください。</span><br><button class="btn" onclick="google.script.host.close()">閉じる</button>\';' +
    '}' +
    'setTimeout(poll, 8000);' +
    '</script></body></html>';
}

/** サイドバーを閉じてシートをリロードする（HTML から google.script.run で呼ばれる） */
// 注意: google.script.run から呼ぶ関数は _ で終わってはいけない（プライベート扱いになる）
function closeSyncSidebar() {
  SpreadsheetApp.getUi().showSidebar(
    HtmlService.createHtmlOutput(
      '<script>google.script.host.close();</script>'
    ).setTitle('').setWidth(1)
  );
}

/**
 * 【一時診断用】GASエディタから直接実行してDBの状態を確認する
 * 確認後に削除して構わない
 */
function runDbDiagnostic() {
  var creds = getSyncCredentials_();
  var response = UrlFetchApp.fetch(
    creds.url,
    makeSyncFetchRequest_(creds.url, creds.secret, { db_diagnostic: true })
  );
  var result = JSON.parse(response.getContentText());

  // 手動入力テーブルの状況
  var manual = result.manual_month_gross || {};
  var msg = '■ line_sales_manual_month_gross\n';
  msg += '  件数: ' + (manual.total_rows || 0) + '\n';
  if (manual.earliest) msg += '  範囲: ' + manual.earliest + ' 〜 ' + manual.latest + '\n';
  msg += '\n■ レシートテーブル（データあり店舗のみ）\n';

  var tables = result.receipt_tables || {};
  var hasData = false;
  for (var key in tables) {
    var t = tables[key];
    if (t.total_rows > 0) {
      hasData = true;
      msg += '  ' + key + ': ' + t.total_rows + '件 (' + t.earliest + '〜' + t.latest + ')\n';
    }
  }
  if (!hasData) msg += '  （全テーブル 0件）\n';

  Logger.log(msg);
  SpreadsheetApp.getUi().alert('DB診断結果', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

function syncContinue() {
  var st = getSyncResumeState_();
  if (!st) {
    SpreadsheetApp.getUi().alert('続きの同期はありません。\n先に「全店舗 〜 同期」を実行してください。');
    return;
  }
  runSyncAllStores_(st.direction, { resume: true });
}

function getSyncResumeState_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(SYNC_RESUME_INDEX_KEY);
  var idx = parseInt(String(raw == null ? '' : raw), 10);
  var direction = String(props.getProperty(SYNC_RESUME_DIRECTION_KEY) || '').trim();
  if (!direction || isNaN(idx) || idx < 0 || idx >= STORE_CATALOG.length) return null;
  return { index: idx, direction: direction };
}

function setSyncResumeState_(direction, nextIndex) {
  var props = PropertiesService.getScriptProperties();
  if (nextIndex >= STORE_CATALOG.length) {
    props.deleteProperty(SYNC_RESUME_INDEX_KEY);
    props.deleteProperty(SYNC_RESUME_DIRECTION_KEY);
    return;
  }
  props.setProperty(SYNC_RESUME_DIRECTION_KEY, String(direction));
  props.setProperty(SYNC_RESUME_INDEX_KEY, String(nextIndex));
}

function clearSyncResumeState_() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(SYNC_RESUME_INDEX_KEY);
  props.deleteProperty(SYNC_RESUME_DIRECTION_KEY);
}

function getConfigSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var i = 0; i < TAB_CONFIG.length; i++) {
    var sh = ss.getSheetByName(TAB_CONFIG[i]);
    if (sh) return sh;
  }
  return null;
}

/**
 * スクリプトプロパティ → なければ「設定」タブ B1/B2（CLI で hocbn から書込可）
 * @return {{url: string, secret: string}}
 */
function getSyncCredentials_() {
  var props = PropertiesService.getScriptProperties();
  var url = String(props.getProperty('SUPABASE_RECEIPT_SHEETS_SYNC_URL') || '').trim();
  var secret = String(props.getProperty('RECEIPT_SHEETS_SYNC_SECRET') || '').trim();
  var sheet = getConfigSheet_();
  if (sheet) {
    if (!url) url = String(sheet.getRange('B2').getValue() || '').trim();
    if (!secret) secret = String(sheet.getRange('B3').getValue() || '').trim();
    if (!secret) secret = readConfigValueByLabel_(sheet, 'RECEIPT_SHEETS_SYNC_SECRET');
    if (!url) url = readConfigValueByLabel_(sheet, 'SUPABASE_RECEIPT_SHEETS_SYNC_URL');
  }
  if (!url) url = SYNC.URL;
  return { url: url, secret: secret };
}

/** 「設定」タブ A列ラベルに対応する B列の値 */
function readConfigValueByLabel_(sheet, label) {
  var want = String(label || '').trim().toUpperCase();
  if (!want || !sheet) return '';
  var last = Math.min(sheet.getLastRow(), 20);
  if (last < 1) return '';
  var rows = sheet.getRange(1, 1, last, 2).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim().toUpperCase().indexOf(want) >= 0) {
      return String(rows[i][1] || '').trim();
    }
  }
  return '';
}

/** 「設定」タブを用意（B2=URL, B3=Secret） */
function ensureConfigSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getConfigSheet_();
  if (!sh) sh = ss.insertSheet('設定', 1);
  var header = sh.getRange('A1').getValue();
  if (!header) {
    sh.getRange('A1:B4').setValues([
      ['項目', '値（GAS が同期時に参照）'],
      ['SUPABASE_RECEIPT_SHEETS_SYNC_URL', SYNC.URL],
      ['RECEIPT_SHEETS_SYNC_SECRET', ''],
      ['更新日時', ''],
    ]);
    sh.setColumnWidth(1, 280);
    sh.setColumnWidth(2, 420);
  } else if (!String(sh.getRange('B2').getValue() || '').trim()) {
    sh.getRange('B2').setValue(SYNC.URL);
  }
  return sh;
}

/** メニュー: 設定タブ作成 + Secret 入力 → スクリプトプロパティにも保存 */
/**
 * CLI: clasp run cliSetSyncProperties -p '["https://.../receipt-sheets-sync-cron","SECRET"]'
 * @param {string} url
 * @param {string} secret
 */
function cliSetSyncProperties(url, secret) {
  var u = String(url || SYNC.URL).trim();
  var s = String(secret || '').trim();
  if (!s) throw new Error('RECEIPT_SHEETS_SYNC_SECRET is required');
  PropertiesService.getScriptProperties()
    .setProperty('SUPABASE_RECEIPT_SHEETS_SYNC_URL', u)
    .setProperty('RECEIPT_SHEETS_SYNC_SECRET', s);
  var sh = ensureConfigSheet_();
  sh.getRange('B2').setValue(u);
  sh.getRange('B3').setValue(s);
  sh.getRange('B4').setValue(new Date().toISOString());
  return { ok: true, url: u, secretSet: true };
}

function setupConfigSheetWizard() {
  var sh = ensureConfigSheet_();
  sh.getRange('B2').setValue(SYNC.URL);
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt(
    'RECEIPT_SHEETS_SYNC_SECRET',
    'hocbn の Edge Secret「RECEIPT_SHEETS_SYNC_SECRET」を貼り付けて OK。\n' +
      '（Supabase ダッシュボード → Edge Functions → Secrets）\n\n' +
      'ターミナルで取得する場合:\n' +
      '  ./scripts/setup-gas-sync-config.sh',
    ui.ButtonSet.OK_CANCEL,
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var secret = String(resp.getResponseText() || '').trim();
  if (!secret) {
    ui.alert('Secret が空のため保存しませんでした。\n「設定」タブの B3 に直接貼っても構いません。');
    sh.activate();
    sh.getRange('B3').activate();
    return;
  }
  sh.getRange('B3').setValue(secret);
  sh.getRange('B4').setValue(new Date().toISOString());
  var props = PropertiesService.getScriptProperties();
  props.setProperty('RECEIPT_SHEETS_SYNC_SECRET', secret);
  props.setProperty('SUPABASE_RECEIPT_SHEETS_SYNC_URL', SYNC.URL);
  applySyncConfigFromSheet();
}

function getSyncUrl_() {
  return getSyncCredentials_().url;
}

function getStoreEntry_(storeKey) {
  var raw = String(storeKey == null ? '' : storeKey).trim().replace(/[\s\u3000]+/g, '');
  if (!raw) return null;
  var lower = raw.toLowerCase();
  for (var i = 0; i < STORE_CATALOG.length; i++) {
    var k = STORE_CATALOG[i].key;
    if (k === raw || k.toLowerCase() === lower) return STORE_CATALOG[i];
  }
  return null;
}

function getStoreConfig_(storeKey) {
  var entry = getStoreEntry_(storeKey);
  if (!entry) throw new Error('未知の店舗キー: ' + storeKey);
  return {
    storeKey: entry.key,
    storeName: entry.name,
    syncUrl: getSyncUrl_(),
    siteLabel: SYNC.SITE_LABEL,
  };
}

function storeTabNames_(storeKey) {
  var entry = getStoreEntry_(storeKey);
  if (!entry) throw new Error('未知の店舗キー: ' + storeKey);
  var key = entry.key;
  return {
    budgets: [key + '_月間予算', key + '_monthly_budgets'],
    past: [key + '_過去売上', key + '_past_sales'],
    daily: [key + '_日次売上', key + '_daily_sales'],
  };
}

/** セル比較用（小文字） */
function normalizeStoreKeyCell_(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase().replace(/[\s\u3000]+/g, '');
}

/** 店舗キーがカタログ上の正式キーと同じか */
function storeKeysMatch_(cellKey, catalogKey) {
  return normalizeStoreKeyCell_(cellKey) === normalizeStoreKeyCell_(catalogKey);
}

function validateSyncConnection_(url, secret) {
  var issues = [];
  if (!url) issues.push('SUPABASE_RECEIPT_SHEETS_SYNC_URL が未設定です。\n既定: ' + SYNC.URL);
  else if (url.indexOf('hocbnifuactbvmyjraxy') < 0) {
    var legacy = false;
    for (var j = 0; j < SYNC.LEGACY_PROJECT_REFS.length; j++) {
      if (url.indexOf(SYNC.LEGACY_PROJECT_REFS[j]) >= 0) legacy = true;
    }
    if (legacy) issues.push('同期 URL が旧 jhpm を指しています。\n' + SYNC.URL);
    else if (url.indexOf('/receipt-sheets-sync-cron') < 0) issues.push('URL 末尾は receipt-sheets-sync-cron である必要があります。');
  }
  if (!secret) {
    issues.push(
      'RECEIPT_SHEETS_SYNC_SECRET が未設定です。\n' +
        '「設定」タブの B3 を確認するか、管理者が CLI で setup-gas-sync-config.sh を実行してください。',
    );
  }
  return issues;
}

function applySyncConfigFromSheet() {
  var c = getSyncCredentials_();
  var issues = validateSyncConnection_(c.url, c.secret);
  if (issues.length) {
    SpreadsheetApp.getUi().alert('接続できません\n\n' + issues.join('\n\n'));
    return;
  }
  SpreadsheetApp.getUi().alert(
    '接続設定を読み込みました。\n\nURL: ' + c.url + '\nSecret: 「設定」タブ B3 から取得',
  );
}

function getStoreBudgetSheet_(storeKey) {
  return findSheetByName_(storeTabNames_(storeKey).budgets);
}

function getStorePastSheet_(storeKey) {
  return findSheetByName_(storeTabNames_(storeKey).past);
}

function getStoreDailySheet_(storeKey) {
  return findSheetByName_(storeTabNames_(storeKey).daily);
}

function normalizeBudgetSheetForStore_(cfg) {
  var sheet = getStoreBudgetSheet_(cfg.storeKey);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var numRows = lastRow - 1;
  var values = sheet.getRange(2, 1, numRows, 10).getValues();
  var changed = false;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!rowHasContent_(row) || !normalizeMonthCell_(row[0])) continue;
    if (row[1] !== cfg.storeName) { row[1] = cfg.storeName; changed = true; }
    if (!storeKeysMatch_(row[2], cfg.storeKey)) { row[2] = cfg.storeKey; changed = true; }
  }
  if (changed) sheet.getRange(2, 1, numRows, 10).setValues(values);
}

function normalizePastSalesSheetForStore_(cfg) {
  var sheet = getStorePastSheet_(cfg.storeKey);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var numRows = lastRow - 1;
  var values = sheet.getRange(2, 1, numRows, 7).getValues();
  var changed = false;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!rowHasContent_(row) || !normalizeMonthCell_(row[0])) continue;
    if (!storeKeysMatch_(row[1], cfg.storeKey)) { row[1] = cfg.storeKey; changed = true; }
  }
  if (changed) sheet.getRange(2, 1, numRows, 7).setValues(values);
}

function prepareStoreSheetsForSync_(cfg) {
  upgradeMonthlyBudgetSheetLayout_(getStoreBudgetSheet_(cfg.storeKey));
  upgradePastSalesSheetLayout_(getStorePastSheet_(cfg.storeKey));
  normalizeBudgetSheetForStore_(cfg);
  normalizePastSalesSheetForStore_(cfg);
  fillMonthlyBudgetOperatingDays_(getStoreBudgetSheet_(cfg.storeKey));
}

function readStoreBudgetRows_(cfg) {
  return readSheetDataFromSheet_(getStoreBudgetSheet_(cfg.storeKey), 2, 1, 500, 10);
}

function readStorePastSalesRows_(cfg) {
  return readSheetDataFromSheet_(getStorePastSheet_(cfg.storeKey), 2, 1, 500, 7, [2, 3, 4, 5]);
}

function readSheetDataFromSheet_(sheet, startRow, startCol, numRows, numCols, integerColumnIndexes) {
  var values = sheet.getRange(startRow, startCol, numRows, numCols).getValues();
  var intCols = integerColumnIndexes || null;
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (rowHasContent_(values[i])) out.push(serializeSheetRow_(values[i], intCols));
  }
  return out;
}

function storeHasSyncTabs_(storeKey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = storeTabNames_(storeKey);
  return !!(ss.getSheetByName(tabs.budgets[0]) || ss.getSheetByName(tabs.budgets[1]));
}

function runSyncAllStores_(direction, opts) {
  opts = opts || {};
  var silent = opts.silent === true;
  var startMs = Date.now();
  var startIndex = 0;
  if (opts.resume === true) {
    var st = getSyncResumeState_();
    if (!st) {
      if (!silent) SpreadsheetApp.getUi().alert('続きの同期はありません。');
      return { ok: false, message: 'no resume state' };
    }
    direction = st.direction;
    startIndex = st.index;
  } else {
    clearSyncResumeState_();
  }

  var creds = getSyncCredentials_();
  var connIssues = validateSyncConnection_(creds.url, creds.secret);
  if (connIssues.length) {
    if (!silent) SpreadsheetApp.getUi().alert(connIssues.join('\n\n'));
    return { ok: false, message: connIssues.join('\n\n') };
  }

  var failures = [];
  var skipped = [];
  var okCount = 0;
  var timedOut = false;
  var i = startIndex;

  while (i < STORE_CATALOG.length) {
    if (Date.now() - startMs > SYNC_TIME_BUDGET_MS) {
      setSyncResumeState_(direction, i);
      timedOut = true;
      break;
    }

    var jobs = [];
    while (jobs.length < SYNC_PARALLEL_BATCH && i < STORE_CATALOG.length) {
      var entry = STORE_CATALOG[i];
      i++;
      if (!storeHasSyncTabs_(entry.key)) {
        skipped.push(entry.name);
        setSyncResumeState_(direction, i);
        continue;
      }
      var built = buildStoreSyncPayload_(direction, entry.key, entry.name);
      if (built.error) {
        failures.push(entry.name + ': ' + built.error);
        setSyncResumeState_(direction, i);
        continue;
      }
      jobs.push(built);
    }

    if (jobs.length === 0) continue;

    var requests = [];
    for (var j = 0; j < jobs.length; j++) {
      requests.push(makeSyncFetchRequest_(creds.url, creds.secret, jobs[j].payload));
    }
    var responses = UrlFetchApp.fetchAll(requests);

    for (var k = 0; k < jobs.length; k++) {
      var applied = applyStoreSyncHttpResult_(jobs[k].cfg, responses[k]);
      if (applied.ok) okCount++;
      else failures.push(jobs[k].cfg.storeName + ': ' + applied.message);
      setSyncResumeState_(direction, jobs[k].catalogIndex + 1);
    }
  }

  if (!timedOut) {
    clearSyncResumeState_();
  }

  var doneThrough = timedOut ? Math.min(i, STORE_CATALOG.length) : STORE_CATALOG.length;
  var summary =
    '全店舗同期: 成功 ' +
    okCount +
    ' 店舗（' +
    doneThrough +
    ' / ' +
    STORE_CATALOG.length +
    ' まで処理・並列' +
    SYNC_PARALLEL_BATCH +
    '）';
  if (skipped.length) {
    summary += '\n\nタブ未作成でスキップ: ' + skipped.length + ' 店舗';
  }
  if (failures.length) summary += '\n\n失敗:\n' + failures.slice(0, 8).join('\n');
  if (timedOut) {
    summary += '\n\n⏱ 時間の都合で中断しました。「続きから全店舗同期」を実行してください。';
  }
  if (!silent) SpreadsheetApp.getUi().alert(summary);
  return { ok: failures.length === 0 && !timedOut, message: summary, timedOut: timedOut };
}

/**
 * @param {string} direction
 * @param {string} storeKey
 * @param {string} storeName
 * @return {{payload?: object, cfg?: object, catalogIndex?: number, error?: string}}
 */
function buildStoreSyncPayload_(direction, storeKey, storeName) {
  var catalogIndex = -1;
  for (var c = 0; c < STORE_CATALOG.length; c++) {
    if (STORE_CATALOG[c].key === storeKey) {
      catalogIndex = c;
      break;
    }
  }
  var cfg = getStoreConfig_(storeKey);
  cfg.storeName = storeName || cfg.storeName;
  if (!storeHasSyncTabs_(cfg.storeKey)) {
    return { error: 'タブがありません', catalogIndex: catalogIndex };
  }
  try {
    prepareStoreSheetsForSync_(cfg);
  } catch (e) {
    return { error: 'シート準備失敗 — ' + String(e), catalogIndex: catalogIndex };
  }
  var payload = {
    direction: direction,
    via_gas: true,
    store_partition_key: cfg.storeKey,
    store_display_name: cfg.storeName,
  };
  if (direction === 'pull' || direction === 'both') {
    payload.monthly_budget_rows = readStoreBudgetRows_(cfg);
    payload.past_sales_rows = readStorePastSalesRows_(cfg);
  } else if (direction === 'push') {
    payload.monthly_budget_rows = readStoreBudgetRows_(cfg);
    payload.past_sales_rows = readStorePastSalesRows_(cfg);
  }
  return { payload: payload, cfg: cfg, catalogIndex: catalogIndex };
}

function makeSyncFetchRequest_(url, secret, payload) {
  return {
    url: url,
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + secret,
      'x-receipt-sheets-sync-key': secret,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
}

/**
 * @param {object} cfg
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} response
 * @return {{ok: boolean, message: string}}
 */
function applyStoreSyncHttpResult_(cfg, response) {
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code < 200 || code >= 300) {
    return { ok: false, message: '同期失敗 (' + code + ') ' + text.slice(0, 400) };
  }
  var result;
  try {
    result = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: '応答解析失敗' };
  }
  if (result && result.skipped === true) {
    return { ok: false, message: String(result.reason || result.hint || 'skipped').slice(0, 400) };
  }
  try {
    if (result.sheet_export) {
      applySheetExport_(result.sheet_export, result.store_partition_key || cfg.storeKey);
    }
    if (result.sync_log_row) appendSyncLogRow_(result.sync_log_row);
  } catch (e) {
    return { ok: false, message: 'シート書込失敗 — ' + String(e) };
  }
  return { ok: true, message: '完了' };
}

function showConnectionInfo() {
  var c = getSyncCredentials_();
  var props = PropertiesService.getScriptProperties();
  var propSecret = !!String(props.getProperty('RECEIPT_SHEETS_SYNC_SECRET') || '').trim();
  var sheetSecret = !!getConfigSheet_() && !!String(getConfigSheet_().getRange('B3').getValue() || '').trim();
  var issues = validateSyncConnection_(c.url, c.secret);
  var lines = [
    'サイト: ' + SYNC.SITE_LABEL,
    '対象: 全 ' + STORE_CATALOG.length + ' 店舗（店舗キー別タブ）',
    'タブ例: marugo_月間予算 / bistrocavacava_日次売上',
    '同期 URL: ' + c.url,
    'Secret（プロパティ）: ' + (propSecret ? 'あり' : 'なし'),
    'Secret（設定タブ B3）: ' + (sheetSecret ? 'あり' : 'なし'),
    '同期に使う Secret: ' + (c.secret ? 'OK' : '未設定'),
  ];
  if (issues.length) lines.push('', '⚠ 要確認:', issues.join('\n'));
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

function setupAllStoreSheets() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('店舗タブ一括作成', STORE_CATALOG.length + ' 店舗分のタブ（月間予算・過去売上・日次売上）を作成します。\n続行しますか？', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  setupOperationSheet_();
  ensureReadmeSheet_();
  ensureStoreIndexSheet_();
  ensureTableOfContentsSheet_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetWithHeader_(ss, TAB_LOG, ['同期日時', '方向', '店舗キー', '取込結果', '書出結果', 'メモ']);
  installBackToTocOnAllSheets_();
  var month = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
  for (var i = 0; i < STORE_CATALOG.length; i++) {
    setupStoreSheets_(STORE_CATALOG[i], month, ss);
  }
  if (!hasOperationSheetTrigger_()) installOperationSheetTriggerSilent_();
  if (!hasStoreIndexTrigger_()) installStoreIndexTriggerSilent_();
  ensureTableOfContentsSheet_();
  ui.alert('店舗タブを作成しました（' + STORE_CATALOG.length + ' 店舗）。\n「目次」タブから各店舗へ移動できます。');
}

/** メニュー: 目次シートを再構築（タブ追加後に実行） */
function setupTableOfContents() {
  ensureTableOfContentsSheet_();
  SpreadsheetApp.getUi().alert('「目次」を更新しました。\nリンクをクリックすると該当タブへ移動します。');
}

function escapeSheetLinkLabel_(text) {
  return String(text || '').replace(/"/g, '""');
}

/** シートへ飛ぶ HYPERLINK 数式（未作成ならプレーンテキスト） */
function sheetNavLinkFormula_(ss, tabName, shortLabel) {
  var sh = ss.getSheetByName(tabName);
  var label = shortLabel || tabName;
  if (!sh) return tabName + '（未作成）';
  return '=HYPERLINK("#gid=' + sh.getSheetId() + '";"' + escapeSheetLinkLabel_(label) + '")';
}

function moveSheetToFirst_(sheet) {
  if (!sheet) return;
  var ss = sheet.getParent();
  ss.setActiveSheet(sheet);
  ss.moveActiveSheet(0);
}

function isTocSheetName_(name) {
  var n = String(name || '').trim();
  for (var i = 0; i < TAB_TOC.length; i++) {
    if (n === TAB_TOC[i]) return true;
  }
  return false;
}

function getTocSheet_(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  for (var i = 0; i < TAB_TOC.length; i++) {
    var sh = ss.getSheetByName(TAB_TOC[i]);
    if (sh) return sh;
  }
  return null;
}

/** 1行目 L列に「目次に戻る」リンク（ボタン風） */
function installBackToTocButton_(sheet) {
  if (!sheet || isTocSheetName_(sheet.getName())) return;
  var toc = getTocSheet_(sheet.getParent());
  var cell = sheet.getRange(1, BACK_TO_TOC_COL);
  if (toc) {
    cell.setFormula('=HYPERLINK("#gid=' + toc.getSheetId() + '";"← 目次に戻る")');
  } else {
    cell.setValue('← 目次');
  }
  cell
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#1a73e8')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setColumnWidth(BACK_TO_TOC_COL, 118);
  try {
    sheet.setRowHeight(1, 32);
  } catch (e) {
    Logger.log('setRowHeight: ' + e);
  }
}

/** 目次以外の全タブに戻るボタンを設置 */
function installBackToTocOnAllSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTableOfContentsSheet_();
  var sheets = ss.getSheets();
  var count = 0;
  for (var i = 0; i < sheets.length; i++) {
    if (isTocSheetName_(sheets[i].getName())) continue;
    installBackToTocButton_(sheets[i]);
    count++;
  }
  SpreadsheetApp.getUi().alert(
    '「← 目次に戻る」を ' + count + ' シートの1行目（L列）に設置しました。\nクリックで目次タブへ移動します。',
  );
}

function installBackToTocOnAllSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!getTocSheet_(ss)) return;
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (!isTocSheetName_(sheets[i].getName())) {
      installBackToTocButton_(sheets[i]);
    }
  }
}

/**
 * 目次シート: 共通タブ＋全店舗の月間予算／過去売上／日次売上へのリンク
 */
function ensureTableOfContentsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = null;
  for (var i = 0; i < TAB_TOC.length; i++) {
    sheet = ss.getSheetByName(TAB_TOC[i]);
    if (sheet) break;
  }
  if (!sheet) sheet = ss.insertSheet(TAB_TOC[0]);

  var rows = [];
  rows.push(['全店舗売上連携 — 目次', '', '', '', '', '']);
  rows.push(['', '', '', '', '', '']);
  rows.push(['■ 共通', 'リンク', '', '', '', '']);
  rows.push([
    '操作（スマホ同期）',
    sheetNavLinkFormula_(ss, '操作', '操作'),
    '',
    '',
    '',
    '',
  ]);
  rows.push(['使い方', sheetNavLinkFormula_(ss, '使い方', '使い方'), '', '', '', '']);
  rows.push([
    '店舗一覧（1店舗ずつ同期）',
    sheetNavLinkFormula_(ss, '店舗一覧', '店舗一覧'),
    '',
    '',
    '',
    '',
  ]);
  rows.push(['同期ログ', sheetNavLinkFormula_(ss, '同期ログ', '同期ログ'), '', '', '', '']);
  rows.push(['', '', '', '', '', '']);
  rows.push(['■ 店舗別（クリックでタブへ）', '月間予算', '過去売上', '日次売上', '店舗キー', '']);
  rows.push(['#', '店舗名', '月間予算 →', '過去売上 →', '日次売上 →', '店舗キー']);

  for (var j = 0; j < STORE_CATALOG.length; j++) {
    var e = STORE_CATALOG[j];
    var t = storeTabNames_(e.key);
    rows.push([
      j + 1,
      e.name,
      sheetNavLinkFormula_(ss, t.budgets[0], '月間予算'),
      sheetNavLinkFormula_(ss, t.past[0], '過去売上'),
      sheetNavLinkFormula_(ss, t.daily[0], '日次売上'),
      e.key,
    ]);
  }

  sheet.clear();
  var numRows = rows.length;
  var numCols = rows[0].length;
  sheet.getRange(1, 1, numRows, numCols).setValues(rows);

  sheet.getRange(1, 1, 1, numCols).merge();
  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
  sheet.getRange(3, 1, 1, numCols).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.getRange(9, 1, 1, numCols).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.getRange(10, 1, 1, numCols).setFontWeight('bold').setBackground('#f1f3f4');

  var linkCols = [2, 3, 4, 5];
  for (var r = 4; r <= 7; r++) {
    sheet.getRange(r, 2).setFontColor('#1a73e8');
  }
  for (var ri = 11; ri <= numRows; ri++) {
    for (var ci = 0; ci < linkCols.length; ci++) {
      sheet.getRange(ri, linkCols[ci]).setFontColor('#1a73e8');
    }
  }

  sheet.setColumnWidth(1, 36);
  sheet.setColumnWidth(2, 200);
  sheet.setColumnWidth(3, 100);
  sheet.setColumnWidth(4, 100);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 120);
  sheet.setFrozenRows(10);

  moveSheetToFirst_(sheet);
  installBackToTocOnAllSheets_();
}

function setupStoreSheets_(entry, month, ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var tabs = storeTabNames_(entry.key);
  var budget = ensureSheetWithHeader_(ss, tabs.budgets, ['対象月', '店舗名', '店舗キー', '月間予算円', '平日比率', '休日前比率', '休日比率', '休業日', '営業日数', '有効']);
  var past = ensureSheetWithHeader_(ss, tabs.past, ['対象月', '店舗キー', '総売上円', '会計組数', '客数', '営業日数', '有効']);
  var daily = ensureSheetWithHeader_(ss, tabs.daily, ['日付', '店舗キー', '店舗名', '総売上', '組数', '客数', '日別予算', '差額', 'レシート件数', '更新日時']);
  if (budget.getLastRow() < 2) {
    budget.getRange(2, 1, 1, 10).setValues([[month, entry.name, entry.key, '', 1, 1.5, 2, '', '', true]]);
  }
  if (past.getLastRow() < 2) {
    past.getRange(2, 1, 1, 7).setValues([['', entry.key, '', '', '', '', true]]);
  }
  styleClosedDatesColumn_(budget);
  installBackToTocButton_(budget);
  installBackToTocButton_(past);
  installBackToTocButton_(daily);
}

function migrateLegacyTabs() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('旧タブ移行', '旧形式（月間予算・過去売上・日次売上）の内容を bistrocavacava_* タブへコピーします。\n続行しますか？', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var entry = getStoreEntry_('bistrocavacava');
  setupStoreSheets_(entry, Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM'), ss);
  copyLegacyTabIfExists_(LEGACY_TAB_BUDGETS, storeTabNames_('bistrocavacava').budgets[0]);
  copyLegacyTabIfExists_(LEGACY_TAB_PAST, storeTabNames_('bistrocavacava').past[0]);
  copyLegacyTabIfExists_(LEGACY_TAB_DAILY, storeTabNames_('bistrocavacava').daily[0]);
  ui.alert('移行完了: bistrocavacava_* タブを確認してください。');
}

function copyLegacyTabIfExists_(legacyNames, destName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = null;
  for (var i = 0; i < legacyNames.length; i++) { src = ss.getSheetByName(legacyNames[i]); if (src) break; }
  if (!src) return;
  var dest = ss.getSheetByName(destName);
  if (!dest) return;
  var lr = src.getLastRow();
  var lc = src.getLastColumn();
  if (lr < 1 || lc < 1) return;
  var data = src.getRange(1, 1, lr, lc).getValues();
  dest.clear();
  dest.getRange(1, 1, data.length, data[0].length).setValues(data);
}

function ensureStoreIndexSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = null;
  for (var i = 0; i < TAB_STORE_INDEX.length; i++) { sheet = ss.getSheetByName(TAB_STORE_INDEX[i]); if (sheet) break; }
  if (!sheet) sheet = ss.insertSheet(TAB_STORE_INDEX[0]);
  var rows = [['店舗名', '店舗キー', '同期', '状態', '月間予算タブ', '過去売上タブ', '日次売上タブ']];
  for (var j = 0; j < STORE_CATALOG.length; j++) {
    var e = STORE_CATALOG[j];
    var t = storeTabNames_(e.key);
    rows.push([e.name, e.key, false, '', t.budgets[0], t.past[0], t.daily[0]]);
  }
  sheet.clear();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.setFrozenRows(1);
  var cb = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(2, 3, STORE_CATALOG.length, 1).setDataValidation(cb);
  installBackToTocButton_(sheet);
}

function ensureSheetWithHeader_(ss, tabNames, headerRow) {
  var sheet = null;
  for (var i = 0; i < tabNames.length; i++) { sheet = ss.getSheetByName(tabNames[i]); if (sheet) break; }
  if (!sheet) sheet = ss.insertSheet(tabNames[0]);
  if (!String(sheet.getRange(1, 1).getValue() || '').trim()) {
    sheet.getRange(1, 1, 1, headerRow.length).setValues([headerRow]);
    sheet.getRange(1, 1, 1, headerRow.length).setFontWeight('bold');
  }
  installBackToTocButton_(sheet);
  return sheet;
}

function ensureReadmeSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = null;
  for (var i = 0; i < TAB_README.length; i++) { sheet = ss.getSheetByName(TAB_README[i]); if (sheet) break; }
  if (!sheet) sheet = ss.insertSheet(TAB_README[0]);
  var body = [
    ['項目', '内容'],
    ['対象', '全 ' + STORE_CATALOG.length + ' 店舗'],
    ['タブ命名', '{店舗キー}_月間予算 など'],
    ['Supabase', SYNC.SITE_LABEL],
    ['取込', '各店舗タブの予算・過去売上 → DB'],
    ['書出', '各店舗タブへ日次売上・休業日'],
    ['高速同期', '⚡ 約10秒で開始（サーバーが全店舗を処理）'],
    ['GAS同期', '最大6店舗並列＋続きから再開'],
    ['短時間化', '取込のみ/書出のみ、店舗一覧で1店舗ずつ'],
    ['1店舗同期', '店舗一覧タブ C列チェック'],
    ['タブ移動', '「目次」タブのリンクをクリック'],
    ['目次更新', 'メニュー「目次を更新」'],
    ['目次に戻る', '各シート1行目・L列の青ボタン'],
    ['接続設定', '「設定」タブ B2=URL, B3=Secret（CLI可）'],
    ['更新', '2026-05 全店舗対応版'],
  ];
  sheet.clear();
  sheet.getRange(1, 1, body.length, 2).setValues(body);
  sheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.setColumnWidth(1, 140);
  sheet.setColumnWidth(2, 520);
  sheet.setFrozenRows(1);
  installBackToTocButton_(sheet);
}

/**
 * @param {string} direction pull|push|both
 * @param {{silent?: boolean, storeKey?: string, storeName?: string}} opts
 * @return {{ok: boolean, message: string}}
 */
function runSyncViaGas_(direction, opts) {
  if (opts && opts.storeKey) return runSyncViaGasSingle_(direction, opts);
  return runSyncAllStores_(direction, opts);
}

function runSyncViaGasSingle_(direction, opts) {
  opts = opts || {};
  var silent = opts.silent === true;
  var out = { ok: false, message: '' };
  if (!opts.storeKey) {
    out.message = 'storeKey が指定されていません';
    if (!silent) SpreadsheetApp.getUi().alert(out.message);
    return out;
  }
  var creds = getSyncCredentials_();
  var connIssues = validateSyncConnection_(creds.url, creds.secret);
  if (connIssues.length) {
    out.message = connIssues.join('\n\n');
    if (!silent) SpreadsheetApp.getUi().alert(out.message);
    return out;
  }
  var cfg = getStoreConfig_(opts.storeKey);
  if (opts.storeName) cfg.storeName = String(opts.storeName);
  var built = buildStoreSyncPayload_(direction, cfg.storeKey, cfg.storeName);
  if (built.error) {
    out.message = cfg.storeName + ': ' + built.error;
    if (!silent) SpreadsheetApp.getUi().alert(out.message);
    return out;
  }
  var response = UrlFetchApp.fetch(
    creds.url,
    makeSyncFetchRequest_(creds.url, creds.secret, built.payload),
  );
  var applied = applyStoreSyncHttpResult_(built.cfg, response);
  out.ok = applied.ok;
  out.message = cfg.storeName + (applied.ok ? ' 同期完了' : ' — ' + applied.message);
  if (!silent) SpreadsheetApp.getUi().alert(out.message);
  return out;
}

/** 月間予算を A〜J（I=営業日数, J=有効）。取込時に自動実行。 */
function upgradeMonthlyBudgetSheetLayout_(sheet) {
  if (!sheet) throw new Error('月間予算シートがありません');
  var headerI = String(sheet.getRange(1, 9).getValue() || '').trim();
  var headerJ = String(sheet.getRange(1, 10).getValue() || '').trim();

  if (headerI === '営業日数' && headerJ === '有効') {
    return '月間予算タブはすでに10列形式です（I=営業日数, J=有効）。';
  }

  if (headerI === '有効') {
    sheet.insertColumnBefore(9);
    sheet.getRange(1, 9).setValue('営業日数');
    sheet.getRange(1, 10).setValue('有効');
    fillMonthlyBudgetOperatingDays_(sheet);
    normalizeAllClosedDatesCellsToSingleLine_(sheet);
    return (
      'I列に「営業日数」を追加しました。\n' +
      '「有効」は J列 に移っています。\n' +
      'H列の休業日から営業日数を自動計算して I列 に書き込みました。'
    );
  }

  sheet.getRange(1, 1, 1, 10).setValues([[
    '対象月',
    '店舗名',
    '店舗キー',
    '月間予算円',
    '平日比率',
    '休日前比率',
    '休日比率',
    '休業日',
    '営業日数',
    '有効',
  ]]);
  fillMonthlyBudgetOperatingDays_(sheet);
  normalizeAllClosedDatesCellsToSingleLine_(sheet);
  return '1行目のヘッダーを10列形式にしました。休業日から営業日数を自動計算します。';
}

/** H列の休業日を1行表記に揃える（既存の改行入りセルを修正） */
function normalizeAllClosedDatesCellsToSingleLine_(sheet) {
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var numRows = lastRow - 1;
  var range = sheet.getRange(2, 8, numRows, 1);
  var values = range.getValues();
  var changed = false;
  for (var i = 0; i < values.length; i++) {
    var normalized = normalizeClosedDatesCellText_(values[i][0]);
    if (normalized !== String(values[i][0] == null ? '' : values[i][0])) {
      values[i][0] = normalized;
      changed = true;
    }
  }
  if (changed) {
    range.setValues(values);
  }
  for (var r = 2; r <= lastRow; r++) {
    styleClosedDatesCell_(sheet.getRange(r, 8));
  }
}

/** H列（休業日）から I列（営業日数）を再計算 */
function fillMonthlyBudgetOperatingDays_(sheet) {
  if (!sheet) return;
  var headerI = String(sheet.getRange(1, 9).getValue() || '').trim();
  if (headerI !== '営業日数') return;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var numRows = lastRow - 1;
  var values = sheet.getRange(2, 1, numRows, 10).getValues();
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!rowHasContent_(row)) continue;
    var month = normalizeMonthCell_(row[0]);
    if (!month) continue;
    var opDays = countOperatingDaysFromClosedCell_(month, row[7]);
    row[8] = opDays > 0 ? opDays : '';
    row[7] = normalizeClosedDatesCellText_(row[7]);
  }
  sheet.getRange(2, 1, values.length, 10).setValues(values);
  normalizeAllClosedDatesCellsToSingleLine_(sheet);
}

function applyBudgetOperatingDaysUpdates_(updates, storePartitionKey) {
  var sheet = getStoreBudgetSheet_(storePartitionKey);
  for (var u = 0; u < updates.length; u++) {
    var item = updates[u];
    var row = Number(item.row);
    if (!row || row < 2) continue;
    sheet.getRange(row, 9).setValue(item.operating_days);
  }
}

function countOperatingDaysFromClosedCell_(month, closedRaw) {
  var closedDates = parseClosedDatesCellGas_(month, closedRaw);
  var monthDays = buildDateKeysForMonth_(month);
  return Math.max(0, monthDays.length - closedDates.length);
}

function buildDateKeysForMonth_(month) {
  var matched = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!matched) return [];
  var year = Number(matched[1]);
  var monthNum = Number(matched[2]);
  var lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  var keys = [];
  for (var day = 1; day <= lastDay; day++) {
    keys.push(
      String(year).padStart(4, '0') +
        '-' +
        String(monthNum).padStart(2, '0') +
        '-' +
        String(day).padStart(2, '0'),
    );
  }
  return keys;
}

function parseClosedDatesCellGas_(month, raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  var allowed = {};
  var monthDays = buildDateKeysForMonth_(month);
  for (var i = 0; i < monthDays.length; i++) {
    allowed[monthDays[i]] = true;
  }
  var monthNum = Number(month.slice(5, 7));
  var tokens = s
    .split(/[\n\r]+/)
    .reduce(function(acc, line) {
      return acc.concat(line.split(/[,、]+/));
    }, [])
    .map(function(p) {
      return String(p).trim();
    })
    .filter(function(p) {
      return p.length > 0;
    });
  var out = [];
  for (var t = 0; t < tokens.length; t++) {
    out = out.concat(expandClosedDateTokenGas_(tokens[t], month, monthNum, allowed));
  }
  var uniq = {};
  for (var j = 0; j < out.length; j++) {
    if (allowed[out[j]]) uniq[out[j]] = true;
  }
  return Object.keys(uniq).sort();
}

function expandClosedDateTokenGas_(token, month, monthNum, allowed) {
  var rangeFull = /^(\d{1,2})\/(\d{1,2})[〜~～\-－](\d{1,2})\/(\d{1,2})$/.exec(token);
  if (rangeFull) {
    var m1 = Number(rangeFull[1]);
    var d1 = Number(rangeFull[2]);
    var d2 = Number(rangeFull[4]);
    if (m1 === monthNum) return daysInRangeGas_(month, d1, d2, allowed);
    return [];
  }
  var rangeShort = /^(\d{1,2})\/(\d{1,2})[〜~～\-－](\d{1,2})$/.exec(token);
  if (rangeShort) {
    var m2 = Number(rangeShort[1]);
    var dStart = Number(rangeShort[2]);
    var dEnd = Number(rangeShort[3]);
    if (m2 === monthNum) return daysInRangeGas_(month, dStart, dEnd, allowed);
    return [];
  }
  var dayOnlyRange = /^(\d{1,2})[〜~～\-－](\d{1,2})$/.exec(token);
  if (dayOnlyRange) {
    return daysInRangeGas_(month, Number(dayOnlyRange[1]), Number(dayOnlyRange[2]), allowed);
  }

  var key = token;
  if (/^\d{1,2}\/\d{1,2}$/.test(token)) {
    var parts = token.split('/');
    var mRaw = Number(parts[0]);
    var dRaw = Number(parts[1]);
    if (mRaw === monthNum) {
      key = month + '-' + ('0' + dRaw).slice(-2);
    } else {
      key = month + '-' + ('0' + mRaw).slice(-2) + '-' + ('0' + dRaw).slice(-2);
    }
  } else if (/^\d{1,2}-\d{1,2}$/.test(token)) {
    key = month + '-' + ('0' + token.split('-')[1]).slice(-2);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(key) && allowed[key]) {
    return [key];
  }
  return [];
}

function daysInRangeGas_(month, startDay, endDay, allowed) {
  var from = Math.min(startDay, endDay);
  var to = Math.max(startDay, endDay);
  var out = [];
  for (var d = from; d <= to; d++) {
    var iso = month + '-' + ('0' + d).slice(-2);
    if (allowed[iso]) out.push(iso);
  }
  return out;
}

/** 過去売上を A〜G（F=営業日数, G=有効）。取込時に自動実行。 */
function upgradePastSalesSheetLayout_(sheet) {
  if (!sheet) throw new Error('過去売上シートがありません');
  var headerF = String(sheet.getRange(1, 6).getValue() || '').trim();
  var headerG = String(sheet.getRange(1, 7).getValue() || '').trim();

  if (headerF === '営業日数' && headerG === '有効') {
    return '過去売上タブはすでに7列形式です（F=営業日数, G=有効）。';
  }

  if (headerF === '有効') {
    sheet.insertColumnBefore(6);
    sheet.getRange(1, 6).setValue('営業日数');
    sheet.getRange(1, 7).setValue('有効');
    return (
      'F列に「営業日数」を追加しました。\n' +
      'もとの「有効」は G列 に移っています。\n\n' +
      '各月の F列にその月の営業日数（例: 20）を入力してから取込してください。'
    );
  }

  sheet
    .getRange(1, 1, 1, 7)
    .setValues([['対象月', '店舗キー', '総売上円', '会計組数', '客数', '営業日数', '有効']]);
  return '1行目のヘッダーを7列形式にしました。F列に営業日数、G列に有効（TRUE）を入力してください。';
}

function readSheetData_(tabNames, startRow, startCol, numRows, numCols, integerColumnIndexes) {
  var sheet = findSheetByName_(tabNames);
  var values = sheet.getRange(startRow, startCol, numRows, numCols).getValues();
  var intCols = integerColumnIndexes || null;
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (rowHasContent_(values[i])) {
      out.push(serializeSheetRow_(values[i], intCols));
    }
  }
  return out;
}

/** 全角数字・空白混在のセルを半角整数に（過去売上の組数・客数など） */
function normalizeSheetIntegerCell_(value) {
  if (value === null || value === '') return value;
  if (typeof value === 'number' && isFinite(value)) return Math.round(value);
  var s = String(value);
  s = s.replace(/[\uFF10-\uFF19]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30);
  });
  s = s.replace(/[\uFF0C\uFF0E\u3001\uFF0F，．、]/g, '');
  s = s.replace(/[\s\u3000\u00a0,]/g, '');
  if (s === '') return value;
  var n = Number(s);
  return isFinite(n) ? Math.round(n) : value;
}

function serializeSheetRowIndexUsesInteger_(colIndex, integerColumnIndexes) {
  if (!integerColumnIndexes || !integerColumnIndexes.length) return false;
  for (var i = 0; i < integerColumnIndexes.length; i++) {
    if (integerColumnIndexes[i] === colIndex) return true;
  }
  return false;
}

/** Date 型セルを yyyy-MM 文字列にしてサーバー側の月照合を安定させる */
function serializeSheetRow_(row, integerColumnIndexes) {
  var out = [];
  for (var c = 0; c < row.length; c++) {
    var cell = row[c];
    if (serializeSheetRowIndexUsesInteger_(c, integerColumnIndexes)) {
      cell = normalizeSheetIntegerCell_(cell);
    }
    out.push(serializeSheetCell_(cell, c === 0));
  }
  return out;
}

function serializeSheetCell_(value, isMonthColumn) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    if (isMonthColumn) {
      return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM');
    }
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return value;
}

function rowHasContent_(row) {
  for (var c = 0; c < row.length; c++) {
    if (row[c] !== '' && row[c] !== null) {
      return true;
    }
  }
  return false;
}

function applyBudgetRowUpdates_(updates, storePartitionKey) {
  if (!updates || !updates.length) return;
  var sheet = getStoreBudgetSheet_(storePartitionKey);
  upgradeMonthlyBudgetSheetLayout_(sheet);
  for (var u = 0; u < updates.length; u++) {
    var item = updates[u];
    var row = Number(item.row);
    if (!row || row < 2) continue;
    var values = item.values;
    if (!values || values.length < 10) continue;
    sheet.getRange(row, 1, 1, 10).setValues([values]);
  }
  styleClosedDatesColumn_(sheet);
  installBackToTocButton_(sheet);
}

function applyPastSalesUpdates_(updates, storePartitionKey) {
  if (!updates || !updates.length) return;
  var sheet = getStorePastSheet_(storePartitionKey);
  upgradePastSalesSheetLayout_(sheet);
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var scanRows = Math.max(lastRow - 1, 1);
  var existing = sheet.getRange(2, 1, scanRows, 7).getValues();
  var monthToRow = {};
  for (var i = 0; i < existing.length; i++) {
    var m = normalizeMonthCell_(existing[i][0]);
    if (m) monthToRow[m] = i + 2;
  }
  var storeKey = String(storePartitionKey || '').trim().toLowerCase();
  for (var u = 0; u < updates.length; u++) {
    var item = updates[u];
    var month = String(item.sales_month || '').trim();
    if (!month) continue;
    var row = Number(item.row);
    if (!row || row < 2) {
      row = monthToRow[month];
    }
    if (!row || row < 2) {
      row = Math.max(sheet.getLastRow(), 1) + 1;
      if (row < 2) row = 2;
      monthToRow[month] = row;
    }
    sheet.getRange(row, 1, 1, 7).setValues([[
      month,
      storeKey,
      item.gross_sales_yen,
      item.party_count != null ? item.party_count : '',
      item.guest_count != null ? item.guest_count : '',
      item.operating_days_count != null ? item.operating_days_count : '',
      item.from_receipt ? false : true,
    ]]);
  }
}

function applySheetExport_(sheetExport, storePartitionKey) {
  if (sheetExport.daily_sales) {
    var daily = sheetExport.daily_sales;
    var dailySheet = getStoreDailySheet_(storePartitionKey);
    var dailyData = [daily.header].concat(daily.rows);
    if (dailyData.length > 0 && dailyData[0].length > 0) {
      coerceDailySalesNumericColumnsInArray_(dailyData);
      dailySheet
        .getRange(1, 1, dailyData.length, dailyData[0].length)
        .setValues(dailyData);
      var numDataRows = dailyData.length - 1;
      if (numDataRows > 0) {
        paintNegativeCellsRed_(dailySheet, 2, numDataRows, 4, 8);
        applyNegativeRedFormatting_(dailySheet, 2, Math.max(numDataRows, 499), 4, 8);
      }
      installBackToTocButton_(dailySheet);
    }
  }

  if (sheetExport.past_sales_updates && sheetExport.past_sales_updates.length > 0) {
    applyPastSalesUpdates_(sheetExport.past_sales_updates, storePartitionKey);
  }

  if (sheetExport.budget_row_updates && sheetExport.budget_row_updates.length > 0) {
    applyBudgetRowUpdates_(sheetExport.budget_row_updates, storePartitionKey);
  }

  if (sheetExport.budget_operating_days_updates && sheetExport.budget_operating_days_updates.length > 0) {
    applyBudgetOperatingDaysUpdates_(sheetExport.budget_operating_days_updates, storePartitionKey);
  }

  if (sheetExport.closed_dates_updates && sheetExport.closed_dates_updates.length > 0) {
    applyClosedDatesUpdates_(sheetExport.closed_dates_updates, storePartitionKey);
  }

  var closedByMonth = sheetExport.closed_dates_by_month || {};
  if (Object.keys(closedByMonth).length > 0) {
    applyClosedDatesToBudgetSheet_(closedByMonth, storePartitionKey);
  }

  if (
    (sheetExport.closed_dates_updates && sheetExport.closed_dates_updates.length > 0) ||
    Object.keys(closedByMonth).length > 0
  ) {
    fillMonthlyBudgetOperatingDays_(getStoreBudgetSheet_(storePartitionKey));
  }
}

/** 文字列の "-40000" などを数値に（条件付き書式・色付け用） */
function coerceSheetNumber_(value) {
  if (typeof value === 'number' && !isNaN(value)) {
    return value;
  }
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  var s = String(value).replace(/,/g, '').trim();
  if (s === '' || s === '-') {
    return null;
  }
  var n = Number(s);
  return isFinite(n) ? n : null;
}

/** 日次売上の数値列（D〜I）を数値型で書き込む */
var DAILY_SALES_NUMERIC_COL_INDEXES = [3, 4, 5, 6, 7, 8];

function coerceDailySalesNumericColumnsInArray_(dailyData) {
  for (var r = 1; r < dailyData.length; r++) {
    var row = dailyData[r];
    for (var i = 0; i < DAILY_SALES_NUMERIC_COL_INDEXES.length; i++) {
      var ci = DAILY_SALES_NUMERIC_COL_INDEXES[i];
      if (ci >= row.length) {
        continue;
      }
      var n = coerceSheetNumber_(row[ci]);
      if (n !== null) {
        row[ci] = n;
      }
    }
  }
}

function coerceDailySalesNumericColumnsInSheet_(sheet, startRow, endRow) {
  var numRows = endRow - startRow + 1;
  var numCols = DAILY_SALES_NUMERIC_COL_INDEXES.length;
  var startCol = DAILY_SALES_NUMERIC_COL_INDEXES[0] + 1;
  var range = sheet.getRange(startRow, startCol, numRows, numCols);
  var values = range.getValues();
  var changed = false;
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var n = coerceSheetNumber_(values[r][c]);
      if (n !== null && values[r][c] !== n) {
        values[r][c] = n;
        changed = true;
      }
    }
  }
  if (changed) {
    range.setValues(values);
  }
}

/** 書込直後にマイナスセルを赤文字（文字列のマイナスにも対応） */
function paintNegativeCellsRed_(sheet, startRow, numRows, startCol, endCol) {
  var numCols = endCol - startCol + 1;
  var range = sheet.getRange(startRow, startCol, numRows, numCols);
  var values = range.getValues();
  var colors = [];
  for (var r = 0; r < values.length; r++) {
    var rowColors = [];
    for (var c = 0; c < values[r].length; c++) {
      var n = coerceSheetNumber_(values[r][c]);
      rowColors.push(n !== null && n < 0 ? '#c62828' : '#000000');
    }
    colors.push(rowColors);
  }
  range.setFontColors(colors);
}

/**
 * 条件付き書式（数値・文字列どちらのマイナスも拾う）。書出のたびに差し替え。
 */
function applyNegativeRedFormatting_(sheet, startRow, numRows, startCol, endCol) {
  var numCols = endCol - startCol + 1;
  var range = sheet.getRange(startRow, startCol, numRows, numCols);
  var colLetter = columnToLetter_(startCol);
  var formula = '=' + colLetter + startRow + '<0';
  var rules = sheet.getConditionalFormatRules();
  var kept = [];
  for (var i = 0; i < rules.length; i++) {
    var cond = rules[i].getBooleanCondition();
    if (cond) {
      var type = cond.getCriteriaType();
      if (
        type === SpreadsheetApp.BooleanCriteria.NUMBER_LESS ||
        type === SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA
      ) {
        var rs = rules[i].getRanges();
        var onThisSheet = false;
        for (var j = 0; j < rs.length; j++) {
          if (rs[j].getSheet().getName() === sheet.getName()) {
            onThisSheet = true;
            break;
          }
        }
        if (onThisSheet) {
          continue;
        }
      }
    }
    kept.push(rules[i]);
  }
  kept.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(formula)
      .setFontColor('#c62828')
      .setRanges([range])
      .build(),
  );
  sheet.setConditionalFormatRules(kept);
}

function columnToLetter_(column) {
  var temp = '';
  var col = column;
  while (col > 0) {
    var mod = (col - 1) % 26;
    temp = String.fromCharCode(65 + mod) + temp;
    col = Math.floor((col - 1) / 26);
  }
  return temp;
}

function applyClosedDatesUpdates_(updates, storePartitionKey) {
  var sheet = getStoreBudgetSheet_(storePartitionKey);
  styleClosedDatesColumn_(sheet);
  for (var u = 0; u < updates.length; u++) {
    var item = updates[u];
    var row = Number(item.row);
    if (!row || row < 2) {
      continue;
    }
    var cell = sheet.getRange(row, 8);
    cell.setValue(normalizeClosedDatesCellText_(item.value || ''));
    styleClosedDatesCell_(cell);
  }
}

/** 休業日セル内の改行を「、」に置換して1行表示用に整える */
function normalizeClosedDatesCellText_(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\n\r]+/g, '、')
    .replace(/、+/g, '、')
    .replace(/^、|、$/g, '');
}

/** Edge と同形式: 5/3〜5/6、5/10（1行） */
function formatClosedDatesForSheetCellGas_(isoDates, month) {
  if (!isoDates || !isoDates.length) return '';
  var dayNums = [];
  for (var i = 0; i < isoDates.length; i++) {
    var iso = String(isoDates[i]);
    if (iso.indexOf(month + '-') !== 0) continue;
    var day = Number(iso.slice(8, 10));
    if (day >= 1 && day <= 31) dayNums.push(day);
  }
  if (!dayNums.length) return isoDates.join('、');
  var monthNum = Number(month.slice(5, 7));
  return compressClosedDaysToSegmentsGas_(dayNums, monthNum).join('、');
}

function compressClosedDaysToSegmentsGas_(days, monthNum) {
  var unique = days.slice().sort(function(a, b) {
    return a - b;
  });
  var seen = {};
  var deduped = [];
  for (var u = 0; u < unique.length; u++) {
    if (!seen[unique[u]]) {
      seen[unique[u]] = true;
      deduped.push(unique[u]);
    }
  }
  var segments = [];
  var start = deduped[0];
  var end = deduped[0];
  var fmt = function(day) {
    return monthNum + '/' + day;
  };
  for (var i = 1; i <= deduped.length; i++) {
    var d = deduped[i];
    if (i < deduped.length && d === end + 1) {
      end = d;
      continue;
    }
    segments.push(start === end ? fmt(start) : fmt(start) + '〜' + fmt(end));
    if (i < deduped.length) {
      start = d;
      end = d;
    }
  }
  return segments;
}

function styleClosedDatesColumn_(sheet) {
  if (sheet.getColumnWidth(8) < 120) {
    sheet.setColumnWidth(8, 148);
  }
}

function styleClosedDatesCell_(range) {
  range.setWrap(false);
  range.setVerticalAlignment('middle');
  range.setHorizontalAlignment('left');
}

function applyClosedDatesToBudgetSheet_(datesByMonth, storePartitionKey) {
  var sheet = getStoreBudgetSheet_(storePartitionKey);
  var values = sheet.getRange(2, 1, 500, 9).getValues();
  var pilotKey = String(storePartitionKey || '')
    .trim()
    .toLowerCase();

  for (var i = 0; i < values.length; i++) {
    var month = normalizeMonthCell_(values[i][0]);
    var storeKey = String(values[i][2] || '')
      .trim()
      .toLowerCase();
    if (!month || storeKey !== pilotKey) {
      continue;
    }
    if (!datesByMonth.hasOwnProperty(month)) {
      continue;
    }
    var closed = datesByMonth[month] || [];
    var cellRange = sheet.getRange(i + 2, 8);
    cellRange.setValue(closed.length > 0 ? formatClosedDatesForSheetCellGas_(closed, month) : '');
    styleClosedDatesCell_(cellRange);
  }
  styleClosedDatesColumn_(sheet);
}

function appendSyncLogRow_(row) {
  var sheet = findSheetByName_(TAB_LOG);
  var header = sheet.getRange(1, 1, 1, 6).getValues()[0];
  if (!header[0] || String(header[0]).trim() === '') {
    sheet
      .getRange(1, 1, 1, 6)
      .setValues([['同期日時', '方向', '店舗キー', '取込結果', '書出結果', 'メモ']]);
  }
  sheet.appendRow(row);
}

/** 旧レイアウトや余分なチェックボックスがあれば直す */
function ensureOperationSheetCurrent_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('操作');
  if (!sheet) {
    setupOperationSheet_();
  } else if (isOperationSheetStale_(sheet)) {
    setupOperationSheet_();
  } else if (operationSheetHasExtraCheckboxes_(sheet)) {
    clearOperationSheetExtras_(sheet);
  } else {
    return;
  }
  if (!hasOperationSheetTrigger_()) {
    installOperationSheetTriggerSilent_();
  }
}

function isOperationSheetStale_(sheet) {
  if (!sheet) {
    return true;
  }
  var h3 = String(sheet.getRange(1, 3).getValue() || '').trim();
  var h4 = String(sheet.getRange(1, 4).getValue() || '').trim();
  if (h4 === '説明' || h3 !== '状態') {
    return true;
  }
  if (String(sheet.getRange(2, 1).getValue() || '').trim().indexOf('双方向') < 0) {
    return true;
  }
  if (String(sheet.getRange(4, 1).getValue() || '').trim() !== '書出のみ') {
    return true;
  }
  if (String(sheet.getRange(5, 1).getValue() || '').trim() !== '') {
    return true;
  }
  return false;
}

/** 5行目以降に残った旧チェックボックス（clear では消えない） */
function operationSheetHasExtraCheckboxes_(sheet) {
  if (!sheet || sheet.getMaxRows() < 5) {
    return false;
  }
  for (var r = 5; r <= Math.min(sheet.getLastRow() + 2, 30); r++) {
    var dv = sheet.getRange(r, 2).getDataValidation();
    if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX) {
      return true;
    }
  }
  return false;
}

function clearOperationSheetExtras_(sheet) {
  var maxR = sheet.getMaxRows();
  if (maxR <= 4) {
    return;
  }
  var numRows = maxR - 4;
  var cols = Math.min(sheet.getMaxColumns(), 12);
  var extra = sheet.getRange(5, 1, numRows, cols);
  extra.clearContent();
  extra.clearFormat();
  extra.clearDataValidations();
}

/** 「操作」タブ：スマホアプリからチェックを入れて同期（PCメニューと同じ処理） */
function setupOperationSheet() {
  try {
    var msg = setupOperationSheet_();
    if (!hasOperationSheetTrigger_()) {
      installOperationSheetTriggerSilent_();
    }
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    SpreadsheetApp.getUi().alert('操作シートの作成に失敗しました:\n\n' + String(e));
  }
}

function setupOperationSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('操作');
  if (!sheet) {
    sheet = ss.insertSheet('操作', 0);
  } else {
    ss.setActiveSheet(sheet);
  }

  sheet.clear();
  clearOperationSheetExtras_(sheet);
  sheet.getRange(1, 1, 1, 3).setValues([['操作', '実行', '状態']]);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');

  var rows = [
    ['全店舗 双方向同期', false, ''],
    ['全店舗 取込のみ', false, ''],
    ['全店舗 書出のみ', false, ''],
  ];
  var dataRows = rows.length;
  sheet.getRange(2, 1, dataRows, 3).setValues(rows);

  var cb = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(2, 2, dataRows, 1).setDataValidation(cb);

  clearOperationSheetExtras_(sheet);

  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 56);
  sheet.setColumnWidth(3, 80);
  sheet.setFrozenRows(1);
  installBackToTocButton_(sheet);

  return (
    '「操作」シートを更新しました。B列のチェックで同期できます。\n' +
    '対象: ' +
'全店舗（' + SYNC.SITE_LABEL + '）'
  );
}

function isOperationSheet_(name) {
  var n = String(name || '').trim();
  for (var i = 0; i < TAB_OPS.length; i++) {
    if (n === TAB_OPS[i]) return true;
  }
  return false;
}

function hasOperationSheetTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'handleOperationSheetEdit') return true;
  }
  return false;
}

function installOperationSheetTriggerSilent_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'handleOperationSheetEdit') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('handleOperationSheetEdit').forSpreadsheet(ss).onEdit().create();
}

/** インストール型 onEdit（操作シートの B2:B4 チェック） */
function handleOperationSheetEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (!isOperationSheet_(sheet.getName())) return;
  if (e.range.getColumn() !== 2) return;
  var row = e.range.getRow();
  if (row < 2 || row > 4) return;
  if (e.value !== true && e.value !== 'TRUE') return;

  e.range.setValue(false);
  var statusCell = sheet.getRange(row, 3);
  statusCell.setValue('実行中…');
  SpreadsheetApp.flush();

  var result;
  try {
    result = runOperationSheetAction_(row);
  } catch (err) {
    result = { ok: false, message: String(err) };
  }

  statusCell.setValue(result.ok ? '完了' : result.message || 'エラー');
}

function runOperationSheetAction_(row) {
  if (row === 2) return runSyncViaGas_('both', { silent: true });
  if (row === 3) return runSyncViaGas_('pull', { silent: true });
  if (row === 4) return runSyncViaGas_('push', { silent: true });
  return { ok: false, message: '不明な操作行です' };
}


function hasStoreIndexTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'handleStoreIndexEdit') return true;
  }
  return false;
}

function installStoreIndexTriggerSilent_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'handleStoreIndexEdit') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('handleStoreIndexEdit').forSpreadsheet(ss).onEdit().create();
}

function isStoreIndexSheet_(name) {
  var n = String(name || '').trim();
  for (var i = 0; i < TAB_STORE_INDEX.length; i++) if (n === TAB_STORE_INDEX[i]) return true;
  return false;
}

function handleStoreIndexEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (!isStoreIndexSheet_(sheet.getName())) return;
  if (e.range.getColumn() !== 3) return;
  var row = e.range.getRow();
  if (row < 2 || row > STORE_CATALOG.length + 1) return;
  if (e.value !== true && e.value !== 'TRUE') return;
  e.range.setValue(false);
  var storeKey = String(sheet.getRange(row, 2).getValue() || '').trim();
  var storeName = String(sheet.getRange(row, 1).getValue() || '').trim();
  var statusCell = sheet.getRange(row, 4);
  statusCell.setValue('実行中…');
  SpreadsheetApp.flush();
  var result = runSyncViaGasSingle_('both', { silent: true, storeKey: storeKey, storeName: storeName });
  statusCell.setValue(result.ok ? '完了' : (result.message || 'エラー'));
}

function findSheetByName_(names) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var i = 0; i < names.length; i++) {
    var sh = ss.getSheetByName(names[i]);
    if (sh) {
      return sh;
    }
  }
  throw new Error('シートが見つかりません: ' + names.join(' / '));
}

function normalizeMonthCell_(raw) {
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return Utilities.formatDate(raw, 'Asia/Tokyo', 'yyyy-MM');
  }
  if (typeof raw === 'number' && raw > 20000 && raw < 120000) {
    var ms = Math.round((raw - 25569) * 86400 * 1000);
    var d = new Date(ms);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM');
    }
  }
  var s = String(raw || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    return s;
  }
  var isoDay = s.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (isoDay) {
    return isoDay[1] + '-' + isoDay[2];
  }
  var loose = s.match(/^(\d{4})[\/\-](\d{1,2})$/);
  if (loose) {
    var mo = Math.min(12, Math.max(1, parseInt(loose[2], 10)));
    return loose[1] + '-' + ('0' + mo).slice(-2);
  }
  return null;
}
function runPastSalesDiagnostic() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  
  // 診断対象の店舗キーをユーザーにポップアップで尋ねる
  var resp = ui.prompt(
    '過去売上データ診断',
    '診断したい店舗キーを入力してください（例: bistrocavacava, marugoyotsuya 等）:',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var storeKey = String(resp.getResponseText() || '').trim();
  if (!storeKey) {
    ui.alert('店舗キーが入力されなかったため、診断を中止します。');
    return;
  }
  
  var configSheet = ss.getSheetByName('設定');
  if (!configSheet) {
    ui.alert('「設定」タブが見つかりません。先に接続設定を行ってください。');
    return;
  }
  var syncUrl = configSheet.getRange('B2').getValue();
  var syncSecret = configSheet.getRange('B3').getValue();
  
  ui.alert('店舗「' + storeKey + '」のデータ状況をSupabaseから診断します（数秒かかります）...');
  
  try {
    var response = UrlFetchApp.fetch(syncUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-receipt-sheets-sync-key': String(syncSecret),
        'Authorization': 'Bearer ' + String(syncSecret)
      },
      payload: JSON.stringify({ past_sales_diagnostic: true, store_key: storeKey }),
      muteHttpExceptions: true
    });
    
    var text = response.getContentText();
    
    // 結果を「同期ログ」タブの A1 セルに書き出す
    var logSheet = ss.getSheetByName('同期ログ') || ss.insertSheet('同期ログ');
    logSheet.activate();
    logSheet.getRange('A1').setValue(
      '【過去売上診断結果 - 店舗: ' + storeKey + ' - 実行日時: ' + new Date().toLocaleString('ja-JP') + '】\n\n' + text
    );
    logSheet.getRange('A1').activate();
    
    ui.alert(
      '診断が完了しました！\n結果の全文を「同期ログ」タブの A1 セルに書き込みました。\n\n' +
      '【診断結果（先頭部分）】\n' + text.substring(0, 800)
    );
  } catch (e) {
    ui.alert('診断APIの呼び出しに失敗しました: ' + e);
  }
}
