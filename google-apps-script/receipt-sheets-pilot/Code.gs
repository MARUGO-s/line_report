/**
 * 全店舗スプレッドシート ↔ hocbn 同期（GAS）
 *
 * 通常の同期はサーバー（background_sync）が Sheets API で実行します。
 * GAS は開始リクエストと完了確認サイドバーのみ担当します。
 *
 * 設定: 「設定」タブ B2=URL, B3=Secret（またはスクリプトプロパティ）
 */

var SYNC = {
  URL: 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/receipt-sheets-sync-cron',
  SITE_LABEL: 'line_report（hocbn）',
  LEGACY_PROJECT_REFS: ['jhpmzqxqvapdkyvvhyra'],
  SPREADSHEET_ID: '1ykltznAplFvOsj_DCXPXla_6z_PrCxTthROlsUrr7Rs',
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
var TAB_CONFIG = ['設定', 'config'];

var SYNC_BG_STARTED_AT_KEY = 'SYNC_BG_STARTED_AT';
var SYNC_BG_ELAPSED_KEY = 'SYNC_BG_ELAPSED';
var CONFIG_SYNC_STARTED_AT_CELL = 'B5';
var CONFIG_SYNC_ELAPSED_CELL = 'B6';

var STORE_BUDGET_EDITABLE_COLS = 16;
var STORE_BUDGET_UPDATED_AT_COL = 17;
var STORE_PAST_EDITABLE_COLS = 8;
var STORE_PAST_UPDATED_AT_COL = 9;
var STORE_DAILY_EDITABLE_COLS = 9;
var STORE_DAILY_UPDATED_AT_COL = 10;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('売上連携')
    .addItem('⚡ 全店舗を同期', 'syncBothServerFast')
    .addItem('接続設定', 'setupConfigSheetWizard')
    .addToUi();
}

function onEdit(e) {
  try {
    touchStoreSyncRowUpdatedAt_(e);
  } catch (err) {
    Logger.log('touchStoreSyncRowUpdatedAt_: ' + err);
  }
}

/** 予算・過去売上タブを編集したら更新日時列を自動更新（双方向同期のマージ用） */
function touchStoreSyncRowUpdatedAt_(e) {
  if (!e || !e.range) return;
  var target = resolveStoreSyncUpdatedAtTarget_(e.range.getSheet().getName());
  if (!target) return;
  var startCol = e.range.getColumn();
  var endCol = startCol + e.range.getNumColumns() - 1;
  if (startCol > target.updatedAtCol) return;
  if (startCol === target.updatedAtCol && endCol === target.updatedAtCol) return;
  if (startCol > target.editableMaxCol) return;
  var stamp = new Date().toISOString();
  var sheet = e.range.getSheet();
  sheet.getRange(1, target.updatedAtCol).setValue(stamp);
  var startRow = Math.max(2, e.range.getRow());
  var endRow = e.range.getRow() + e.range.getNumRows() - 1;
  if (endRow < startRow) return;
  var values = [];
  for (var row = startRow; row <= endRow; row++) values.push([stamp]);
  sheet.getRange(startRow, target.updatedAtCol, values.length, 1).setValues(values);
}

function resolveStoreSyncUpdatedAtTarget_(sheetName) {
  var name = String(sheetName || '').trim();
  for (var i = 0; i < STORE_CATALOG.length; i++) {
    var tabs = storeTabNames_(STORE_CATALOG[i].key);
    if (name === tabs.budgets[0] || name === tabs.budgets[1]) {
      return { updatedAtCol: STORE_BUDGET_UPDATED_AT_COL, editableMaxCol: STORE_BUDGET_EDITABLE_COLS };
    }
    if (name === tabs.past[0] || name === tabs.past[1]) {
      return { updatedAtCol: STORE_PAST_UPDATED_AT_COL, editableMaxCol: STORE_PAST_EDITABLE_COLS };
    }
    if (name === tabs.daily[0] || name === tabs.daily[1]) {
      return { updatedAtCol: STORE_DAILY_UPDATED_AT_COL, editableMaxCol: STORE_DAILY_EDITABLE_COLS };
    }
  }
  if (isLegacyBudgetSheetName_(name)) {
    return { updatedAtCol: STORE_BUDGET_UPDATED_AT_COL, editableMaxCol: STORE_BUDGET_EDITABLE_COLS };
  }
  if (isLegacyPastSalesSheetName_(name)) {
    return { updatedAtCol: STORE_PAST_UPDATED_AT_COL, editableMaxCol: STORE_PAST_EDITABLE_COLS };
  }
  return null;
}

function isLegacyBudgetSheetName_(name) {
  for (var i = 0; i < LEGACY_TAB_BUDGETS.length; i++) {
    if (name === LEGACY_TAB_BUDGETS[i]) return true;
  }
  return false;
}

function isLegacyPastSalesSheetName_(name) {
  for (var i = 0; i < LEGACY_TAB_PAST.length; i++) {
    if (name === LEGACY_TAB_PAST[i]) return true;
  }
  return false;
}

function storeTabNames_(storeKey) {
  var key = String(storeKey || '').trim();
  return {
    budgets: [key + '_月間予算', key + '_monthly_budgets'],
    past: [key + '_過去売上', key + '_past_sales'],
    daily: [key + '_日次売上', key + '_daily_sales'],
  };
}

function syncBothServerFast() {
  triggerServerBackgroundSync_('both');
}

/**
 * タイムトリガー用（UI なし）
 * 時間主導型 → 日タイマー → 午前6時〜7時 など
 */
function dailyAutoSync() {
  var creds = getSyncCredentials_();
  try {
    var response = UrlFetchApp.fetch(
      creds.url,
      makeSyncFetchRequest_(creds.url, creds.secret, {
        direction: 'both',
        background_sync: true,
      }),
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
  setSyncBgPollingContext_(startedAt, elapsed);
  showSyncProgressSidebar_();
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

function getSpreadsheet_() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) return ss;
  } catch (e) {
    Logger.log('getActiveSpreadsheet: ' + e);
  }
  if (SYNC.SPREADSHEET_ID) {
    return SpreadsheetApp.openById(SYNC.SPREADSHEET_ID);
  }
  throw new Error('スプレッドシートを開けません');
}

function getConfigSheet_() {
  var ss = getSpreadsheet_();
  for (var i = 0; i < TAB_CONFIG.length; i++) {
    var sh = ss.getSheetByName(TAB_CONFIG[i]);
    if (sh) return sh;
  }
  return null;
}

function getSyncCredentials_() {
  var url = '';
  var secret = '';
  try {
    var props = PropertiesService.getScriptProperties();
    url = String(props.getProperty('SUPABASE_RECEIPT_SHEETS_SYNC_URL') || '').trim();
    secret = String(props.getProperty('RECEIPT_SHEETS_SYNC_SECRET') || '').trim();
  } catch (e) {
    Logger.log('getSyncCredentials_ properties: ' + e);
  }
  var sheet = getConfigSheet_();
  if (sheet) {
    if (!url) url = String(sheet.getRange('B2').getValue() || '').trim();
    if (!secret) secret = String(sheet.getRange('B3').getValue() || '').trim();
    if (!url) url = readConfigValueByLabel_(sheet, 'SUPABASE_RECEIPT_SHEETS_SYNC_URL');
    if (!secret) secret = readConfigValueByLabel_(sheet, 'RECEIPT_SHEETS_SYNC_SECRET');
  }
  if (!url) url = SYNC.URL;
  return { url: url, secret: secret };
}

function getSyncCredentialsFromSheetOnly_() {
  var url = SYNC.URL;
  var secret = '';
  var sheet = getConfigSheet_();
  if (sheet) {
    url = String(sheet.getRange('B2').getValue() || '').trim() || url;
    secret = String(sheet.getRange('B3').getValue() || '').trim();
    if (!secret) secret = readConfigValueByLabel_(sheet, 'RECEIPT_SHEETS_SYNC_SECRET');
    if (!url || url === SYNC.URL) {
      var fromLabel = readConfigValueByLabel_(sheet, 'SUPABASE_RECEIPT_SHEETS_SYNC_URL');
      if (fromLabel) url = fromLabel;
    }
  }
  return { url: url, secret: secret };
}

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

function ensureConfigSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getConfigSheet_();
  if (!sh) sh = ss.insertSheet('設定', 1);
  if (!String(sh.getRange('A1').getValue() || '').trim()) {
    sh.getRange('A1:B6').setValues([
      ['項目', '値'],
      ['SUPABASE_RECEIPT_SHEETS_SYNC_URL', SYNC.URL],
      ['RECEIPT_SHEETS_SYNC_SECRET', ''],
      ['更新日時', ''],
      ['同期開始時刻（完了確認）', ''],
      ['同期経過秒（完了確認）', ''],
    ]);
    sh.setColumnWidth(1, 280);
    sh.setColumnWidth(2, 420);
  } else if (!String(sh.getRange('B2').getValue() || '').trim()) {
    sh.getRange('B2').setValue(SYNC.URL);
  }
  return sh;
}

/** CLI: clasp run cliSetSyncProperties -p '["URL","SECRET"]' */
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
    '接続設定',
    'hocbn の RECEIPT_SHEETS_SYNC_SECRET を貼り付けて OK。\n' +
      '（Supabase → Edge Functions → Secrets）\n\n' +
      'ターミナル: ./scripts/setup-gas-sync-config.sh',
    ui.ButtonSet.OK_CANCEL,
  );
  if (resp.getSelectedButton() !== ui.Button.OK) {
    sh.activate();
    return;
  }
  var secret = String(resp.getResponseText() || '').trim();
  if (!secret) {
    ui.alert('Secret が空です。「設定」タブ B3 に直接貼っても構いません。');
    sh.getRange('B3').activate();
    return;
  }
  sh.getRange('B3').setValue(secret);
  sh.getRange('B4').setValue(new Date().toISOString());
  try {
    PropertiesService.getScriptProperties()
      .setProperty('RECEIPT_SHEETS_SYNC_SECRET', secret)
      .setProperty('SUPABASE_RECEIPT_SHEETS_SYNC_URL', SYNC.URL);
  } catch (e) {
    Logger.log('setupConfigSheetWizard properties: ' + e);
  }
  var issues = validateSyncConnection_(SYNC.URL, secret);
  if (issues.length) {
    ui.alert('保存しましたが要確認:\n\n' + issues.join('\n\n'));
  } else {
    ui.alert('接続設定を保存しました。\n「⚡ 全店舗を同期」が使えます。');
  }
}

function showConnectionInfo() {
  var c = getSyncCredentials_();
  var issues = validateSyncConnection_(c.url, c.secret);
  var lines = [
    'サイト: ' + SYNC.SITE_LABEL,
    '店舗数: ' + STORE_CATALOG.length,
    '同期 URL: ' + c.url,
    'Secret: ' + (c.secret ? '設定済み' : '未設定'),
  ];
  if (issues.length) lines.push('', '⚠', issues.join('\n'));
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

function validateSyncConnection_(url, secret) {
  var issues = [];
  if (!url) issues.push('同期 URL が未設定です。');
  else if (url.indexOf('hocbnifuactbvmyjraxy') < 0) {
    var legacy = false;
    for (var j = 0; j < SYNC.LEGACY_PROJECT_REFS.length; j++) {
      if (url.indexOf(SYNC.LEGACY_PROJECT_REFS[j]) >= 0) legacy = true;
    }
    if (legacy) issues.push('同期 URL が旧 jhpm を指しています。\n' + SYNC.URL);
    else if (url.indexOf('/receipt-sheets-sync-cron') < 0) {
      issues.push('URL 末尾は receipt-sheets-sync-cron である必要があります。');
    }
  }
  if (!secret) {
    issues.push('RECEIPT_SHEETS_SYNC_SECRET が未設定です（メニュー「接続設定」）。');
  }
  return issues;
}

function setSyncBgPollingContext_(startedAt, elapsed) {
  var sh = getConfigSheet_();
  if (sh) {
    sh.getRange(CONFIG_SYNC_STARTED_AT_CELL).setValue(startedAt);
    sh.getRange(CONFIG_SYNC_ELAPSED_CELL).setValue(elapsed);
  }
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty(SYNC_BG_STARTED_AT_KEY, startedAt);
    props.setProperty(SYNC_BG_ELAPSED_KEY, String(elapsed));
  } catch (e) {
    Logger.log('setSyncBgPollingContext_: ' + e);
  }
}

function getSyncBgPollingContextFromSheetOnly_() {
  var startedAt = '';
  var elapsed = 1;
  var sh = getConfigSheet_();
  if (sh) {
    startedAt = String(sh.getRange(CONFIG_SYNC_STARTED_AT_CELL).getValue() || '').trim();
    var elRaw = sh.getRange(CONFIG_SYNC_ELAPSED_CELL).getValue();
    if (elRaw !== '' && elRaw != null) {
      elapsed = parseInt(String(elRaw), 10) || 1;
    }
  }
  return { startedAt: startedAt, elapsed: isNaN(elapsed) || elapsed < 1 ? 1 : elapsed };
}

function showSyncProgressSidebar_() {
  var ctx = getSyncBgPollingContextFromSheetOnly_();
  var html = HtmlService.createHtmlOutput(buildSyncProgressHtml_(ctx.startedAt, ctx.elapsed))
    .setTitle('同期中...')
    .setWidth(320);
  SpreadsheetApp.getUi().showSidebar(html);
}

function checkSyncCompleteForSidebar(startedAtIso, elapsedSec) {
  var startedAt = String(startedAtIso || '').trim();
  var elapsed = parseInt(String(elapsedSec || '1'), 10);
  if (isNaN(elapsed) || elapsed < 1) elapsed = 1;
  var creds = getSyncCredentialsFromSheetOnly_();
  if (!creds.secret) {
    return {
      done: false,
      failed: false,
      errorMsg: '',
      error: '設定タブ B3 に Secret がありません',
      startedAt: startedAt,
      elapsed: elapsed,
    };
  }
  try {
    var response = UrlFetchApp.fetch(
      creds.url,
      makeSyncFetchRequest_(creds.url, creds.secret, { get_sync_status: true }),
    );
    var body = JSON.parse(response.getContentText());
    var lastCompleted = body.last_completed_at || '';
    var errorMsg = body.error_message || '';
    var isInProgress = errorMsg.indexOf('進行中') === 0;
    var done = lastCompleted && startedAt && lastCompleted > startedAt && !isInProgress;
    var failed = done && !!body.failed;
    return {
      done: !!done,
      failed: failed,
      errorMsg: errorMsg,
      lastCompleted: lastCompleted,
      startedAt: startedAt,
      elapsed: elapsed,
    };
  } catch (e) {
    return { done: false, failed: false, errorMsg: '', error: String(e), startedAt: startedAt, elapsed: elapsed };
  }
}

function escapeJsString_(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n');
}

function buildSyncProgressHtml_(startedAtIso, elapsedSec) {
  var startedAt = escapeJsString_(startedAtIso || '');
  var elapsed = parseInt(String(elapsedSec || '1'), 10);
  if (isNaN(elapsed) || elapsed < 1) elapsed = 1;
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<style>body{font-family:sans-serif;padding:16px;margin:0}' +
    '.spinner{display:inline-block;width:20px;height:20px;border:3px solid #ddd;' +
    'border-top-color:#4285f4;border-radius:50%;animation:spin 1s linear infinite;vertical-align:middle;margin-right:8px}' +
    '@keyframes spin{to{transform:rotate(360deg)}}' +
    '.done{color:#188038;font-weight:bold}.err{color:#c62828;font-size:13px}' +
    '.small{font-size:12px;color:#888;margin-top:6px}' +
    '.btn{margin-top:12px;padding:6px 14px;background:#4285f4;color:#fff;border:none;border-radius:4px;cursor:pointer}</style></head>' +
    '<body><div id="main"><span class="spinner"></span><span id="msg">同期中...</span></div>' +
    '<div class="small" id="sub">完了まで最大5分待機</div><script>' +
    'var pollCount=0,MAX_POLLS=20,SYNC_STARTED_AT=\'' + startedAt + '\',SYNC_ELAPSED=' + elapsed + ';' +
    'function poll(){if(pollCount>=MAX_POLLS){showTimeout();return;}' +
    'google.script.run.withSuccessHandler(onResult).withFailureHandler(onErr)' +
    '.checkSyncCompleteForSidebar(SYNC_STARTED_AT,SYNC_ELAPSED);}' +
    'function onResult(r){pollCount++;' +
    'if(r.done&&r.failed){document.getElementById("main").innerHTML=\'<span class="err">エラー</span>\';' +
    'document.getElementById("sub").textContent=r.errorMsg||"";}' +
    'else if(r.done){document.getElementById("main").innerHTML=\'<span class="done">完了</span>\';' +
    'setTimeout(function(){google.script.run.closeSyncSidebar();},1500);}' +
    'else{document.getElementById("sub").textContent="確認中... "+pollCount+"/"+MAX_POLLS;' +
    'setTimeout(poll,15000);}}' +
    'function onErr(e){pollCount++;if(pollCount<MAX_POLLS)setTimeout(poll,20000);else showTimeout();}' +
    'function showTimeout(){document.getElementById("main").innerHTML=\'<span class="err">タイムアウト</span>\';' +
    'document.getElementById("sub").textContent="再読み込みしてください";}' +
    'setTimeout(poll,8000);</script></body></html>';
}

function closeSyncSidebar() {
  SpreadsheetApp.getUi().showSidebar(
    HtmlService.createHtmlOutput('<script>google.script.host.close();</script>').setTitle('').setWidth(1),
  );
}
