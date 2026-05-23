/**
 * GitHub Pages 静的 UI 共通設定（line_report）
 *
 * API 方針:
 * - admin-api（管理）… jhpm（index / media / reservation）
 * - admin-api（売上分析）… hocbn（店舗別 line_receipt__* テーブル）
 * - line-webhook … 店舗ごとにパス分割（LINE Developers に登録する URL）
 */
(function (global) {
  'use strict';

  const PROJECT_URL = 'https://jhpmzqxqvapdkyvvhyra.supabase.co';
  /** LINE Webhook 受信先（新 DB・移行先） */
  const WEBHOOK_PROJECT_URL = 'https://hocbnifuactbvmyjraxy.supabase.co';
  /** 売上分析・予算 API（店舗別レシートテーブル） */
  const RECEIPT_ADMIN_PROJECT_URL = WEBHOOK_PROJECT_URL;

  /** Google スプレッドシート（売上シート pilot）連携 — 新サイトでは一旦オフ */
  const RECEIPT_SHEETS_PILOT_ENABLED = false;

  /** store_partition_key → 表示名（analytics / 管理画面で共通） */
  const STORE_NAMES = {
    marugo: 'マルゴ',
    marugosecond: 'マルゴ セカンド',
    marugogrande: 'マルゴ グランデ',
    sannanaichi: 'サンナナイチ バル',
    shenlong: 'シェンロン&クラウディア',
    claudia2: 'クラウディア2',
    sauvage: 'ソバージュ',
    barpelota: 'バルぺロタ',
    briccola: 'トラットリア ブリッコラ',
    violette: 'ヴィオレット',
    marugootto: 'マルゴ オット',
    donaiya: '元祖どないや 新宿三丁目店',
    marugoyotsuya: 'マルゴ 四谷',
    sushikoruri: '鮨こるり',
    bistrocavacava: 'BISTRO CAVA CAVA',
    marugoS: 'マルゴエス',
    marugoshinbashi: 'マルゴ 新橋',
    marugomarunouchi: 'マルゴ丸の内',
    yakinikumarugo: '焼肉マルゴ',
    erics: 'エリックスバイエリックトロション',
    mitan: 'ミタン',
    marugoD: 'マルゴ D',
  };

  function normalizeBaseUrl(base, fallback) {
    return String(base || fallback || PROJECT_URL).replace(/\/+$/, '');
  }

  function normalizeWebhookBaseUrl(base) {
    return normalizeBaseUrl(base, WEBHOOK_PROJECT_URL);
  }

  function adminApiPath(path) {
    const p = String(path || '');
    return '/functions/v1/admin-api' + (p.startsWith('/') ? p : '/' + p);
  }

  function adminApiUrl(path, base) {
    return normalizeBaseUrl(base) + adminApiPath(path);
  }

  /** analytics.html 向け（hocbn の admin-api） */
  function receiptAdminApiUrl(path) {
    return adminApiUrl(path, RECEIPT_ADMIN_PROJECT_URL);
  }

  /** 店舗別 LINE Webhook（新） */
  function lineWebhookPath(storeKey) {
    const key = String(storeKey || '').trim();
    if (!key) return '/functions/v1/line-webhook';
    return '/functions/v1/line-webhook/' + encodeURIComponent(key);
  }

  function lineWebhookUrl(storeKey, base) {
    return normalizeWebhookBaseUrl(base) + lineWebhookPath(storeKey);
  }

  /** 従来の共通 Webhook（移行期間用） */
  function lineWebhookLegacyUrl(base) {
    return normalizeWebhookBaseUrl(base) + '/functions/v1/line-webhook';
  }

  function normalizeStoreLabel(label) {
    return String(label || '').replace(/\s+/g, '');
  }

  /** store_key / store_name を canonical な slug（store_partition_key）に寄せる */
  function resolveStoreKey(rawKey, rawName) {
    const key = String(rawKey || '').trim();
    const name = String(rawName || '').trim();
    if (!key && !name) return '';

    if (key && STORE_NAMES[key]) return key;

    const candidates = [key, name].filter(Boolean);
    for (const candidate of candidates) {
      for (const [slug, label] of Object.entries(STORE_NAMES)) {
        if (candidate === slug || candidate === label) return slug;
        if (normalizeStoreLabel(candidate) === normalizeStoreLabel(label)) return slug;
      }
    }

    return key || name;
  }

  function resolveStoreName(storeKey, rawName) {
    const key = String(storeKey || '').trim();
    const name = String(rawName || '').trim();
    return name || STORE_NAMES[key] || key;
  }

  function webhookRawTableName(storeKey) {
    const key = String(storeKey || '').trim();
    if (!key) return '';
    return 'line_webhook_raw__' + key;
  }

  function receiptTableName(storeKey) {
    const key = String(storeKey || '').trim();
    if (!key) return '';
    return 'line_receipt__' + key;
  }

  function listStores(extraOptions) {
    const byKey = new Map();

    for (const [storeKey, storeName] of Object.entries(STORE_NAMES)) {
      byKey.set(storeKey, {
        store_key: storeKey,
        store_name: storeName,
        webhook_url: lineWebhookUrl(storeKey),
        webhook_raw_table: webhookRawTableName(storeKey),
        receipt_table: receiptTableName(storeKey),
      });
    }

    if (Array.isArray(extraOptions)) {
      for (const opt of extraOptions) {
        const canonicalKey = resolveStoreKey(
          opt?.store_key || opt?.store_partition_key,
          opt?.store_name,
        );
        if (!canonicalKey) continue;
        byKey.set(canonicalKey, {
          store_key: canonicalKey,
          store_name: resolveStoreName(canonicalKey, opt?.store_name),
          webhook_url: lineWebhookUrl(canonicalKey),
          webhook_raw_table: webhookRawTableName(canonicalKey),
          receipt_table: receiptTableName(canonicalKey),
        });
      }
    }

    return Array.from(byKey.values()).sort(function (a, b) {
      return a.store_name.localeCompare(b.store_name, 'ja');
    });
  }

  global.LINE_REPORT_PAGES = {
    PROJECT_URL: PROJECT_URL,
    WEBHOOK_PROJECT_URL: WEBHOOK_PROJECT_URL,
    RECEIPT_ADMIN_PROJECT_URL: RECEIPT_ADMIN_PROJECT_URL,
    RECEIPT_SHEETS_PILOT_ENABLED: RECEIPT_SHEETS_PILOT_ENABLED,
    STORE_NAMES: STORE_NAMES,
    adminApiPath: adminApiPath,
    adminApiUrl: adminApiUrl,
    receiptAdminApiUrl: receiptAdminApiUrl,
    lineWebhookPath: lineWebhookPath,
    lineWebhookUrl: lineWebhookUrl,
    lineWebhookLegacyUrl: lineWebhookLegacyUrl,
    webhookRawTableName: webhookRawTableName,
    receiptTableName: receiptTableName,
    listStores: listStores,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
