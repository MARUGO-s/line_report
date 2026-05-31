/**
 * GitHub Pages 静的 UI 共通設定（line_report）
 *
 * API 方針:
 * - admin-api（管理・メディア・予約表・Webhook設定）… hocbn（新サイト専用 DB）
 * - admin-api（Gmail 予約・連携確認・予約表）… hocbn（Gmail シークレットは jhpm から移行）
 * - line-webhook … 店舗ごとにパス分割（hocbn）
 */
(function (global) {
  'use strict';

  const PROJECT_URL = 'https://hocbnifuactbvmyjraxy.supabase.co';
  /** @deprecated Gmail も hocbn。互換のため jhpm URL を残す */
  const GMAIL_SHARED_PROJECT_URL = PROJECT_URL;
  /** LINE Webhook 受信先（新 DB） */
  const WEBHOOK_PROJECT_URL = PROJECT_URL;
  /** 売上分析・予算 API（店舗別レシートテーブル） */
  const RECEIPT_ADMIN_PROJECT_URL = PROJECT_URL;
  /** analytics から Edge Function を呼ぶ際の anon key（公開可） */
  const RECEIPT_ADMIN_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhvY2JuaWZ1YWN0YnZteWpyYXh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzQ2OTgsImV4cCI6MjA4Mjk1MDY5OH0.q33wfcASsQf0Fec3S6fa5CVG2KC9m5Q912Szu7KIyN0';

  /** Google スプレッドシート（売上シート）— 全店舗（店舗ごとタブ） */
  const RECEIPT_SHEETS_PILOT_ENABLED = true;

  /** @deprecated 単店舗時代の互換。全店舗対応後は参照のみ */
  const RECEIPT_SHEETS_PILOT_STORE_KEY = 'bistrocavacava';
  const RECEIPT_SHEETS_PILOT_STORE_NAME = 'BISTRO CAVA CAVA';

  /** hocbn admin-api 向け管理画面種別（旧 jhpm サイトとルーム一覧除外を分離） */
  const ADMIN_SURFACE = 'line_report';

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
    bistrocavacava: 'ビストロ サヴァサヴァ',
    marugoS: 'マルゴエス',
    marugoshinbashi: 'マルゴ 新橋',
    marugomarunouchi: 'マルゴ丸の内',
    yakinikumarugo: '焼肉マルゴ',
    erics: 'エリックスバイエリックトロション',
    mitan: 'ミタン',
    marugoD: 'マルゴ D',
  };

  /** 管理画面で店舗名として優先する表記（LINE グループ名と混同しやすい店舗） */
  const STORE_PREFERRED_UI_LABELS = {
    bistrocavacava: 'Bistro CAVACAVA',
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

  /** analytics / 売上 API（hocbn = PROJECT_URL と同一） */
  function receiptAdminApiUrl(path) {
    return adminApiUrl(path, RECEIPT_ADMIN_PROJECT_URL);
  }

  /** Gmail 予約登録のみ jhpm（旧本番）と共通 */
  function gmailSharedAdminApiUrl(path) {
    return adminApiUrl(path, GMAIL_SHARED_PROJECT_URL);
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

  /** 旧表記・別名 → canonical store_partition_key */
  const STORE_KEY_ALIASES = {
    bistrocavacava: ['BISTRO CAVA CAVA', 'BISTROCAVACAVA', 'CAVA CAVA'],
  };

  function normalizeStoreLabel(label) {
    // 空白除去・末尾の敬称（様/御中/行/宛）除去・小文字化で表記ゆれを吸収。
    // 例: "BISTRO CAVA CAVA 様" / "ビストロ サヴァサヴァ 御中" → どちらも bistrocavacava に解決。
    return String(label || '')
      .replace(/\s+/g, '')
      .replace(/(?:様|御中|行|宛)+$/u, '')
      .toLowerCase();
  }

  /** store_key / store_name を canonical な slug（store_partition_key）に寄せる */
  function resolveStoreKey(rawKey, rawName) {
    const key = String(rawKey || '').trim();
    const name = String(rawName || '').trim();
    if (!key && !name) return '';

    if (key && STORE_NAMES[key]) return key;
    if (key) {
      const keyLower = key.toLowerCase();
      for (const slug of Object.keys(STORE_NAMES)) {
        if (slug.toLowerCase() === keyLower) return slug;
      }
    }

    const candidates = [key, name].filter(Boolean);
    for (const candidate of candidates) {
      for (const [slug, aliasList] of Object.entries(STORE_KEY_ALIASES)) {
        if (aliasList.some(function (alias) {
          return normalizeStoreLabel(candidate) === normalizeStoreLabel(alias);
        })) {
          return slug;
        }
      }
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

  function getPreferredStoreDisplayLabel(storeKey) {
    const key = resolveStoreKey(storeKey, '');
    if (key && STORE_PREFERRED_UI_LABELS[key]) return STORE_PREFERRED_UI_LABELS[key];
    return resolveStoreName(key, '');
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
        receipt_phones: [],
      });
    }

    if (Array.isArray(extraOptions)) {
      for (const opt of extraOptions) {
        const canonicalKey = resolveStoreKey(
          opt?.store_key || opt?.store_partition_key,
          opt?.store_name,
        );
        if (!canonicalKey) continue;
        const prev = byKey.get(canonicalKey);
        const phones = Array.isArray(opt.receipt_phones)
          ? opt.receipt_phones
          : (prev && Array.isArray(prev.receipt_phones) ? prev.receipt_phones : []);
        byKey.set(canonicalKey, {
          store_key: canonicalKey,
          store_name: resolveStoreName(canonicalKey, opt?.store_name),
          webhook_url: lineWebhookUrl(canonicalKey),
          webhook_raw_table: webhookRawTableName(canonicalKey),
          receipt_table: receiptTableName(canonicalKey),
          receipt_phones: phones,
        });
      }
    }

    return Array.from(byKey.values()).sort(function (a, b) {
      return a.store_name.localeCompare(b.store_name, 'ja');
    });
  }

  global.LINE_REPORT_PAGES = {
    PROJECT_URL: PROJECT_URL,
    GMAIL_SHARED_PROJECT_URL: GMAIL_SHARED_PROJECT_URL,
    WEBHOOK_PROJECT_URL: WEBHOOK_PROJECT_URL,
    RECEIPT_ADMIN_PROJECT_URL: RECEIPT_ADMIN_PROJECT_URL,
    RECEIPT_ADMIN_ANON_KEY: RECEIPT_ADMIN_ANON_KEY,
    RECEIPT_SHEETS_PILOT_ENABLED: RECEIPT_SHEETS_PILOT_ENABLED,
    RECEIPT_SHEETS_PILOT_STORE_KEY: RECEIPT_SHEETS_PILOT_STORE_KEY,
    RECEIPT_SHEETS_PILOT_STORE_NAME: RECEIPT_SHEETS_PILOT_STORE_NAME,
    isReceiptSheetsPilotStore: function (storeKey) {
      const key = String(storeKey || '').trim().toLowerCase();
      return !!key && Object.prototype.hasOwnProperty.call(STORE_NAMES, key);
    },
    ADMIN_SURFACE: ADMIN_SURFACE,
    STORE_NAMES: STORE_NAMES,
    adminApiPath: adminApiPath,
    adminApiUrl: adminApiUrl,
    receiptAdminApiUrl: receiptAdminApiUrl,
    gmailSharedAdminApiUrl: gmailSharedAdminApiUrl,
    lineWebhookPath: lineWebhookPath,
    lineWebhookUrl: lineWebhookUrl,
    lineWebhookLegacyUrl: lineWebhookLegacyUrl,
    webhookRawTableName: webhookRawTableName,
    receiptTableName: receiptTableName,
    listStores: listStores,
    resolveStoreKey: resolveStoreKey,
    resolveStoreName: resolveStoreName,
    getPreferredStoreDisplayLabel: getPreferredStoreDisplayLabel,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
