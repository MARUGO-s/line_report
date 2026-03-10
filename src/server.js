import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import XLSX from "xlsx";
import {
  adjustProductStockQty,
  addIngestionError,
  addPriceHistory,
  completeIngestionFile,
  createProduct,
  createStore,
  createIngestionFile,
  deleteIngestionFile,
  dbPath,
  findCatalogProductByIdentity,
  findCatalogProductsByPriceRange,
  findCatalogProductsByQuery,
  findCatalogProductsByVintage,
  findCurrentPricesByQuery,
  getIngestionFileByHash,
  getAdminTokenOverride,
  getActiveReplyTemplateByKey,
  getStoreCsvMapping,
  listIngestionErrors,
  listIngestionFiles,
  listCurrentPrices,
  listPriceHistory,
  listProducts,
  listReplyTemplates,
  listStoreCsvMappings,
  listStores,
  backupDatabaseTo,
  renameReplyTemplateKey,
  renderTemplate,
  resolveProductId,
  resolveStoreId,
  saveLineEvent,
  saveOcrResult,
  recordIngestionProductSnapshot,
  setAdminTokenOverride,
  upsertCatalogProduct,
  upsertStoreCsvMapping,
  upsertReplyTemplate
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const app = express();
const PORT = Number(process.env.PORT || 3200);
const HOST = process.env.HOST || "127.0.0.1";

const asBooleanEnv = (value, defaultValue = false) => {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(text);
};

const lineConfig = {
  channelSecret: String(process.env.LINE_CHANNEL_SECRET || "").trim(),
  accessToken: String(process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  ocrEndpoint: String(process.env.OCR_ENDPOINT || "").trim(),
  ocrAuthToken: String(process.env.OCR_AUTH_TOKEN || "").trim(),
  ocrRequestFormat: String(process.env.OCR_REQUEST_FORMAT || "json_base64").trim(),
  ocrBase64Field: String(process.env.OCR_BASE64_FIELD || "imageBase64").trim(),
  ocrImageField: String(process.env.OCR_IMAGE_FIELD || "image").trim(),
  ocrExtraFields: String(process.env.OCR_EXTRA_FIELDS || "").trim(),
  ocrTimeoutMs: Math.max(1000, Number(process.env.OCR_TIMEOUT_MS || 12000) || 12000)
};

const defaultWineSearchDomains = [
  "www.wine-searcher.com",
  "www.vivino.com",
  "www.cellartracker.com"
];

const webSearchConfig = {
  enabled: asBooleanEnv(process.env.WEB_SEARCH_ENABLED, false),
  timeoutMs: Math.max(1000, Number(process.env.WEB_SEARCH_TIMEOUT_MS || 5000) || 5000),
  maxResults: Math.max(1, Math.min(5, Number(process.env.WEB_SEARCH_MAX_RESULTS || 3) || 3)),
  summaryMaxSources: Math.max(
    3,
    Math.min(12, Number(process.env.WEB_SUMMARY_MAX_SOURCES || 6) || 6)
  ),
  provider: (() => {
    const raw = String(process.env.WEB_SEARCH_PROVIDER || "auto").trim().toLowerCase();
    return ["auto", "free", "serpapi"].includes(raw) ? raw : "auto";
  })(),
  priorityDomains: (() => {
    const parsed = String(process.env.WEB_SEARCH_PRIORITY_DOMAINS || "")
      .split(",")
      .map((item) =>
        String(item || "")
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "")
      )
      .filter(Boolean)
      .slice(0, 5);
    // Keep backward compatibility while migrating old default to wine-focused sources.
    if (parsed.length === 0 || (parsed.length === 1 && parsed[0] === "www.enoteca.co.jp")) {
      return [...defaultWineSearchDomains];
    }
    return parsed;
  })(),
  querySuffix: String(process.env.WEB_SEARCH_QUERY_SUFFIX || " wine").trim(),
  serpApiKey: String(process.env.SERPAPI_API_KEY || "").trim(),
  serpApiEngine: String(process.env.WEB_SEARCH_SERPAPI_ENGINE || "google").trim(),
  serpApiLanguage: String(process.env.WEB_SEARCH_SERPAPI_HL || "ja").trim(),
  serpApiCountry: String(process.env.WEB_SEARCH_SERPAPI_GL || "jp").trim(),
  serpApiNum: Math.max(1, Math.min(10, Number(process.env.WEB_SEARCH_SERPAPI_NUM || 5) || 5)),
  wikipediaLangs: String(process.env.WEB_SEARCH_WIKIPEDIA_LANGS || "en,ja")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 3)
};

const llmConfig = {
  provider: (() => {
    const raw = String(process.env.LLM_PROVIDER || "auto").trim().toLowerCase();
    return ["auto", "groq", "gemini"].includes(raw) ? raw : "auto";
  })()
};

const visionLlmConfig = {
  provider: (() => {
    const raw = String(process.env.VISION_PROVIDER || "groq").trim().toLowerCase();
    return ["auto", "groq", "gemini"].includes(raw) ? raw : "groq";
  })()
};

const groqConfig = {
  apiKey: String(process.env.GROQ_API_KEY || "").trim(),
  model: String(process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim(),
  timeoutMs: Math.max(1000, Number(process.env.GROQ_TIMEOUT_MS || 5000) || 5000),
  maxCandidates: Math.max(1, Math.min(5, Number(process.env.GROQ_MAX_CANDIDATES || 3) || 3))
};

const groqVisionConfig = {
  enabled: asBooleanEnv(process.env.GROQ_VISION_ENABLED, true),
  model: String(process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct").trim(),
  timeoutMs: Math.max(1000, Number(process.env.GROQ_VISION_TIMEOUT_MS || 12000) || 12000),
  maxCandidates: Math.max(1, Math.min(5, Number(process.env.GROQ_VISION_MAX_CANDIDATES || 3) || 3)),
  maxImageBytes: Math.max(
    256 * 1024,
    Number(process.env.GROQ_VISION_MAX_IMAGE_BYTES || 3_500_000) || 3_500_000
  )
};

const groqWineFlowConfig = {
  enabled: asBooleanEnv(process.env.GROQ_WINE_FLOW_ENABLED, true),
  analysisModel: String(
    process.env.GROQ_WINE_ANALYSIS_MODEL || process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct"
  ).trim(),
  replyModel: String(process.env.GROQ_WINE_REPLY_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim(),
  timeoutMs: Math.max(1000, Number(process.env.GROQ_WINE_TIMEOUT_MS || 12000) || 12000)
};

const geminiConfig = {
  apiKey: String(process.env.GEMINI_API_KEY || "").trim(),
  model: String(process.env.GEMINI_MODEL || "gemini-2.0-flash-lite").trim(),
  timeoutMs: Math.max(1000, Number(process.env.GEMINI_TIMEOUT_MS || 5000) || 5000),
  maxCandidates: Math.max(1, Math.min(5, Number(process.env.GEMINI_MAX_CANDIDATES || 3) || 3))
};

const geminiVisionConfig = {
  enabled: asBooleanEnv(process.env.GEMINI_VISION_ENABLED, true),
  model: String(process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || "gemini-2.0-flash-lite").trim(),
  timeoutMs: Math.max(1000, Number(process.env.GEMINI_VISION_TIMEOUT_MS || 12000) || 12000),
  maxCandidates: Math.max(1, Math.min(5, Number(process.env.GEMINI_VISION_MAX_CANDIDATES || 3) || 3)),
  maxImageBytes: Math.max(
    256 * 1024,
    Number(process.env.GEMINI_VISION_MAX_IMAGE_BYTES || 3_500_000) || 3_500_000
  )
};

const geminiWineFlowConfig = {
  enabled: asBooleanEnv(process.env.GEMINI_WINE_FLOW_ENABLED, true),
  analysisModel: String(
    process.env.GEMINI_WINE_ANALYSIS_MODEL || process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || "gemini-2.0-flash-lite"
  ).trim(),
  replyModel: String(process.env.GEMINI_WINE_REPLY_MODEL || process.env.GEMINI_MODEL || "gemini-2.0-flash-lite").trim(),
  timeoutMs: Math.max(1000, Number(process.env.GEMINI_WINE_TIMEOUT_MS || 12000) || 12000)
};

const resolveActiveLlmProvider = () => {
  if (llmConfig.provider === "gemini") {
    return geminiConfig.apiKey ? "gemini" : null;
  }
  if (llmConfig.provider === "groq") {
    return groqConfig.apiKey ? "groq" : null;
  }
  if (geminiConfig.apiKey) {
    return "gemini";
  }
  if (groqConfig.apiKey) {
    return "groq";
  }
  return null;
};

const resolveActiveVisionProvider = () => {
  if (visionLlmConfig.provider === "gemini") {
    return geminiConfig.apiKey ? "gemini" : null;
  }
  if (visionLlmConfig.provider === "groq") {
    return groqConfig.apiKey ? "groq" : null;
  }
  if (groqConfig.apiKey) {
    return "groq";
  }
  if (geminiConfig.apiKey) {
    return "gemini";
  }
  return null;
};

const isWineFlowEnabledForProvider = (provider) => {
  if (provider === "gemini") {
    return geminiWineFlowConfig.enabled;
  }
  if (provider === "groq") {
    return groqWineFlowConfig.enabled;
  }
  return false;
};

const pricingConfig = {
  usdToJpy: Math.max(1, Number(process.env.USD_TO_JPY || 150) || 150),
  eurToJpy: Math.max(1, Number(process.env.EUR_TO_JPY || 165) || 165)
};

const parseOcrExtraFields = (rawValue) => {
  const text = String(rawValue || "").trim();
  if (!text) {
    return {};
  }

  const parsed = {};
  const params = new URLSearchParams(text);
  for (const [key, value] of params.entries()) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      continue;
    }
    parsed[normalizedKey] = String(value || "").trim();
  }
  return parsed;
};

const ocrExtraFields = parseOcrExtraFields(lineConfig.ocrExtraFields);

const securityConfig = {
  envAdminToken: String(process.env.ADMIN_TOKEN || "").trim()
};

const opsConfig = {
  backupDir: String(process.env.BACKUP_DIR || "").trim() || path.join(projectRoot, "backups"),
  backupRetention: Math.max(0, Number(process.env.BACKUP_RETENTION || 30) || 30)
};

const sendError = (res, status, message) => res.status(status).json({ error: message });

const extractAdminTokenFromRequest = (req) => {
  const headerToken = String(req.header("x-admin-token") || "").trim();
  if (headerToken) {
    return headerToken;
  }

  const authorization = String(req.header("authorization") || "").trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return bearer ? String(bearer[1]).trim() : "";
};

const resolveAdminTokenState = () => {
  const dbOverrideToken = String(getAdminTokenOverride() || "").trim();
  if (dbOverrideToken) {
    return {
      token: dbOverrideToken,
      source: "db_override"
    };
  }

  const envToken = String(securityConfig.envAdminToken || "").trim();
  if (envToken) {
    return {
      token: envToken,
      source: "env"
    };
  }

  return {
    token: "",
    source: "none"
  };
};

const isSameAdminToken = (receivedToken, requiredToken) => {
  const receivedBuffer = Buffer.from(String(receivedToken || ""));
  const requiredBuffer = Buffer.from(String(requiredToken || ""));
  if (receivedBuffer.length !== requiredBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(receivedBuffer, requiredBuffer);
};

const requireAdminAuth = (req, res, next) => {
  const tokenState = resolveAdminTokenState();
  if (!tokenState.token) {
    return next();
  }

  if (req.path === "/health") {
    return next();
  }

  const token = extractAdminTokenFromRequest(req);
  if (token && isSameAdminToken(token, tokenState.token)) {
    return next();
  }

  return sendError(res, 401, "admin authentication required");
};

const asPositiveInt = (v) => {
  const parsed = Number.parseInt(String(v), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const asDate = (v) => {
  const text = String(v || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

const asPeriodYm = (v) => {
  const text = String(v || "").trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : null;
};

const parsePriceValue = (v) => {
  const text = String(v ?? "").trim();
  if (!text) {
    return null;
  }
  const normalized = text.replace(/[,\s￥¥円]/g, "");
  if (!normalized) {
    return null;
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return Math.round(number);
};

const hasValue = (value) => String(value ?? "").trim() !== "";

const parseIntegerAllowZero = (value) => {
  if (!hasValue(value)) {
    return null;
  }
  const normalized = String(value).replace(/[,\s]/g, "");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed);
};

const parseRateValue = (value) => {
  if (!hasValue(value)) {
    return null;
  }
  const normalized = String(value).replace(/[,\s％%]/g, "");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed * 100) / 100;
};

const pickFirstNonEmptyText = (...values) => {
  for (const raw of values) {
    const text = String(raw ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
};

const looksLikeNumericCell = (value) => /^[-+]?[\d,\s.]+$/.test(String(value || "").trim());

const detectCsvDelimiter = (headerLine) => {
  const line = String(headerLine || "");
  const comma = (line.match(/,/g) || []).length;
  const tab = (line.match(/\t/g) || []).length;
  const semicolon = (line.match(/;/g) || []).length;

  if (tab > comma && tab >= semicolon) {
    return "\t";
  }
  if (semicolon > comma && semicolon >= tab) {
    return ";";
  }
  return ",";
};

const parseCsvLine = (line, delimiter) => {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === delimiter && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += ch;
  }
  values.push(current);

  return values.map((value) => String(value ?? "").trim());
};

const normalizeHeaderLookupKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "");

const HEADER_MAP = {
  productid: "product_id",
  sku: "sku",
  productsku: "sku",
  code: "sku",
  商品コード: "sku",
  productname: "product_name",
  winename: "name_en",
  nameen: "name_en",
  englishname: "name_en",
  itemname: "product_name",
  商品名: "product_name",
  ワイン名: "product_name",
  年代: "vintage",
  vintage: "vintage",
  producer: "producer",
  winery: "producer",
  producername: "producer",
  maker: "producer",
  生産者: "producer",
  生産者名: "producer",
  作り手: "producer",
  ワイナリー: "producer",
  cepage: "cepage",
  cépage: "cepage",
  grape: "cepage",
  grapes: "cepage",
  grapevarieties: "cepage",
  grapvarieties: "cepage",
  variety: "cepage",
  varieties: "cepage",
  varietal: "cepage",
  varietals: "cepage",
  品種: "cepage",
  ぶどう品種: "cepage",
  葡萄品種: "cepage",
  ブドウ品種: "cepage",
  セパージュ: "cepage",
  storeid: "store_id",
  店舗id: "store_id",
  storecode: "store_code",
  店舗コード: "store_code",
  storename: "store_name",
  店舗名: "store_name",
  price: "price",
  unitprice: "price",
  amount: "price",
  価格: "price",
  effectivedate: "effective_date",
  date: "effective_date",
  適用日: "effective_date",
  日付: "effective_date",
  currency: "currency",
  通貨: "currency",
  販売価格: "retail_price",
  売価: "retail_price",
  retailprice: "retail_price",
  salesprice: "retail_price",
  納品価格: "purchase_price",
  仕入価格: "purchase_price",
  purchaseprice: "purchase_price",
  deliveryprice: "purchase_price",
  在庫数: "stock_qty",
  stockqty: "stock_qty",
  quantity: "stock_qty",
  在庫店舗: "stock_store",
  stockstore: "stock_store",
  納品業者: "supplier_name",
  supplier: "supplier_name",
  suppliername: "supplier_name",
  原価率: "cost_rate",
  costrate: "cost_rate"
};

const buildCustomHeaderMap = (headerMapping) => {
  if (!headerMapping || typeof headerMapping !== "object" || Array.isArray(headerMapping)) {
    return {};
  }

  const mapped = {};
  for (const [sourceHeader, targetField] of Object.entries(headerMapping)) {
    const sourceKey = normalizeHeaderLookupKey(sourceHeader);
    const target = String(targetField || "").trim();
    if (!sourceKey || !target) {
      continue;
    }
    mapped[sourceKey] = target;
  }
  return mapped;
};

const normalizeCsvHeaders = (rawHeaders, customHeaderMap = {}) => {
  const counts = new Map();
  return rawHeaders.map((header, index) => {
    const lookupKey = normalizeHeaderLookupKey(header);
    const normalized =
      customHeaderMap[lookupKey] || HEADER_MAP[lookupKey] || `col_${index + 1}`;
    const currentCount = counts.get(normalized) || 0;
    counts.set(normalized, currentCount + 1);
    return currentCount === 0 ? normalized : `${normalized}_${currentCount + 1}`;
  });
};

const parseCsvText = (csvText, { headerMapping = null, delimiter: fixedDelimiter = null } = {}) => {
  const normalizedText = String(csvText || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const lines = normalizedText.split("\n");
  const headerLineIndex = lines.findIndex((line) => line.trim() !== "");
  if (headerLineIndex < 0) {
    return { headers: [], rows: [] };
  }

  const delimiter = fixedDelimiter || detectCsvDelimiter(lines[headerLineIndex]);
  const rawHeaders = parseCsvLine(lines[headerLineIndex], delimiter);
  const headers = normalizeCsvHeaders(rawHeaders, buildCustomHeaderMap(headerMapping));
  const rows = [];

  for (let i = headerLineIndex + 1; i < lines.length; i += 1) {
    if (!lines[i] || lines[i].trim() === "") {
      continue;
    }
    const values = parseCsvLine(lines[i], delimiter);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    rows.push({
      rowNo: i + 1,
      row
    });
  }

  return { headers, rows };
};

const parseExcelBuffer = (fileBuffer, { headerMapping = null } = {}) => {
  const workbook = XLSX.read(fileBuffer, {
    type: "buffer",
    raw: false
  });
  const firstSheetName = Array.isArray(workbook.SheetNames) ? workbook.SheetNames[0] : "";
  if (!firstSheetName) {
    return { headers: [], rows: [] };
  }

  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) {
    return { headers: [], rows: [] };
  }

  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
    blankrows: true
  });

  const headerRowIndex = matrix.findIndex(
    (rowValues) =>
      Array.isArray(rowValues) &&
      rowValues.some((value) => String(value ?? "").trim() !== "")
  );
  if (headerRowIndex < 0) {
    return { headers: [], rows: [] };
  }

  const rawHeaders = (Array.isArray(matrix[headerRowIndex]) ? matrix[headerRowIndex] : []).map((value) =>
    String(value ?? "").trim()
  );
  const headers = normalizeCsvHeaders(rawHeaders, buildCustomHeaderMap(headerMapping));
  const rows = [];

  for (let i = headerRowIndex + 1; i < matrix.length; i += 1) {
    const values = Array.isArray(matrix[i]) ? matrix[i].map((value) => String(value ?? "").trim()) : [];
    if (!values.some((value) => value !== "")) {
      continue;
    }
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    rows.push({
      rowNo: i + 1,
      row
    });
  }

  return { headers, rows };
};

const decodeBase64Payload = (value) => {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const rawPayload = text.startsWith("data:")
    ? text.slice(text.indexOf(",") + 1)
    : text;
  const normalized = rawPayload.replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    return null;
  }

  try {
    const decoded = Buffer.from(normalized, "base64");
    return decoded.length ? decoded : null;
  } catch {
    return null;
  }
};

const formatYen = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return "不明";
  }
  return `${Math.round(num).toLocaleString("ja-JP")}円`;
};

const buildCurrentPriceLines = (rows) =>
  rows
    .map((row) => `・${row.store_name}: ${Number(row.latest_price).toLocaleString("ja-JP")}円 (${row.effective_date})`)
    .join("\n");

const formatCatalogTitle = (row) =>
  row.name_en && row.name_en !== row.name
    ? `${row.name || "(名称不明)"} / ${row.name_en}`
    : row.name || row.name_en || row.sku || "(名称不明)";

const formatCatalogPrimaryName = (row) => row.name || row.name_en || row.sku || "(名称不明)";

const formatCatalogSecondaryName = (row) => {
  const nameEn = String(row.name_en || "").trim();
  const producer = String(row.producer || "").trim();
  if (nameEn && producer) {
    return `${nameEn} (${producer})`;
  }
  if (nameEn) {
    return nameEn;
  }
  if (producer) {
    return producer;
  }
  return "";
};

const buildCatalogDetailLines = (row) =>
  [
    `ワイン名: ${formatCatalogTitle(row)}`,
    `生産者: ${row.producer || "不明"}`,
    `セパージュ: ${row.cepage || "不明"}`,
    `年代: ${row.vintage || "不明"}`,
    `納品価格: ${formatYen(row.purchase_price)}`,
    `販売価格: ${formatYen(row.retail_price)}`,
    `納品業者: ${row.supplier_name || "不明"}`,
    `在庫数: ${row.stock_qty === null || row.stock_qty === undefined ? "不明" : row.stock_qty}`,
    `在庫店舗: ${row.stock_store || "不明"}`
  ].join("\n");

const buildCatalogChoiceLine = (row, index) => {
  const headline = row.vintage
    ? `${index + 1}. ${formatCatalogPrimaryName(row)} ${row.vintage}`
    : `${index + 1}. ${formatCatalogPrimaryName(row)}`;
  const subline = formatCatalogSecondaryName(row);
  if (!subline) {
    return headline;
  }
  return `${headline}\n   ${subline}`;
};

const toKatakana = (value) =>
  String(value || "").replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );

const foldDiacritics = (value) => String(value || "").normalize("NFD").replace(/\p{M}/gu, "");

const compactSearchText = (value) =>
  String(value || "")
    .replace(/[\s　・･'’"“”`´~〜!！?？,，.。:：;；/／\\\-‐‑‒–—―ー_()（）\[\]{}｛｝【】]/g, "")
    .trim();

const buildSearchQueryVariants = (query) => {
  const base = String(query || "").normalize("NFKC").trim();
  if (!base) {
    return [];
  }

  const variants = [
    base,
    base.toLowerCase(),
    toKatakana(base),
    foldDiacritics(base),
    foldDiacritics(base).toLowerCase(),
    compactSearchText(base),
    compactSearchText(base.toLowerCase()),
    compactSearchText(toKatakana(base)),
    compactSearchText(foldDiacritics(base)),
    compactSearchText(foldDiacritics(base).toLowerCase())
  ].filter(Boolean);

  return [...new Set(variants)];
};

const searchCatalogMatchesByQuery = (query, limit = 20) => {
  const variants = buildSearchQueryVariants(query);
  const merged = new Map();
  for (const variant of variants) {
    const rows = findCatalogProductsByQuery(variant, limit);
    for (const row of rows) {
      if (!merged.has(row.id)) {
        merged.set(row.id, row);
      }
      if (merged.size >= limit) {
        break;
      }
    }
    if (merged.size >= limit) {
      break;
    }
  }
  return [...merged.values()];
};

const parseYearSearchQuery = (query) => {
  const normalized = String(query || "").normalize("NFKC").trim();
  const matched = normalized.match(/^((?:19|20)\d{2})(?:年)?$/);
  return matched ? matched[1] : null;
};

const parsePriceSearchQuery = (query) => {
  const normalized = String(query || "").normalize("NFKC").trim();
  if (!normalized) {
    return null;
  }

  const hasYen = /円/.test(normalized);
  const hasPriceKeyword = /(売り?値|売価|販売価格|仕入れ?値|仕入価格|納品価格|原価|価格|retail|purchase|cost|buy)/i.test(
    normalized
  );
  if (!hasYen && !hasPriceKeyword) {
    return null;
  }

  const numberMatched = normalized.match(/([0-9][0-9,]*)/);
  if (!numberMatched) {
    return null;
  }

  const targetPrice = Number(String(numberMatched[1] || "").replace(/,/g, ""));
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
    return null;
  }

  const hasRetailKeyword = /(売り?値|売価|販売価格|retail|sell)/i.test(normalized);
  const hasPurchaseKeyword = /(仕入れ?値|仕入価格|納品価格|原価|purchase|cost|buy)/i.test(normalized);
  let priceType = "both";
  if (hasRetailKeyword && !hasPurchaseKeyword) {
    priceType = "retail";
  } else if (hasPurchaseKeyword && !hasRetailKeyword) {
    priceType = "purchase";
  }

  const minPrice = Math.max(1, Math.floor(targetPrice * 0.7));
  const maxPrice = Math.ceil(targetPrice * 1.3);
  return {
    targetPrice,
    minPrice,
    maxPrice,
    priceType
  };
};

const toPriceTypeLabel = (priceType) => {
  if (priceType === "retail") {
    return "販売価格";
  }
  if (priceType === "purchase") {
    return "納品価格";
  }
  return "販売価格/納品価格";
};

const buildNumberedCandidatesMessage = ({ header, matches }) => {
  const normalizedHeader = String(header || "").trim() || "候補一覧";
  const footer = "番号だけ送ってください（例: 1）。";
  const maxChars = 4500;

  const blocks = [];
  for (let i = 0; i < matches.length; i += 1) {
    const block = buildCatalogChoiceLine(matches[i], i);
    const nextBody = blocks.concat(block).join("\n\n");
    const preview = [normalizedHeader, nextBody, footer].join("\n\n");
    if (preview.length > maxChars) {
      break;
    }
    blocks.push(block);
  }

  const truncated = blocks.length < matches.length;
  const notice = truncated
    ? `表示上限のため ${matches.length} 件中 ${blocks.length} 件を表示しています。絞り込み語を追加してください。`
    : "";

  return [normalizedHeader, blocks.join("\n\n"), notice, footer].filter(Boolean).join("\n\n");
};

const buildCatalogCandidatesMessage = (query, matches) =>
  buildNumberedCandidatesMessage({
    header: `${query} に一致する候補が ${matches.length} 件見つかりました。`,
    matches
  });

const buildVintageCandidatesMessage = (vintage, matches) =>
  buildNumberedCandidatesMessage({
    header: `${vintage}年のワイン候補が ${matches.length} 件見つかりました。`,
    matches
  });

const buildPriceCandidatesMessage = (priceSearch, matches) =>
  buildNumberedCandidatesMessage({
    header: `${toPriceTypeLabel(priceSearch.priceType)}で ${priceSearch.targetPrice.toLocaleString(
      "ja-JP"
    )}円（±30%: ${priceSearch.minPrice.toLocaleString("ja-JP")}〜${priceSearch.maxPrice.toLocaleString(
      "ja-JP"
    )}円）の候補が ${matches.length} 件見つかりました。`,
    matches
  });

const buildTextByTemplate = (templateKey, variables, fallbackText) => {
  const template = getActiveReplyTemplateByKey(templateKey);
  if (!template) {
    return fallbackText;
  }
  return renderTemplate(template.body, variables);
};

const ensureDefaultTemplates = () => {
  const existingMap = new Map(listReplyTemplates().map((item) => [item.template_key, item.body]));
  const normalizeTemplateBody = (value) =>
    String(value || "")
      .trim()
      .replace(/\\n/g, "\n");
  const defaultBodies = {
    price_found: "【{{product_name}}】\n{{lines}}",
    price_not_found: "「{{query}}」は価格DBで見つかりませんでした。",
    image_received: "画像を受け取りました。ラベル文字を解析します。",
    image_ocr_failed:
      "ラベル文字を読み取れませんでした。\nラベル全体を正面から、明るい場所で再撮影してください。",
    image_ocr_not_found:
      "画像から候補を抽出しましたが、価格DBに一致しませんでした。\n抽出候補: {{query}}",
    image_ocr_web_candidates:
      "価格DBには一致しませんでした。\n抽出候補: {{query}}\n外部候補:\n{{web_lines}}\n※参考情報です。",
    image_ocr_web_summary:
      "価格DBには一致しませんでした。Web要約です。\n産地: {{region}}\n生産者: {{producer}}\n市場価格: {{market_price}}\nセパージュ: {{varieties}}\n味わい: {{taste}}\n特徴: {{features}}\n評価ポイント: {{rating_points}}\n受賞歴: {{awards}}\n飲み頃: {{drinking_window}}\nワイナリーの歴史: {{winery_history}}\n参照ソース: {{sources}}\n検索モード: {{search_mode}}\n参照URL:\n{{source_urls}}"
  };

  const upgradeCandidates = {
    price_found: ["{{product_name}} の最新価格です。\n{{lines}}", "{{product_name}} の検索結果です。\n{{lines}}"],
    price_not_found: ["{{query}} に一致する価格が見つかりませんでした。"],
    image_received: ["画像を受け取りました。OCR解析後に価格候補を返します。"],
    image_ocr_failed: [
      "画像を受け取りましたが、今回はラベル文字を抽出できませんでした。\nラベルを正面から明るい場所で撮影して、もう一度送ってください。"
    ],
    image_ocr_not_found: ["OCR結果から価格を照合できませんでした。\n抽出候補: {{query}}"],
    image_ocr_web_candidates: [
      "価格DBには見つかりませんでした。\n抽出候補: {{query}}\nWeb候補:\n{{web_lines}}\n※この候補は参考情報です。"
    ],
    image_ocr_web_summary: [
      "価格DBには見つかりませんでした。Web情報を要約します。\n産地: {{region}}\n生産者: {{producer}}\n市場価格: {{market_price}}\nセパージュ: {{varieties}}\n※Web参照の要約です。",
      "価格DBには見つかりませんでした。Web情報を要約します。\n産地: {{region}}\n生産者: {{producer}}\n市場価格: {{market_price}}\nセパージュ: {{varieties}}\n味わい: {{taste}}\n特徴: {{features}}\n※Web参照の要約です。",
      "価格DBには見つかりませんでした。Web情報を要約します。\n産地: {{region}}\n生産者: {{producer}}\n市場価格: {{market_price}}\nセパージュ: {{varieties}}\n味わい: {{taste}}\n特徴: {{features}}\n評価ポイント: {{rating_points}}\n受賞歴: {{awards}}\n飲み頃: {{drinking_window}}\nワイナリーの歴史: {{winery_history}}\n※Web参照の要約です。",
      "価格DBには見つかりませんでした。Web情報を要約します。\n産地: {{region}}\n生産者: {{producer}}\n市場価格: {{market_price}}\nセパージュ: {{varieties}}\n味わい: {{taste}}\n特徴: {{features}}\n評価ポイント: {{rating_points}}\n受賞歴: {{awards}}\n飲み頃: {{drinking_window}}\nワイナリーの歴史: {{winery_history}}\n参照ソース: {{sources}}\n※Web参照の要約です。",
      "価格DBには見つかりませんでした。Web情報を要約します。\n産地: {{region}}\n生産者: {{producer}}\n市場価格: {{market_price}}\nセパージュ: {{varieties}}\n味わい: {{taste}}\n特徴: {{features}}\n評価ポイント: {{rating_points}}\n受賞歴: {{awards}}\n飲み頃: {{drinking_window}}\nワイナリーの歴史: {{winery_history}}\n参照ソース: {{sources}}\n検索モード: {{search_mode}}\n参照URL:\n{{source_urls}}\n※Web参照の要約です。"
    ]
  };

  for (const [templateKey, defaultBody] of Object.entries(defaultBodies)) {
    const existingBody = existingMap.get(templateKey);
    if (!existingBody) {
      upsertReplyTemplate({
        templateKey,
        body: defaultBody,
        isActive: true
      });
      continue;
    }

    const normalizedExisting = normalizeTemplateBody(existingBody);
    const normalizedCandidates = new Set(
      (upgradeCandidates[templateKey] || []).map((value) => normalizeTemplateBody(value))
    );
    if (normalizedCandidates.has(normalizedExisting)) {
      upsertReplyTemplate({
        templateKey,
        body: defaultBody,
        isActive: true
      });
    }
  }
};

ensureDefaultTemplates();

const verifyLineSignature = (rawBody, signatureHeader) => {
  if (!lineConfig.channelSecret) {
    return true;
  }
  const signature = String(signatureHeader || "").trim();
  if (!signature) {
    return false;
  }

  const digest = crypto
    .createHmac("sha256", lineConfig.channelSecret)
    .update(rawBody)
    .digest("base64");

  const digestBuffer = Buffer.from(digest);
  const signatureBuffer = Buffer.from(signature);

  if (digestBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(digestBuffer, signatureBuffer);
};

const sendLineReply = async (replyToken, text) => {
  if (!lineConfig.accessToken) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  }

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lineConfig.accessToken}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: String(text) }]
    })
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`LINE reply failed: ${response.status} ${bodyText}`);
  }
};

const fetchLineImageBuffer = async (messageId) => {
  if (!lineConfig.accessToken) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required to fetch image content");
  }

  const response = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${lineConfig.accessToken}` }
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Failed to fetch LINE image: ${response.status} ${bodyText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    imageBuffer: Buffer.from(arrayBuffer),
    contentType: String(response.headers.get("content-type") || "image/jpeg").trim() || "image/jpeg"
  };
};

const extractOcrTextCandidates = (payload, depth = 0) => {
  if (payload === null || payload === undefined || depth > 4) {
    return [];
  }

  if (typeof payload === "string") {
    const value = payload.trim();
    return value ? [value] : [];
  }

  if (Array.isArray(payload)) {
    return payload.flatMap((item) => extractOcrTextCandidates(item, depth + 1));
  }

  if (typeof payload !== "object") {
    return [];
  }

  const prioritizedKeys = [
    "text",
    "extractedText",
    "ocrText",
    "resultText",
    "fullText",
    "label",
    "name"
  ];
  const collectionKeys = [
    "lines",
    "segments",
    "results",
    "predictions",
    "words",
    "items",
    "data",
    "result"
  ];

  const prioritized = prioritizedKeys.flatMap((key) =>
    Object.prototype.hasOwnProperty.call(payload, key)
      ? extractOcrTextCandidates(payload[key], depth + 1)
      : []
  );
  if (prioritized.length) {
    return prioritized;
  }

  const collection = collectionKeys.flatMap((key) =>
    Object.prototype.hasOwnProperty.call(payload, key)
      ? extractOcrTextCandidates(payload[key], depth + 1)
      : []
  );
  if (collection.length) {
    return collection;
  }

  return Object.values(payload).flatMap((value) => extractOcrTextCandidates(value, depth + 1));
};

const extractOcrConfidence = (payload) => {
  const candidates = [
    payload?.confidence,
    payload?.score,
    payload?.avgConfidence,
    payload?.result?.confidence,
    payload?.data?.confidence
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return null;
};

const requestOcr = async (imageBuffer, contentType = "image/jpeg") => {
  if (!lineConfig.ocrEndpoint) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), lineConfig.ocrTimeoutMs);

  try {
    const headers = {};
    if (lineConfig.ocrAuthToken) {
      headers.Authorization = `Bearer ${lineConfig.ocrAuthToken}`;
    }

    let body;
    if (lineConfig.ocrRequestFormat === "multipart") {
      const ext = contentType.includes("png")
        ? "png"
        : contentType.includes("webp")
          ? "webp"
          : "jpg";
      const formData = new FormData();
      for (const [key, value] of Object.entries(ocrExtraFields)) {
        formData.append(key, value);
      }
      formData.append(
        lineConfig.ocrImageField || "image",
        new Blob([imageBuffer], { type: contentType }),
        `line-upload.${ext}`
      );
      body = formData;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
        ...ocrExtraFields,
        [lineConfig.ocrBase64Field || "imageBase64"]: imageBuffer.toString("base64")
      });
    }

    const response = await fetch(lineConfig.ocrEndpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`OCR request failed: ${response.status} ${bodyText}`);
    }

    const contentHeader = String(response.headers.get("content-type") || "").toLowerCase();
    const payload = contentHeader.includes("application/json")
      ? await response.json()
      : { text: await response.text() };

    if (payload?.IsErroredOnProcessing === true) {
      const details = Array.isArray(payload?.ErrorMessage)
        ? payload.ErrorMessage.join("; ")
        : String(payload?.ErrorMessage || "unknown OCR error");
      throw new Error(`OCR provider error: ${details}`);
    }

    const candidates = [...new Set(extractOcrTextCandidates(payload).filter(Boolean))];
    const text = candidates.join("\n").trim();
    if (!text) {
      return null;
    }

    return {
      text,
      confidence: extractOcrConfidence(payload)
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OCR request timed out after ${lineConfig.ocrTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const buildSimulatedPriceReply = (query) => {
  const vintageSearch = parseYearSearchQuery(query);
  if (vintageSearch) {
    const vintageMatches = findCatalogProductsByVintage(vintageSearch, 50);
    if (vintageMatches.length > 1) {
      return {
        message: buildVintageCandidatesMessage(vintageSearch, vintageMatches),
        matches: vintageMatches,
        requiresSelection: true
      };
    }
    if (vintageMatches.length === 1) {
      const lines = buildCatalogDetailLines(vintageMatches[0]);
      return {
        message: `${vintageSearch}年の検索結果です。\n${lines}`,
        matches: vintageMatches,
        requiresSelection: false
      };
    }
    return {
      message: `${vintageSearch}年に一致するワインが見つかりませんでした。`,
      matches: [],
      requiresSelection: false
    };
  }

  const priceSearch = parsePriceSearchQuery(query);
  if (priceSearch) {
    const priceMatches = findCatalogProductsByPriceRange({
      targetPrice: priceSearch.targetPrice,
      minPrice: priceSearch.minPrice,
      maxPrice: priceSearch.maxPrice,
      priceType: priceSearch.priceType,
      limit: 50
    });

    if (priceMatches.length > 1) {
      return {
        message: buildPriceCandidatesMessage(priceSearch, priceMatches),
        matches: priceMatches,
        requiresSelection: true
      };
    }
    if (priceMatches.length === 1) {
      const lines = buildCatalogDetailLines(priceMatches[0]);
      return {
        message: `${toPriceTypeLabel(priceSearch.priceType)} ${priceSearch.targetPrice.toLocaleString(
          "ja-JP"
        )}円（±30%）の検索結果です。\n${lines}`,
        matches: priceMatches,
        requiresSelection: false
      };
    }
    return {
      message: `${toPriceTypeLabel(priceSearch.priceType)} ${priceSearch.targetPrice.toLocaleString(
        "ja-JP"
      )}円（±30%）に一致するワインが見つかりませんでした。`,
      matches: [],
      requiresSelection: false
    };
  }

  const catalogMatches = searchCatalogMatchesByQuery(query, 20);
  if (catalogMatches.length === 1) {
    const lines = buildCatalogDetailLines(catalogMatches[0]);
    return {
      message: buildTextByTemplate(
        "price_found",
        {
          query,
          product_name: catalogMatches[0].name || catalogMatches[0].name_en || query,
          lines
        },
        `${catalogMatches[0].name || catalogMatches[0].name_en || query} の検索結果です。\n${lines}`
      ),
      matches: catalogMatches,
      requiresSelection: false
    };
  }

  if (catalogMatches.length > 1) {
    return {
      message: buildCatalogCandidatesMessage(query, catalogMatches),
      matches: catalogMatches,
      requiresSelection: true
    };
  }

  const matches = findCurrentPricesByQuery(query, 3);
  if (!matches.length) {
    return {
      message: buildTextByTemplate(
        "price_not_found",
        { query },
        `${query} に一致する価格が見つかりませんでした。`
      ),
      matches: [],
      requiresSelection: false
    };
  }

  return {
    message: buildTextByTemplate(
      "price_found",
      {
        query,
        product_name: matches[0].product_name,
        lines: buildCurrentPriceLines(matches.slice(0, 5))
      },
      `${matches[0].product_name} の最新価格\n${buildCurrentPriceLines(matches.slice(0, 5))}`
    ),
    matches,
    requiresSelection: false
  };
};

const truncateText = (value, maxLength = 120) => {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
};

const isLikelyNoiseLine = (value) => {
  const text = String(value || "").trim();
  if (!text) {
    return true;
  }
  const lowered = text.toLowerCase();
  if (
    /https?:\/\/|api\.render\.com|cli\.yaml|render|bearer|select\(|jq|\/tmp\/|^key=/.test(lowered) ||
    /(do you want me to|verify|week|週間|移動|ツール|ウィンドウ|ヘルプ)/.test(lowered)
  ) {
    return true;
  }

  const letterCount = (text.match(/\p{L}/gu) || []).length;
  const digitCount = (text.match(/\p{N}/gu) || []).length;
  if (letterCount < 3) {
    return true;
  }
  if (digitCount >= 6 && digitCount > letterCount) {
    return true;
  }
  return false;
};

const dedupeTextArray = (items) => {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const normalized = String(item || "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(String(item || "").trim());
  }
  return result;
};

const scoreQueryCandidate = (value) => {
  const text = String(value || "").trim();
  if (!text) {
    return 0;
  }
  const lowered = text.toLowerCase();
  const keywords = [
    "chateau",
    "domaine",
    "estate",
    "grand",
    "cru",
    "classe",
    "class",
    "vin",
    "reserve",
    "cabernet",
    "merlot",
    "pinot",
    "sauvignon",
    "bordeaux",
    "bourgogne",
    "margaux",
    "riesling",
    "shiraz",
    "sweet",
    "red",
    "white",
    "wine",
    "ワイン"
  ];
  let score = 0;
  for (const keyword of keywords) {
    if (lowered.includes(keyword)) {
      score += 2;
    }
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words >= 2 && words <= 8) {
    score += 2;
  }
  if (text.length >= 8 && text.length <= 70) {
    score += 1;
  }
  return score;
};

const extractQueryCandidatesFromOcrText = (text) => {
  const base = String(text || "").trim();
  if (!base) {
    return [];
  }

  const rawLines = base
    .split(/[\n\r\t,，、/|]/)
    .map((line) =>
      String(line || "")
        .replace(/[^\p{L}\p{N}\s'’-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/[0-9０-９]+(?:円|ml|ML|年|本|%|度)?/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((line) => line.length >= 3 && line.length <= 80)
    .filter((line) => !isLikelyNoiseLine(line));

  const uniqueLines = dedupeTextArray(rawLines);
  if (!uniqueLines.length) {
    return [truncateText(base.replace(/\s+/g, " "), 80)];
  }

  const sorted = [...uniqueLines].sort((a, b) => scoreQueryCandidate(b) - scoreQueryCandidate(a));
  const combined =
    sorted.length >= 2
      ? truncateText(`${sorted[0]} ${sorted[1]}`.replace(/\s+/g, " "), 80)
      : null;
  const candidates = dedupeTextArray([combined, ...sorted]).filter(Boolean);
  return candidates.slice(0, 8);
};

const fetchJsonWithTimeout = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`request failed ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

const extractTextFromGeminiResponse = (payload) => {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const parts = [];
  for (const candidate of candidates) {
    const contentParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of contentParts) {
      if (typeof part?.text === "string" && part.text.trim()) {
        parts.push(part.text);
      }
    }
  }
  return parts.join("\n").trim();
};

const requestGeminiGenerateText = async ({
  model,
  systemPrompt = "",
  userPrompt = "",
  imagePart = null,
  temperature = 0.1,
  maxOutputTokens = 512,
  timeoutMs = 12000
}) => {
  if (!geminiConfig.apiKey) {
    throw new Error("gemini api key is missing");
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const parts = [{ text: String(userPrompt || "") }];
  if (imagePart?.data && imagePart?.mimeType) {
    parts.push({
      inline_data: {
        mime_type: String(imagePart.mimeType),
        data: String(imagePart.data)
      }
    });
  }

  const body = {
    contents: [
      {
        role: "user",
        parts
      }
    ],
    generationConfig: {
      temperature,
      maxOutputTokens
    }
  };
  if (String(systemPrompt || "").trim()) {
    body.system_instruction = {
      parts: [{ text: String(systemPrompt) }]
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiConfig.apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`gemini request failed ${response.status} ${truncateText(text, 240)}`);
    }
    const payload = await response.json();
    return extractTextFromGeminiResponse(payload);
  } finally {
    clearTimeout(timer);
  }
};

const fetchImageBufferByUrl = async (imageUrl, timeoutMs, maxBytes) => {
  const urlText = String(imageUrl || "").trim();
  if (!/^https?:\/\//i.test(urlText)) {
    throw new Error("imageUrl must start with http:// or https://");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(urlText, {
      method: "GET",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`image fetch failed ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    if (imageBuffer.length > maxBytes) {
      throw new Error(`image too large (${imageBuffer.length} > ${maxBytes})`);
    }
    const contentType = String(response.headers.get("content-type") || "image/jpeg").trim();
    return { imageBuffer, contentType };
  } finally {
    clearTimeout(timer);
  }
};

const searchWikipediaCandidates = async (query) => {
  const results = [];
  for (const lang of webSearchConfig.wikipediaLangs) {
    if (results.length >= webSearchConfig.maxResults) {
      break;
    }

    const endpoint = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    endpoint.searchParams.set("action", "opensearch");
    endpoint.searchParams.set("search", query);
    endpoint.searchParams.set("limit", String(webSearchConfig.maxResults));
    endpoint.searchParams.set("namespace", "0");
    endpoint.searchParams.set("format", "json");

    try {
      const payload = await fetchJsonWithTimeout(endpoint.toString(), webSearchConfig.timeoutMs);
      const titles = Array.isArray(payload?.[1]) ? payload[1] : [];
      const descriptions = Array.isArray(payload?.[2]) ? payload[2] : [];
      const urls = Array.isArray(payload?.[3]) ? payload[3] : [];
      for (let i = 0; i < titles.length; i += 1) {
        if (results.length >= webSearchConfig.maxResults) {
          break;
        }
        const title = String(titles[i] || "").trim();
        const url = String(urls[i] || "").trim();
        if (!title || !url) {
          continue;
        }
        results.push({
          title,
          url,
          snippet: truncateText(descriptions[i], 120),
          source: `wikipedia-${lang}`
        });
      }
    } catch (error) {
      console.warn("Wikipedia search failed", lang, error?.message || error);
    }
  }
  return results;
};

const flattenDuckDuckGoTopics = (topics) => {
  const stack = Array.isArray(topics) ? [...topics] : [];
  const flattened = [];
  while (stack.length > 0) {
    const item = stack.shift();
    if (!item || typeof item !== "object") {
      continue;
    }
    if (Array.isArray(item.Topics)) {
      stack.push(...item.Topics);
      continue;
    }
    flattened.push(item);
  }
  return flattened;
};

const searchDuckDuckGoCandidates = async (query) => {
  const endpoint = new URL("https://api.duckduckgo.com/");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("no_html", "1");
  endpoint.searchParams.set("skip_disambig", "1");

  const payload = await fetchJsonWithTimeout(endpoint.toString(), webSearchConfig.timeoutMs);
  const items = [];
  const heading = String(payload?.Heading || "").trim();
  const abstractText = String(payload?.AbstractText || "").trim();
  const abstractUrl = String(payload?.AbstractURL || "").trim();
  if (heading && abstractUrl) {
    items.push({
      title: heading,
      url: abstractUrl,
      snippet: truncateText(abstractText, 120),
      source: "duckduckgo"
    });
  }

  const topics = flattenDuckDuckGoTopics(payload?.RelatedTopics || []);
  for (const topic of topics) {
    if (items.length >= webSearchConfig.maxResults) {
      break;
    }
    const title = truncateText(topic?.Text || "", 80);
    const url = String(topic?.FirstURL || "").trim();
    if (!title || !url) {
      continue;
    }
    items.push({
      title,
      url,
      snippet: "",
      source: "duckduckgo"
    });
  }
  return items;
};

const extractHostname = (urlText) => {
  try {
    const url = new URL(String(urlText || "").trim());
    return String(url.hostname || "").trim().toLowerCase();
  } catch (error) {
    return "";
  }
};

const isPriorityDomainUrl = (urlText) =>
  webSearchConfig.priorityDomains.some((domain) => isUrlInDomain(urlText, domain));

const hasPriorityDomainCandidates = (items = []) =>
  (items || []).some((item) => isPriorityDomainUrl(item?.url));

const asSourceDisplayName = (urlText) => {
  const host = extractHostname(urlText);
  if (!host) {
    return "web";
  }
  if (host.endsWith("wine-searcher.com")) {
    return "Wine-Searcher";
  }
  if (host.endsWith("vivino.com")) {
    return "Vivino";
  }
  if (host.endsWith("cellartracker.com")) {
    return "CellarTracker";
  }
  return host.replace(/^www\./, "");
};

const buildSourceSummary = (items = []) => {
  const sources = dedupeTextArray((items || []).map((item) => asSourceDisplayName(item?.url))).slice(0, 4);
  return sources.length > 0 ? sources.join(" / ") : "不明";
};

const buildSourceUrlLines = (items = []) => {
  const urls = [];
  const seen = new Set();
  for (const item of items || []) {
    const url = String(item?.url || "").trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(truncateText(url, 140));
    if (urls.length >= 3) {
      break;
    }
  }
  if (urls.length === 0) {
    return "不明";
  }
  return urls.map((url, index) => `${index + 1}. ${url}`).join("\n");
};

const detectSearchMode = (items = []) =>
  hasPriorityDomainCandidates(items) ? "3サイト優先検索" : "全体Webフォールバック";

const isUrlInDomain = (urlText, domain) => {
  const host = extractHostname(urlText);
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (!host || !normalizedDomain) {
    return false;
  }
  return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
};

const normalizeSearchText = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const splitSearchTokens = (value) =>
  normalizeSearchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 8);

const isLikelyRelevantPriorityCandidate = (item, query, domain) => {
  const url = String(item?.url || "").trim();
  if (!url || !isUrlInDomain(url, domain)) {
    return false;
  }

  const normalizedUrl = normalizeSearchText(url);
  const normalizedBody = normalizeSearchText(
    `${String(item?.title || "")} ${String(item?.snippet || "")}`
  );
  const tokens = splitSearchTokens(query);
  if (!tokens.length) {
    return true;
  }

  const matched = tokens.filter(
    (token) => normalizedBody.includes(token) || normalizedUrl.includes(token)
  ).length;

  // Keep only likely product/info pages from the prioritized domain.
  const host = extractHostname(url);
  const wineSearcherPath = /\/find\/|\/wine-\d+|\/merchant\//i.test(url);
  const vivinoPath = /\/wines\/|\/explore\/|\/w\/[0-9a-z-]+/i.test(url);
  const cellarTrackerPath = /\/wine\.asp|\/list\.asp|\/producer\.asp/i.test(url);
  const genericWinePath = /\/item\/|\/archives\/|\/article\/|\/producer\/|\/shop\//i.test(url);

  if (
    (host.endsWith("wine-searcher.com") && wineSearcherPath) ||
    (host.endsWith("vivino.com") && vivinoPath) ||
    (host.endsWith("cellartracker.com") && cellarTrackerPath) ||
    genericWinePath
  ) {
    return matched >= 1;
  }
  if (tokens.length <= 2) {
    return matched >= 1;
  }
  return matched >= 2;
};

const searchSerpApiCandidates = async (query, options = {}) => {
  if (!webSearchConfig.serpApiKey) {
    return [];
  }
  const preferredDomain = String(options.preferredDomain || "")
    .trim()
    .toLowerCase();
  const limit = Math.max(
    1,
    Math.min(12, Number(options.limit || webSearchConfig.maxResults) || webSearchConfig.maxResults)
  );

  const endpoint = new URL("https://serpapi.com/search.json");
  endpoint.searchParams.set("engine", webSearchConfig.serpApiEngine || "google");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("num", String(Math.max(limit, webSearchConfig.serpApiNum)));
  endpoint.searchParams.set("api_key", webSearchConfig.serpApiKey);
  if (webSearchConfig.serpApiLanguage) {
    endpoint.searchParams.set("hl", webSearchConfig.serpApiLanguage);
  }
  if (webSearchConfig.serpApiCountry) {
    endpoint.searchParams.set("gl", webSearchConfig.serpApiCountry);
  }

  const payload = await fetchJsonWithTimeout(endpoint.toString(), webSearchConfig.timeoutMs);
  if (payload?.error) {
    throw new Error(`serpapi error: ${payload.error}`);
  }

  const items = [];
  const pushItem = (item) => {
    if (items.length >= limit) {
      return;
    }
    const title = String(item?.title || "").trim();
    const url = String(item?.url || "").trim();
    if (!title || !url) {
      return;
    }
    if (preferredDomain && !isUrlInDomain(url, preferredDomain)) {
      return;
    }
    items.push({
      title: truncateText(title, 90),
      url,
      snippet: truncateText(item?.snippet || "", 120),
      source: item?.source || "serpapi"
    });
  };

  const knowledge = payload?.knowledge_graph;
  const knowledgeTitle = String(knowledge?.title || "").trim();
  const knowledgeUrl = String(knowledge?.website || knowledge?.description_link || "").trim();
  if (knowledgeTitle && knowledgeUrl) {
    pushItem({
      title: knowledgeTitle,
      url: knowledgeUrl,
      snippet: String(knowledge?.description || "").trim(),
      source: "serpapi-knowledge"
    });
  }

  const organicResults = Array.isArray(payload?.organic_results) ? payload.organic_results : [];
  for (const result of organicResults) {
    if (items.length >= webSearchConfig.maxResults) {
      break;
    }
    pushItem({
      title: result?.title,
      url: result?.link || result?.redirect_link,
      snippet: result?.snippet,
      source: "serpapi-organic"
    });
  }

  return items;
};

const searchWebCandidates = async (query, options = {}) => {
  if (!webSearchConfig.enabled) {
    return [];
  }
  const fallbackToBroad = options.fallbackToBroad !== false;
  const normalizeAscii = (value) =>
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");
  const base = String(query || "").trim();
  const queryVariants = dedupeTextArray([
    base,
    normalizeAscii(base),
    webSearchConfig.querySuffix ? `${base} ${webSearchConfig.querySuffix}` : "",
    webSearchConfig.querySuffix ? `${normalizeAscii(base)} ${webSearchConfig.querySuffix}` : ""
  ]).filter(Boolean);

  const trySerpApi = webSearchConfig.provider === "auto" || webSearchConfig.provider === "serpapi";
  const tryFreeSources =
    webSearchConfig.provider === "auto" ||
    webSearchConfig.provider === "free" ||
    (webSearchConfig.provider === "serpapi" && !webSearchConfig.serpApiKey);
  const targetCount = Math.max(
    webSearchConfig.maxResults,
    webSearchConfig.summaryMaxSources,
    webSearchConfig.priorityDomains.length * 2
  );

  const domainCandidates = [];
  if (trySerpApi && webSearchConfig.serpApiKey) {
    for (const searchQuery of queryVariants) {
      if (domainCandidates.length >= targetCount) {
        break;
      }
      for (const domain of webSearchConfig.priorityDomains) {
        if (domainCandidates.length >= targetCount) {
          break;
        }
        try {
          const siteQuery = `site:${domain} ${searchQuery}`.trim();
          const serpSiteRaw = await searchSerpApiCandidates(siteQuery, {
            preferredDomain: domain,
            limit: 2
          });
          const serpSite = serpSiteRaw.filter((item) =>
            isLikelyRelevantPriorityCandidate(item, searchQuery, domain)
          );
          domainCandidates.push(
            ...serpSite.map((item) => ({
              ...item,
              source: `${item.source || "serpapi"}-site:${domain}`
            }))
          );
        } catch (error) {
          console.warn("SerpAPI domain search failed", domain, error?.message || error);
        }
      }
    }
  }

  // If none of the designated wine sites match, then fallback to broad web search.
  const candidates = [...domainCandidates];
  if (domainCandidates.length === 0 && fallbackToBroad) {
    for (const searchQuery of queryVariants) {
      if (candidates.length >= targetCount) {
        break;
      }

      if (trySerpApi && webSearchConfig.serpApiKey) {
        try {
          const serp = await searchSerpApiCandidates(searchQuery, { limit: webSearchConfig.maxResults });
          candidates.push(...serp);
        } catch (error) {
          console.warn("SerpAPI search failed", error?.message || error);
        }
        if (candidates.length >= targetCount) {
          break;
        }
      }

      if (!tryFreeSources) {
        continue;
      }

      const wiki = await searchWikipediaCandidates(searchQuery);
      candidates.push(...wiki);
      if (candidates.length >= targetCount) {
        break;
      }

      try {
        const ddg = await searchDuckDuckGoCandidates(searchQuery);
        candidates.push(...ddg);
      } catch (error) {
        console.warn("DuckDuckGo search failed", error?.message || error);
      }
    }
  }

  const deduped = [];
  const seenUrl = new Set();
  for (const item of candidates) {
    const url = String(item?.url || "").trim();
    if (!url || seenUrl.has(url)) {
      continue;
    }
    seenUrl.add(url);
    deduped.push({
      title: truncateText(item?.title || "", 90),
      url,
      snippet: truncateText(item?.snippet || "", 120),
      source: item?.source || "web"
    });
    if (deduped.length >= targetCount) {
      break;
    }
  }

  // Prefer diversity across prioritized wine domains first, then fill with remaining.
  const prioritized = [];
  const prioritizedSeen = new Set();
  for (const domain of webSearchConfig.priorityDomains) {
    const first = deduped.find((item) => isUrlInDomain(item.url, domain) && !prioritizedSeen.has(item.url));
    if (first) {
      prioritized.push(first);
      prioritizedSeen.add(first.url);
    }
  }
  const rest = deduped.filter((item) => !prioritizedSeen.has(item.url));
  return [...prioritized, ...rest].slice(0, targetCount);
};

const parseJsonObjectFromText = (value) => {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // fall through
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch (error) {
    return null;
  }
};

const normalizeSummaryField = (value) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || "不明";
};

const normalizeVarieties = (value) => {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 5);
    return items.length ? items.join(", ") : "不明";
  }
  const text = String(value || "").trim();
  return text || "不明";
};

const collectPriceHintsFromText = (text) => {
  const body = String(text || "");
  if (!body) {
    return [];
  }

  const hits = [];
  const patterns = [
    { currency: "JPY", regex: /(?:¥|￥|JPY)\s*([0-9][0-9,]{2,}(?:\.[0-9]+)?)/gi },
    { currency: "USD", regex: /(?:USD|\$)\s*([0-9][0-9,]{1,}(?:\.[0-9]+)?)/gi },
    { currency: "EUR", regex: /(?:EUR|€)\s*([0-9][0-9,]{1,}(?:\.[0-9]+)?)/gi },
    { currency: "JPY", regex: /([0-9][0-9,]{2,}(?:\.[0-9]+)?)\s*(?:円|yen)/gi }
  ];

  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern.regex)) {
      const raw = String(match[1] || "").trim();
      if (!raw) {
        continue;
      }
      hits.push(`${pattern.currency} ${raw}`);
    }
  }
  return dedupeTextArray(hits).slice(0, 5);
};

const grapeVarietyPatterns = [
  { label: "Cabernet Sauvignon", patterns: [/\bcabernet\s+sauvignon\b/i, /カベルネ[・\s]?ソーヴィニヨン/u] },
  { label: "Cabernet Franc", patterns: [/\bcabernet\s+franc\b/i, /カベルネ[・\s]?フラン/u] },
  { label: "Merlot", patterns: [/\bmerlot\b/i, /メルロ[ー]?/u] },
  { label: "Pinot Noir", patterns: [/\bpinot\s+noir\b/i, /ピノ[・\s]?ノワール/u] },
  { label: "Syrah", patterns: [/\bsyrah\b/i, /シラー/u] },
  { label: "Shiraz", patterns: [/\bshiraz\b/i, /シラーズ/u] },
  { label: "Tempranillo", patterns: [/\btempranillo\b/i, /テンプラニーリョ/u] },
  { label: "Garnacha", patterns: [/\bgarnacha\b/i, /\bgrenache\b/i, /ガルナッチャ/u, /グルナッシュ/u] },
  { label: "Graciano", patterns: [/\bgraciano\b/i, /グラシアーノ/u] },
  { label: "Mazuelo", patterns: [/\bmazuelo\b/i, /\bcarignan\b/i, /マスエロ/u, /カリニャン/u] },
  { label: "Chardonnay", patterns: [/\bchardonnay\b/i, /シャルドネ/u] },
  { label: "Sauvignon Blanc", patterns: [/\bsauvignon\s+blanc\b/i, /ソーヴィニヨン[・\s]?ブラン/u] },
  { label: "Riesling", patterns: [/\briesling\b/i, /リースリング/u] },
  { label: "Sangiovese", patterns: [/\bsangiovese\b/i, /サンジョヴェーゼ/u] },
  { label: "Nebbiolo", patterns: [/\bnebbiolo\b/i, /ネッビオーロ/u] },
  { label: "Malbec", patterns: [/\bmalbec\b/i, /マルベック/u] },
  { label: "Zinfandel", patterns: [/\bzinfandel\b/i, /ジンファンデル/u] },
  { label: "Viura", patterns: [/\bviura\b/i, /\bmacabeo\b/i, /ビウラ/u, /マカベオ/u] }
];

const collectVarietyHintsFromText = (text) => {
  const body = String(text || "");
  if (!body) {
    return [];
  }

  const found = [];
  for (const entry of grapeVarietyPatterns) {
    if (entry.patterns.some((pattern) => pattern.test(body))) {
      found.push(entry.label);
    }
  }
  return dedupeTextArray(found).slice(0, 8);
};

const tastePatterns = [
  { label: "フルボディ", patterns: [/\bfull[-\s]?bod(?:y|ied)\b/i, /フルボディ/u] },
  { label: "ミディアムボディ", patterns: [/\bmedium[-\s]?bod(?:y|ied)\b/i, /ミディアムボディ/u] },
  { label: "ライトボディ", patterns: [/\blight[-\s]?bod(?:y|ied)\b/i, /ライトボディ/u] },
  { label: "辛口", patterns: [/\bdry\b/i, /辛口/u] },
  { label: "やや辛口", patterns: [/\boff[-\s]?dry\b/i, /やや辛口/u] },
  { label: "甘口", patterns: [/\bsweet\b/i, /甘口/u] },
  { label: "高い酸味", patterns: [/\bhigh\s+acidity\b/i, /酸味(が)?高/u] },
  { label: "穏やかな酸味", patterns: [/\blow\s+acidity\b/i, /酸味(が)?穏やか/u] },
  { label: "しっかりしたタンニン", patterns: [/\btannic\b/i, /タンニン(が)?強/u, /しっかりしたタンニン/u] },
  { label: "まろやか", patterns: [/\bsmooth\b/i, /まろやか/u] },
  { label: "エレガント", patterns: [/\belegant\b/i, /エレガント/u] },
  { label: "力強い", patterns: [/\bpowerful\b/i, /力強/u] }
];

const collectTasteHintsFromText = (text) => {
  const body = String(text || "");
  if (!body) {
    return [];
  }

  const found = [];
  for (const entry of tastePatterns) {
    if (entry.patterns.some((pattern) => pattern.test(body))) {
      found.push(entry.label);
    }
  }
  return dedupeTextArray(found).slice(0, 6);
};

const featurePatterns = [
  { label: "赤系果実", patterns: [/\bred\s+fruit(s)?\b/i, /\bcherry\b/i, /\brasberry\b/i, /赤系果実/u, /チェリー/u] },
  { label: "黒系果実", patterns: [/\bblack\s+fruit(s)?\b/i, /\bblackcurrant\b/i, /\bcassis\b/i, /\bplum\b/i, /黒系果実/u, /カシス/u, /プラム/u] },
  { label: "柑橘", patterns: [/\bcitrus\b/i, /柑橘/u] },
  { label: "フローラル", patterns: [/\bfloral\b/i, /花/u] },
  { label: "ハーブ", patterns: [/\bherb(al)?\b/i, /ハーブ/u] },
  { label: "スパイス", patterns: [/\bspice(d)?\b/i, /スパイス/u] },
  { label: "オーク", patterns: [/\boak\b/i, /オーク/u, /樽/u] },
  { label: "バニラ", patterns: [/\bvanilla\b/i, /バニラ/u] },
  { label: "チョコレート", patterns: [/\bchocolate\b/i, /チョコレート/u] },
  { label: "スモーキー", patterns: [/\bsmoky\b/i, /スモーキー/u] },
  { label: "ミネラル", patterns: [/\bminerality?\b/i, /ミネラル/u] },
  { label: "長い余韻", patterns: [/\blong\s+finish\b/i, /余韻(が)?長/u] }
];

const collectFeatureHintsFromText = (text) => {
  const body = String(text || "");
  if (!body) {
    return [];
  }

  const found = [];
  for (const entry of featurePatterns) {
    if (entry.patterns.some((pattern) => pattern.test(body))) {
      found.push(entry.label);
    }
  }
  return dedupeTextArray(found).slice(0, 10);
};

const ratingSourcePatterns = [
  { label: "WA", regex: /(?:\bWA\b|Wine Advocate|Robert Parker|Parker|RP)[^0-9]{0,12}([8-9][0-9]|100)(?:\+)?(?:\s*\/\s*100|\s*(?:pts?|points?|点|ポイント))?/gi },
  { label: "JS", regex: /(?:\bJS\b|James Suckling)[^0-9]{0,12}([8-9][0-9]|100)(?:\+)?(?:\s*\/\s*100|\s*(?:pts?|points?|点|ポイント))?/gi },
  { label: "WS", regex: /(?:\bWS\b|Wine Spectator)[^0-9]{0,12}([8-9][0-9]|100)(?:\+)?(?:\s*\/\s*100|\s*(?:pts?|points?|点|ポイント))?/gi },
  { label: "WE", regex: /(?:\bWE\b|Wine Enthusiast)[^0-9]{0,12}([8-9][0-9]|100)(?:\+)?(?:\s*\/\s*100|\s*(?:pts?|points?|点|ポイント))?/gi },
  { label: "JD", regex: /(?:\bJD\b|Jeb Dunnuck)[^0-9]{0,12}([8-9][0-9]|100)(?:\+)?(?:\s*\/\s*100|\s*(?:pts?|points?|点|ポイント))?/gi },
  { label: "VN", regex: /(?:\bVN\b|Vinous)[^0-9]{0,12}([8-9][0-9]|100)(?:\+)?(?:\s*\/\s*100|\s*(?:pts?|points?|点|ポイント))?/gi },
  { label: "Decanter", regex: /(?:Decanter|DWWA)[^0-9]{0,12}([8-9][0-9]|100)(?:\+)?(?:\s*\/\s*100|\s*(?:pts?|points?|点|ポイント))?/gi }
];

const collectRatingHintsFromText = (text) => {
  const body = String(text || "");
  if (!body) {
    return [];
  }

  const found = [];
  for (const source of ratingSourcePatterns) {
    for (const match of body.matchAll(source.regex)) {
      const score = String(match[1] || "").trim();
      if (!score) {
        continue;
      }
      found.push(`${source.label} ${score}`);
    }
  }

  for (const match of body.matchAll(/\b([8-9][0-9]|100)(?:\+)?\s*(?:\/\s*100|\s*(?:pts?|points?|点|ポイント))\b/gi)) {
    const score = String(match[1] || "").trim();
    if (score) {
      found.push(`評価 ${score}`);
    }
  }
  return dedupeTextArray(found).slice(0, 8);
};

const collectAwardHintsFromText = (text) => {
  const body = String(text || "");
  if (!body) {
    return [];
  }
  const matches = [
    ...body.matchAll(
      /[^。.!?\n]{0,90}(?:受賞|金賞|銀賞|銅賞|グランプリ|Best|Award|Trophy|Medal|Top\s*100|サクラアワード|IWC|IWSC|Decanter)[^。.!?\n]{0,120}/giu
    )
  ];
  return dedupeTextArray(
    matches
      .map((match) => truncateText(String(match[0] || "").replace(/\s+/g, " ").trim(), 130))
      .filter(Boolean)
  ).slice(0, 6);
};

const collectDrinkingWindowHintsFromText = (text) => {
  const body = String(text || "");
  if (!body) {
    return [];
  }
  const found = [];

  for (const match of body.matchAll(/\b((?:19|20)\d{2})\s*(?:-|–|〜|~|to)\s*((?:19|20)\d{2})\b/g)) {
    const start = String(match[1] || "").trim();
    const end = String(match[2] || "").trim();
    if (start && end) {
      found.push(`${start}-${end}`);
    }
  }

  for (const match of body.matchAll(
    /(?:drink(?:ing)?\s*(?:window|from|through)?|best\s*from|peak|ready\s*to\s*drink|飲み頃|飲み時)[^0-9]{0,15}((?:19|20)\d{2}(?:\s*(?:-|–|〜|~|to)\s*(?:19|20)\d{2})?)/giu
  )) {
    const value = String(match[1] || "").replace(/\s+/g, "").trim();
    if (value) {
      found.push(value.replace(/to/gi, "-").replace(/[–〜~]/g, "-"));
    }
  }

  return dedupeTextArray(found).slice(0, 5);
};

const collectHistoryHintsFromText = (text) => {
  const body = String(text || "");
  if (!body) {
    return [];
  }
  const matches = [
    ...body.matchAll(
      /[^。.!?\n]{0,90}(?:Founded|Established|Since|History|創業|設立|創立|創設|起源|歴史|老舗)[^。.!?\n]{0,160}/giu
    )
  ];
  return dedupeTextArray(
    matches
      .map((match) => truncateText(String(match[0] || "").replace(/\s+/g, " ").trim(), 150))
      .filter(Boolean)
  ).slice(0, 4);
};

const buildRatingPointsFromHints = (ratingHints = []) => {
  const hints = dedupeTextArray(ratingHints).slice(0, 4);
  return hints.length > 0 ? hints.join(", ") : "不明";
};

const buildAwardsFromHints = (awardHints = []) => {
  const hints = dedupeTextArray(awardHints).slice(0, 3);
  return hints.length > 0 ? hints.join(" / ") : "不明";
};

const buildDrinkingWindowFromHints = (drinkingWindowHints = []) => {
  const hints = dedupeTextArray(drinkingWindowHints);
  if (!hints.length) {
    return "不明";
  }
  const ranged = hints.find((item) => /(?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}/.test(item));
  if (ranged) {
    return ranged;
  }
  const withYear = hints.find((item) => /(?:19|20)\d{2}/.test(item));
  return withYear || "不明";
};

const buildWineryHistoryFromHints = (historyHints = []) => {
  const hints = dedupeTextArray(historyHints);
  if (!hints.length) {
    return "不明";
  }
  return truncateText(hints[0], 140);
};

const parseCriticScoresFromText = (value) => {
  const text = String(value || "");
  if (!text.trim()) {
    return [];
  }

  const findYearNear = (fullText, matchIndex) => {
    const start = Math.max(0, Number(matchIndex || 0) - 24);
    const end = Math.min(fullText.length, Number(matchIndex || 0) + 32);
    const near = fullText.slice(start, end);
    const year = near.match(/\b((?:19|20)\d{2})\b/);
    return year ? year[1] : null;
  };

  const patterns = [
    { source: "Robert Parker / WA", regex: /(?:Robert Parker|Parker|Wine Advocate|\bWA\b|\bRP\b)[^0-9]{0,14}([8-9][0-9]|100)(?:\+)?/gi },
    { source: "James Suckling", regex: /(?:James Suckling|\bJS\b)[^0-9]{0,14}([8-9][0-9]|100)(?:\+)?/gi },
    { source: "Wine Spectator", regex: /(?:Wine Spectator|\bWS\b)[^0-9]{0,14}([8-9][0-9]|100)(?:\+)?/gi },
    { source: "Wine Enthusiast", regex: /(?:Wine Enthusiast|\bWE\b)[^0-9]{0,14}([8-9][0-9]|100)(?:\+)?/gi },
    { source: "Vinous", regex: /(?:Vinous|\bVN\b)[^0-9]{0,14}([8-9][0-9]|100)(?:\+)?/gi },
    { source: "Decanter", regex: /(?:Decanter|DWWA)[^0-9]{0,14}([8-9][0-9]|100)(?:\+)?/gi }
  ];

  const rows = [];
  for (const rule of patterns) {
    for (const match of text.matchAll(rule.regex)) {
      const score = Number(match[1]);
      if (!Number.isFinite(score)) {
        continue;
      }
      rows.push({
        source: rule.source,
        year: findYearNear(text, match.index),
        score,
        scale: 100,
        note: null
      });
    }
  }

  for (const match of text.matchAll(/\b([8-9][0-9]|100)(?:\+)?\s*(?:\/\s*100|\s*(?:pts?|points?|点|ポイント))\b/gi)) {
    const score = Number(match[1]);
    if (!Number.isFinite(score)) {
      continue;
    }
    rows.push({
      source: "Critic",
      year: findYearNear(text, match.index),
      score,
      scale: 100,
      note: null
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${String(row.source || "").toLowerCase()}-${String(row.year || "")}-${String(row.score)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
    if (deduped.length >= 8) {
      break;
    }
  }
  return deduped;
};

const parseAwardsFromText = (value) => {
  const text = String(value || "");
  if (!text.trim()) {
    return [];
  }

  const candidates = [];
  const matched = [...text.matchAll(/[^。.!?\n]{0,90}(?:受賞|金賞|銀賞|銅賞|トロフィー|Best|Award|Trophy|Medal|Top\s*100|IWC|IWSC|Decanter)[^。.!?\n]{0,120}/giu)];
  for (const match of matched) {
    const name = truncateText(String(match[0] || "").replace(/\s+/g, " ").trim(), 140);
    if (!name) {
      continue;
    }
    const yearMatch = name.match(/\b((?:19|20)\d{2})\b/);
    candidates.push({
      name,
      year: yearMatch ? yearMatch[1] : null,
      note: null
    });
  }

  if (candidates.length === 0) {
    const splitted = text
      .split(/[\/|]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6);
    for (const item of splitted) {
      const yearMatch = item.match(/\b((?:19|20)\d{2})\b/);
      candidates.push({
        name: truncateText(item, 140),
        year: yearMatch ? yearMatch[1] : null,
        note: null
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = String(item.name || "").toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= 6) {
      break;
    }
  }
  return deduped;
};

const parsePriceHintValue = (value) => {
  const matched = String(value || "")
    .trim()
    .match(/\b(JPY|USD|EUR)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!matched) {
    return null;
  }

  const currency = String(matched[1] || "").toUpperCase();
  const amountRaw = String(matched[2] || "").replace(/,/g, "");
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return { currency, amount };
};

const formatPriceAmount = (value) => {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (Math.abs(value - Math.round(value)) < 0.0001) {
    return Math.round(value).toLocaleString("en-US");
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
};

const buildMarketPriceFromHints = (priceHints = []) => {
  const parsed = priceHints.map((item) => parsePriceHintValue(item)).filter(Boolean);
  if (!parsed.length) {
    return "不明";
  }

  const grouped = new Map();
  for (const item of parsed) {
    if (!grouped.has(item.currency)) {
      grouped.set(item.currency, []);
    }
    grouped.get(item.currency).push(item.amount);
  }

  const selectedCurrency = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
  const values = [...(grouped.get(selectedCurrency) || [])].sort((a, b) => a - b);
  if (!values.length) {
    return "不明";
  }

  const min = values[0];
  const max = values[values.length - 1];
  if (values.length === 1) {
    return `参考: ${selectedCurrency} ${formatPriceAmount(min)}`;
  }

  const relativeGap = min > 0 ? Math.abs(max - min) / min : 1;
  if (relativeGap <= 0.06) {
    return `参考: ${selectedCurrency} ${formatPriceAmount((min + max) / 2)}`;
  }
  return `参考レンジ: ${selectedCurrency} ${formatPriceAmount(min)} - ${formatPriceAmount(max)}`;
};

const asNullableWineField = (value) => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return null;
  }
  const lowered = text.toLowerCase();
  if (["不明", "unknown", "n/a", "na", "none", "null", "未確認", "未取得"].includes(text) || ["unknown", "n/a", "na", "none", "null"].includes(lowered)) {
    return null;
  }
  return text;
};

const extractVintageFromTexts = (...values) => {
  const merged = values
    .map((value) => String(value || ""))
    .join(" ");
  const match = merged.match(/\b((?:19|20)\d{2})\b/);
  return match ? match[1] : null;
};

const splitVarietyNames = (value) =>
  dedupeTextArray(
    String(value || "")
      .split(/[,/、・|]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => !["不明", "unknown", "none"].includes(item.toLowerCase ? item.toLowerCase() : item))
  ).slice(0, 6);

const parsePercentFromNearbyText = (text, anchorIndex, maxDistance = 22) => {
  const body = String(text || "");
  if (!body) {
    return null;
  }
  let best = null;
  for (const match of body.matchAll(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      continue;
    }
    const index = Number(match.index || 0);
    const distance = Math.abs(index - Number(anchorIndex || 0));
    if (distance > maxDistance) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = { value, distance, index };
    }
  }
  return best;
};

const normalizeGrapeComposition = (items = []) => {
  const normalized = [];
  const seen = new Set();
  for (const item of items) {
    const name = asNullableWineField(item?.name);
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const percentageRaw = Number(item?.percentage);
    normalized.push({
      name,
      percentage: Number.isFinite(percentageRaw) && percentageRaw > 0 && percentageRaw <= 100 ? percentageRaw : null
    });
  }

  const percentages = normalized.map((item) => item.percentage).filter((value) => Number.isFinite(value));
  if (percentages.length >= 2) {
    const total = percentages.reduce((sum, value) => sum + value, 0);
    if (total > 105) {
      // If total percentage is clearly impossible, keep grape names only.
      return normalized.map((item) => ({ ...item, percentage: null }));
    }
  }
  return normalized.slice(0, 8);
};

const normalizeSummaryGrapes = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return normalizeGrapeComposition(
    value
      .map((item) => {
        if (typeof item === "string") {
          const name = asNullableWineField(item);
          return name ? { name, percentage: null } : null;
        }
        const name = asNullableWineField(item?.name);
        if (!name) {
          return null;
        }
        const percentage = Number(item?.percentage);
        return {
          name,
          percentage: Number.isFinite(percentage) && percentage > 0 && percentage <= 100 ? percentage : null
        };
      })
      .filter(Boolean)
  );
};

const formatSummaryVarietiesFromGrapes = (grapes = []) => {
  const normalized = normalizeGrapeComposition(grapes);
  if (!normalized.length) {
    return "不明";
  }
  return normalized
    .map((item) =>
      Number.isFinite(Number(item.percentage)) && Number(item.percentage) > 0
        ? `${item.name} (${item.percentage}%)`
        : item.name
    )
    .join(", ");
};

const extractGrapeCompositionFromText = (value) => {
  const text = String(value || "");
  if (!text.trim()) {
    return [];
  }

  const hits = [];
  for (const entry of grapeVarietyPatterns) {
    for (const pattern of entry.patterns) {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      const regex = new RegExp(pattern.source, flags);
      for (const match of text.matchAll(regex)) {
        const index = Number(match.index || 0);
        const near = parsePercentFromNearbyText(text, index);
        hits.push({
          name: entry.label,
          percentage: near ? near.value : null,
          distance: near ? near.distance : Number.POSITIVE_INFINITY,
          index
        });
      }
    }
  }

  const sorted = hits.sort((a, b) => a.index - b.index);
  const byName = new Map();
  for (const row of sorted) {
    const key = row.name.toLowerCase();
    const current = byName.get(key);
    if (!current) {
      byName.set(key, row);
      continue;
    }
    if (current.percentage === null && row.percentage !== null) {
      byName.set(key, row);
      continue;
    }
    if (current.percentage !== null && row.percentage !== null && row.distance < current.distance) {
      byName.set(key, row);
    }
  }

  const merged = [...byName.values()]
    .sort((a, b) => a.index - b.index)
    .map((item) => ({
      name: item.name,
      percentage: item.percentage
    }));
  return normalizeGrapeComposition(merged);
};

const buildGrapeCompositionFromEvidence = ({ rawGrapes = [], evidenceTexts = [], preferRawOnly = false }) => {
  const rawNormalized = normalizeGrapeComposition(rawGrapes);
  if (preferRawOnly && rawNormalized.length > 0) {
    return rawNormalized;
  }
  const fromEvidence = normalizeGrapeComposition(
    (evidenceTexts || [])
      .flatMap((text) => extractGrapeCompositionFromText(text))
      .slice(0, 24)
  );

  if (fromEvidence.length === 0) {
    return rawNormalized;
  }

  const resultMap = new Map(fromEvidence.map((item) => [item.name.toLowerCase(), item]));
  for (const raw of rawNormalized) {
    const key = raw.name.toLowerCase();
    if (!resultMap.has(key)) {
      resultMap.set(key, { name: raw.name, percentage: raw.percentage });
    } else {
      const existing = resultMap.get(key);
      if (existing.percentage === null && raw.percentage !== null) {
        resultMap.set(key, { name: existing.name, percentage: raw.percentage });
      }
    }
  }
  return normalizeGrapeComposition([...resultMap.values()]);
};

const inferWineTypeFromTexts = (...values) => {
  const normalized = normalizeSearchText(values.map((value) => String(value || "")).join(" "));
  if (!normalized) {
    return null;
  }
  if (/\bsparkling\b|シャンパーニュ|スパークリング/.test(normalized)) {
    return "sparkling";
  }
  if (/\brose\b|ロゼ/.test(normalized)) {
    return "rose";
  }
  if (/\bwhite\b|白ワイン|blanc/.test(normalized)) {
    return "white";
  }
  if (/\bred\b|赤ワイン|rouge/.test(normalized)) {
    return "red";
  }
  if (/\bdessert\b|甘口|late harvest|ice wine/.test(normalized)) {
    return "dessert";
  }
  if (/\bfortified\b|ポート|シェリー|マデイラ/.test(normalized)) {
    return "fortified";
  }
  return null;
};

const inferCountryFromRegionText = (...values) => {
  const text = normalizeSearchText(values.map((value) => String(value || "")).join(" "));
  if (!text) {
    return null;
  }

  const countryRules = [
    { country: "France", patterns: [/france/, /bordeaux/, /bourgogne/, /burgundy/, /champagne/, /rhone/, /ローヌ/, /フランス/] },
    { country: "Italy", patterns: [/italy/, /toscana/, /piemonte/, /veneto/, /italia/, /イタリア/] },
    { country: "Spain", patterns: [/spain/, /rioja/, /ribera/, /priorat/, /espa(na|ña)/, /スペイン/] },
    { country: "United States", patterns: [/united states/, /\busa\b/, /california/, /napa/, /sonoma/, /アメリカ/] },
    { country: "Chile", patterns: [/chile/, /チリ/] },
    { country: "Argentina", patterns: [/argentina/, /アルゼンチン/] },
    { country: "Australia", patterns: [/australia/, /barossa/, /mclaren vale/, /オーストラリア/] },
    { country: "New Zealand", patterns: [/new zealand/, /marlborough/, /ニュージーランド/] },
    { country: "Germany", patterns: [/germany/, /mosel/, /rheingau/, /ドイツ/] },
    { country: "Portugal", patterns: [/portugal/, /douro/, /ポルトガル/] }
  ];

  for (const rule of countryRules) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return rule.country;
    }
  }
  return null;
};

const parseMarketPriceRange = (value) => {
  const text = asNullableWineField(value);
  if (!text) {
    return null;
  }

  const rangeMatch = text.match(/\b(JPY|USD|EUR)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:-|–|〜|~|to)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (rangeMatch) {
    const currency = String(rangeMatch[1] || "").toUpperCase();
    const min = Number(String(rangeMatch[2] || "").replace(/,/g, ""));
    const max = Number(String(rangeMatch[3] || "").replace(/,/g, ""));
    if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0) {
      return {
        min: Math.min(min, max),
        max: Math.max(min, max),
        currency,
        note: text
      };
    }
  }

  const single = parsePriceHintValue(text);
  if (single) {
    return {
      min: single.amount,
      max: single.amount,
      currency: single.currency,
      note: text
    };
  }

  const yenRange = text.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:円|¥|￥)\s*(?:-|–|〜|~|to)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:円|¥|￥)?/i);
  if (yenRange) {
    const min = Number(String(yenRange[1] || "").replace(/,/g, ""));
    const max = Number(String(yenRange[2] || "").replace(/,/g, ""));
    if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0) {
      return {
        min: Math.min(min, max),
        max: Math.max(min, max),
        currency: "JPY",
        note: text
      };
    }
  }
  return null;
};

const inferMarketPositionFromPriceRange = (priceRange) => {
  if (!priceRange || !Number.isFinite(priceRange.min)) {
    return null;
  }
  const currency = String(priceRange.currency || "").toUpperCase();
  const min = Number(priceRange.min);
  if (currency === "JPY") {
    if (min >= 50000) {
      return "ラグジュアリー";
    }
    if (min >= 15000) {
      return "プレミアム";
    }
    if (min >= 7000) {
      return "ミドルレンジ";
    }
    return "デイリー〜ミドル";
  }
  if (currency === "USD") {
    if (min >= 250) {
      return "ラグジュアリー";
    }
    if (min >= 80) {
      return "プレミアム";
    }
    if (min >= 30) {
      return "ミドルレンジ";
    }
    return "デイリー〜ミドル";
  }
  return null;
};

const inferAvailabilityInJapan = (webCandidates = []) => {
  if (!Array.isArray(webCandidates) || webCandidates.length === 0) {
    return "not_found";
  }
  const hasJapanSignals = webCandidates.some((item) => {
    const url = String(item?.url || "");
    const host = extractHostname(url);
    return (
      host.endsWith(".jp") ||
      host.includes(".co.jp") ||
      /\/ja(\/|$)|lang=ja|currency=JPY/i.test(url)
    );
  });
  return hasJapanSignals ? "confirmed" : "possible";
};

const buildWineSources = (webCandidates = []) =>
  (Array.isArray(webCandidates) ? webCandidates : [])
    .slice(0, 6)
    .map((item) => {
      const title = truncateText(String(item?.title || "").trim() || "source", 120);
      const url = String(item?.url || "").trim();
      const sourceLabel = asSourceDisplayName(url);
      return {
        title,
        url,
        reason: `${sourceLabel} で同名/近似銘柄情報を確認`
      };
    })
    .filter((item) => item.title && item.url && /^https?:\/\//i.test(item.url));

const inferTastingProfileFromSummary = (summary = {}) => {
  const combined = normalizeSearchText(`${summary?.taste || ""} ${summary?.features || ""}`);
  const body =
    /full|力強|重め/.test(combined) ? "full" : /light|軽やか/.test(combined) ? "light" : /medium|中程度/.test(combined) ? "medium" : null;
  const acidity =
    /高い酸|high acidity|fresh|フレッシュ/.test(combined)
      ? "high"
      : /穏やかな酸|low acidity|まろやか/.test(combined)
        ? "low"
        : /medium/.test(combined)
          ? "medium"
          : null;
  const tannin =
    /タンニン.*強|tannic|firm tannin/.test(combined)
      ? "high"
      : /タンニン.*穏|soft tannin/.test(combined)
        ? "low"
        : /medium/.test(combined)
          ? "medium"
          : null;
  const fruitCharacter =
    /赤系果実|red fruit/.test(combined)
      ? "red fruit"
      : /黒系果実|black fruit/.test(combined)
        ? "black fruit"
        : /柑橘|citrus/.test(combined)
          ? "citrus"
          : null;
  const oakCharacter = /オーク|樽|oak|vanilla/.test(combined) ? "oak-influenced" : null;
  const notableNotes = dedupeTextArray(
    [`${summary?.features || ""}`]
      .flatMap((item) => String(item || "").split(/[,、]/))
      .map((item) => item.trim())
      .filter(Boolean)
  ).slice(0, 6);

  return {
    body,
    acidity,
    tannin,
    alcohol_impression: null,
    fruit_character: fruitCharacter,
    oak_character: oakCharacter,
    notable_notes: notableNotes
  };
};

const emptyWineAnalysisResult = () => ({
  identified_wine: false,
  wine_name: null,
  producer: null,
  winery_history: null,
  vintage: null,
  country: null,
  region: null,
  appellation: null,
  grapes: [],
  wine_type: null,
  style_summary: null,
  tasting_profile: {
    body: null,
    acidity: null,
    tannin: null,
    alcohol_impression: null,
    fruit_character: null,
    oak_character: null,
    notable_notes: []
  },
  critic_scores: [],
  awards: [],
  market_position: null,
  availability_japan: null,
  price_range: null,
  confidence: "low",
  sources: []
});

const computeWineConfidence = (item) => {
  let score = 0;
  if (item.wine_name) {
    score += 2;
  }
  if (item.producer) {
    score += 1;
  }
  if (item.winery_history) {
    score += 1;
  }
  if (item.country || item.region) {
    score += 1;
  }
  if (item.grapes.length > 0) {
    score += 1;
  }
  if (item.critic_scores.length > 0) {
    score += 1;
  }
  if (item.awards.length > 0) {
    score += 1;
  }
  if (item.sources.length >= 3) {
    score += 2;
  } else if (item.sources.length > 0) {
    score += 1;
  }
  if (item.price_range) {
    score += 1;
  }
  if (score >= 6) {
    return "high";
  }
  if (score >= 3) {
    return "medium";
  }
  return "low";
};

const toJpyAmount = (amount, currency) => {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const unit = String(currency || "").toUpperCase();
  if (unit === "JPY" || !unit) {
    return value;
  }
  if (unit === "USD") {
    return value * pricingConfig.usdToJpy;
  }
  if (unit === "EUR") {
    return value * pricingConfig.eurToJpy;
  }
  return null;
};

const buildJpyPriceRangeInfo = (priceRange) => {
  if (!priceRange) {
    return { minJpy: null, maxJpy: null, note: null };
  }
  const minJpy = toJpyAmount(priceRange.min, priceRange.currency);
  const maxJpy = toJpyAmount(priceRange.max, priceRange.currency);
  if (Number.isFinite(minJpy) && Number.isFinite(maxJpy)) {
    const sourceCurrency = String(priceRange.currency || "").toUpperCase();
    const note =
      sourceCurrency && sourceCurrency !== "JPY"
        ? `${sourceCurrency}→JPY換算 (USD=${pricingConfig.usdToJpy}, EUR=${pricingConfig.eurToJpy})`
        : "JPY";
    return {
      minJpy: Math.round(Math.min(minJpy, maxJpy)),
      maxJpy: Math.round(Math.max(minJpy, maxJpy)),
      note
    };
  }

  const noteText = String(priceRange.note || "");
  for (const match of noteText.matchAll(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:円|¥|￥)/gi)) {
    const amount = Number(String(match[1] || "").replace(/,/g, ""));
    if (Number.isFinite(amount) && amount > 0) {
      return {
        minJpy: Math.round(amount),
        maxJpy: Math.round(amount),
        note: "JPY"
      };
    }
  }
  return { minJpy: null, maxJpy: null, note: null };
};

const formatJpyRangeText = (minJpy, maxJpy) => {
  if (!Number.isFinite(minJpy) || !Number.isFinite(maxJpy) || minJpy <= 0 || maxJpy <= 0) {
    return "不明（円換算不可）";
  }
  if (Math.abs(minJpy - maxJpy) < 1) {
    return `${Math.round(minJpy).toLocaleString("ja-JP")}円`;
  }
  return `${Math.round(Math.min(minJpy, maxJpy)).toLocaleString("ja-JP")}円 - ${Math.round(Math.max(minJpy, maxJpy)).toLocaleString("ja-JP")}円`;
};

const normalizeWineAnalysisResult = (rawValue, fallbackValue = null, options = {}) => {
  const base = fallbackValue ? { ...fallbackValue } : emptyWineAnalysisResult();
  const raw = rawValue && typeof rawValue === "object" ? rawValue : {};
  const evidenceTexts = Array.isArray(options?.evidenceTexts) ? options.evidenceTexts : [];
  const wineTypeSet = new Set(["red", "white", "rose", "sparkling", "dessert", "fortified"]);
  const availabilitySet = new Set(["confirmed", "possible", "not_found"]);
  const confidenceSet = new Set(["high", "medium", "low"]);

  const normalizeString = (value) => asNullableWineField(value);
  const normalizeNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  const hasRawGrapes = Array.isArray(raw.grapes) && raw.grapes.length > 0;
  const rawGrapes = hasRawGrapes
    ? raw.grapes
        .map((item) => {
          const name = asNullableWineField(item?.name);
          if (!name) {
            return null;
          }
          const percentage = normalizeNumber(item?.percentage);
          return {
            name,
            percentage: percentage !== null && percentage > 0 && percentage <= 100 ? percentage : null
          };
        })
        .filter(Boolean)
        .slice(0, 8)
    : base.grapes;
  const grapes = buildGrapeCompositionFromEvidence({
    rawGrapes,
    evidenceTexts,
    preferRawOnly: hasRawGrapes
  });

  const rawPriceRange = raw.price_range && typeof raw.price_range === "object" ? raw.price_range : null;
  const priceRange =
    rawPriceRange
      ? {
          min: normalizeNumber(rawPriceRange.min),
          max: normalizeNumber(rawPriceRange.max),
          currency: asNullableWineField(rawPriceRange.currency)
            ? String(rawPriceRange.currency).toUpperCase()
            : null,
          note: asNullableWineField(rawPriceRange.note)
        }
      : base.price_range;

  const tasting = raw.tasting_profile && typeof raw.tasting_profile === "object" ? raw.tasting_profile : {};
  const tastingProfile = {
    body: normalizeString(tasting.body ?? base.tasting_profile.body),
    acidity: normalizeString(tasting.acidity ?? base.tasting_profile.acidity),
    tannin: normalizeString(tasting.tannin ?? base.tasting_profile.tannin),
    alcohol_impression: normalizeString(tasting.alcohol_impression ?? base.tasting_profile.alcohol_impression),
    fruit_character: normalizeString(tasting.fruit_character ?? base.tasting_profile.fruit_character),
    oak_character: normalizeString(tasting.oak_character ?? base.tasting_profile.oak_character),
    notable_notes: dedupeTextArray(
      (Array.isArray(tasting.notable_notes) ? tasting.notable_notes : base.tasting_profile.notable_notes || [])
        .map((note) => String(note || "").trim())
        .filter(Boolean)
    ).slice(0, 8)
  };

  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .map((item) => {
          const title = String(item?.title || "").trim();
          const url = String(item?.url || "").trim();
          const reason = String(item?.reason || "").trim();
          if (!title || !url || !reason || !/^https?:\/\//i.test(url)) {
            return null;
          }
          return {
            title: truncateText(title, 140),
            url,
            reason: truncateText(reason, 180)
          };
        })
        .filter(Boolean)
        .slice(0, 6)
    : base.sources;

  const criticScores =
    Array.isArray(raw.critic_scores)
      ? raw.critic_scores
          .map((item) => {
            const source = asNullableWineField(item?.source);
            if (!source) {
              return null;
            }
            const score = normalizeNumber(item?.score);
            const scale = normalizeNumber(item?.scale);
            const year = asNullableWineField(item?.year);
            const note = asNullableWineField(item?.note);
            return {
              source,
              year,
              score,
              scale,
              note
            };
          })
          .filter(Boolean)
          .slice(0, 8)
      : parseCriticScoresFromText(raw.rating_points || "").length > 0
        ? parseCriticScoresFromText(raw.rating_points || "")
        : base.critic_scores;

  const awards =
    Array.isArray(raw.awards)
      ? raw.awards
          .map((item) => {
            const name = asNullableWineField(item?.name);
            if (!name) {
              return null;
            }
            const year = asNullableWineField(item?.year);
            const note = asNullableWineField(item?.note);
            return {
              name,
              year,
              note
            };
          })
          .filter(Boolean)
          .slice(0, 6)
      : parseAwardsFromText(raw.awards || "").length > 0
        ? parseAwardsFromText(raw.awards || "")
        : base.awards;

  const normalized = {
    identified_wine: Boolean(raw.identified_wine ?? base.identified_wine),
    wine_name: normalizeString(raw.wine_name ?? base.wine_name),
    producer: normalizeString(raw.producer ?? base.producer),
    winery_history: normalizeString(raw.winery_history ?? base.winery_history),
    vintage: normalizeString(raw.vintage ?? base.vintage),
    country: normalizeString(raw.country ?? base.country),
    region: normalizeString(raw.region ?? base.region),
    appellation: normalizeString(raw.appellation ?? base.appellation),
    grapes,
    wine_type: wineTypeSet.has(raw.wine_type) ? raw.wine_type : base.wine_type,
    style_summary: normalizeString(raw.style_summary ?? base.style_summary),
    tasting_profile: tastingProfile,
    critic_scores: criticScores,
    awards,
    market_position: normalizeString(raw.market_position ?? base.market_position),
    availability_japan: availabilitySet.has(raw.availability_japan) ? raw.availability_japan : base.availability_japan,
    price_range: priceRange,
    confidence: confidenceSet.has(raw.confidence) ? raw.confidence : "low",
    sources
  };

  if (normalized.price_range) {
    const converted = buildJpyPriceRangeInfo(normalized.price_range);
    if (Number.isFinite(converted.minJpy) && Number.isFinite(converted.maxJpy)) {
      normalized.price_range = {
        min: converted.minJpy,
        max: converted.maxJpy,
        currency: "JPY",
        note: converted.note || normalized.price_range.note
      };
    }
  }

  if (!normalized.wine_name && !normalized.producer && normalized.sources.length === 0) {
    normalized.identified_wine = false;
  } else if (normalized.wine_name || normalized.producer) {
    normalized.identified_wine = true;
  }

  if (!confidenceSet.has(raw.confidence)) {
    normalized.confidence = computeWineConfidence(normalized);
  }

  return normalized;
};

const buildWineAnalysisFallback = ({ query, summary, webCandidates, ocrText = "", webContextText = "" }) => {
  const wineName = asNullableWineField(query);
  const producer = asNullableWineField(summary?.producer);
  const region = asNullableWineField(summary?.region);
  const country = inferCountryFromRegionText(region, query, ocrText);
  const vintage = extractVintageFromTexts(query, ocrText);
  const summaryGrapes = normalizeSummaryGrapes(summary?.grapes);
  const grapes =
    summaryGrapes.length > 0
      ? summaryGrapes
      : buildGrapeCompositionFromEvidence({
          rawGrapes: [],
          evidenceTexts: [ocrText, webContextText]
        });
  const priceRange = parseMarketPriceRange(summary?.market_price);
  const tastingProfile = inferTastingProfileFromSummary(summary || {});
  const styleSummary = asNullableWineField(summary?.taste)
    ? [summary?.taste, summary?.features].filter(Boolean).join(" / ")
    : asNullableWineField(summary?.features);
  const sources = buildWineSources(webCandidates);
  const criticScores = parseCriticScoresFromText(summary?.rating_points || "");
  const awards = parseAwardsFromText(summary?.awards || "");

  const fallback = {
    identified_wine: Boolean(wineName || producer || sources.length > 0),
    wine_name: wineName,
    producer,
    winery_history: asNullableWineField(summary?.winery_history),
    vintage,
    country,
    region,
    appellation: region,
    grapes,
    wine_type: inferWineTypeFromTexts(query, ocrText, summary?.taste, summary?.features),
    style_summary: styleSummary,
    tasting_profile: tastingProfile,
    critic_scores: criticScores,
    awards,
    market_position: inferMarketPositionFromPriceRange(priceRange),
    availability_japan: inferAvailabilityInJapan(webCandidates),
    price_range: priceRange,
    confidence: "medium",
    sources
  };
  return normalizeWineAnalysisResult(fallback, null, {
    evidenceTexts: [ocrText, webContextText]
  });
};

const wineAnalysisOutputGuide = {
  identified_wine: true,
  wine_name: "string|null",
  producer: "string|null",
  winery_history: "string|null",
  vintage: "string|null",
  country: "string|null",
  region: "string|null",
  appellation: "string|null",
  grapes: [{ name: "string", percentage: "number|null" }],
  wine_type: "red|white|rose|sparkling|dessert|fortified|null",
  style_summary: "string|null",
  tasting_profile: {
    body: "string|null",
    acidity: "string|null",
    tannin: "string|null",
    alcohol_impression: "string|null",
    fruit_character: "string|null",
    oak_character: "string|null",
    notable_notes: ["string"]
  },
  critic_scores: [{ source: "string", year: "string|null", score: "number|null", scale: "number|null", note: "string|null" }],
  awards: [{ name: "string", year: "string|null", note: "string|null" }],
  market_position: "string|null",
  availability_japan: "confirmed|possible|not_found|null",
  price_range: {
    min: "number|null",
    max: "number|null",
    currency: "string|null",
    note: "string|null"
  },
  confidence: "high|medium|low",
  sources: [{ title: "string", url: "string", reason: "string" }]
};

const requestGroqWineAnalysisFromImage = async ({
  imageBuffer = null,
  contentType = "",
  ocrText = "",
  query,
  webContextText = "",
  webCandidates = [],
  summary = {}
}) => {
  const provider = resolveActiveLlmProvider();
  if (!provider || !isWineFlowEnabledForProvider(provider)) {
    return null;
  }
  const flowConfig = provider === "gemini" ? geminiWineFlowConfig : groqWineFlowConfig;
  const includeImageInput = provider === "groq";
  const maxImageBytes = groqVisionConfig.maxImageBytes;

  const fallback = buildWineAnalysisFallback({
    query,
    summary,
    webCandidates,
    ocrText,
    webContextText
  });

  const promptText =
    `OCR text:\n${truncateText(ocrText, 700)}\n\n` +
    `Query candidate: ${query}\n\n` +
    `Web evidence:\n${truncateText(webContextText, 2600)}\n\n` +
    `Known summary:\n${JSON.stringify(summary)}\n\n` +
    `Candidate URLs:\n${(webCandidates || [])
      .slice(0, 6)
      .map((item) => `- ${item.title}\n  ${item.url}`)
      .join("\n")}\n\n` +
    `Output JSON shape exactly like:\n${JSON.stringify(wineAnalysisOutputGuide, null, 2)}`;

  const systemPrompt =
    "You are a wine research analyst. Read label clues, then use provided web evidence only. Return strict JSON only. Do not add keys outside the requested shape. Unknown fields must be null. Include winery_history as a brief factual note when evidence exists. Include critic_scores (e.g., Robert Parker/WA, James Suckling, WS, WE) and awards when evidence exists. For critic_scores and awards, include year when available. For grape percentages, use percentages only when explicitly shown in evidence; never guess split ratios; never output 0%.";

  let imagePart = null;
  if (includeImageInput && imageBuffer && imageBuffer.length > 0 && imageBuffer.length <= maxImageBytes) {
    const mimeType = asGroqVisionContentType(contentType);
    if (mimeType) {
      imagePart = {
        mimeType,
        data: imageBuffer.toString("base64")
      };
    }
  }

  try {
    let content = "";
    if (provider === "gemini") {
      content = await requestGeminiGenerateText({
        model: flowConfig.analysisModel,
        systemPrompt,
        userPrompt: promptText,
        temperature: 0.1,
        maxOutputTokens: 900,
        timeoutMs: flowConfig.timeoutMs
      });
    } else {
      const userContent = [
        {
          type: "text",
          text: promptText
        }
      ];
      if (imagePart?.mimeType && imagePart?.data) {
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:${imagePart.mimeType};base64,${imagePart.data}`
          }
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), flowConfig.timeoutMs);
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqConfig.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: flowConfig.analysisModel,
            temperature: 0.1,
            max_tokens: 900,
            messages: [
              {
                role: "system",
                content: systemPrompt
              },
              {
                role: "user",
                content: userContent
              }
            ]
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`groq wine analysis request failed ${response.status}`);
        }
        const payload = await response.json();
        content = payload?.choices?.[0]?.message?.content || "";
      } finally {
        clearTimeout(timer);
      }
    }

    const parsed = parseJsonObjectFromText(content);
    if (!parsed || typeof parsed !== "object") {
      return fallback;
    }
    return normalizeWineAnalysisResult(parsed, fallback, {
      evidenceTexts: [ocrText, webContextText]
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn(`${provider} wine analysis timed out`);
      return fallback;
    }
    console.warn(`${provider} wine analysis failed`, error?.message || error);
    return fallback;
  }
};

const formatWinePriceRangeText = (priceRange) => {
  if (!priceRange) {
    return "不明（円換算不可）";
  }
  const converted = buildJpyPriceRangeInfo(priceRange);
  return formatJpyRangeText(converted.minJpy, converted.maxJpy);
};

const buildLineWineReplyFallback = (wineData) => {
  const confidencePrefixMap = {
    high: "かなり高い確率で",
    medium: "高い確率で",
    low: "候補としては"
  };
  const confidencePrefix = confidencePrefixMap[wineData.confidence] || confidencePrefixMap.low;
  const identity = wineData.wine_name || "銘柄特定はできませんでした";
  const producerRegion = [wineData.producer, wineData.region || wineData.country].filter(Boolean).join(" / ") || "不明";
  const wineryHistory = asNullableWineField(wineData.winery_history) || "不明";
  const grapesText =
    wineData.grapes.length > 0
      ? wineData.grapes
          .map((item) =>
            Number.isFinite(Number(item.percentage)) && Number(item.percentage) > 0
              ? `${item.name} (${item.percentage}%)`
              : item.name
          )
          .join(", ")
      : "不明";
  const tasteText =
    wineData.style_summary ||
    [wineData.tasting_profile.body, wineData.tasting_profile.fruit_character, wineData.tasting_profile.oak_character]
      .filter(Boolean)
      .join(", ") ||
    "不明";
  const criticScoreHistoryText =
    Array.isArray(wineData.critic_scores) && wineData.critic_scores.length > 0
      ? wineData.critic_scores
          .map((item) => {
            const source = item.source || "評価";
            const year = item.year ? `${item.year}年` : "年不明";
            const score = Number(item.score);
            const scale = Number(item.scale);
            if (Number.isFinite(score) && Number.isFinite(scale) && scale > 0) {
              return `${year} ${source} ${score}/${scale}`;
            }
            if (Number.isFinite(score)) {
              return `${year} ${source} ${score}`;
            }
            return `${year} ${source}`;
          })
          .join(" / ")
      : "不明";
  const awardsHistoryText =
    Array.isArray(wineData.awards) && wineData.awards.length > 0
      ? wineData.awards
          .map((item) => {
            const name = item.name || "";
            const year = item.year ? `${item.year}年` : "年不明";
            return `${year} ${name}`.trim();
          })
          .filter(Boolean)
          .join(" / ")
      : "不明";
  const criticAwardsText =
    criticScoreHistoryText === "不明" && awardsHistoryText === "不明"
      ? "不明"
      : `評価履歴: ${criticScoreHistoryText}${awardsHistoryText !== "不明" ? ` / 受賞履歴: ${awardsHistoryText}` : ""}`;

  return (
    `${confidencePrefix}「${identity}」です。\n` +
    `1. このワインの正体: ${identity}\n` +
    `2. 生産者・産地: ${producerRegion}\n` +
    `3. 生産者・ワイナリーの歴史: ${wineryHistory}\n` +
    `4. セパージュ: ${grapesText}\n` +
    `5. 味わい: ${tasteText}\n` +
    `6. 受賞・評価ポイント: ${criticAwardsText}\n` +
    `7. 価格帯(円): ${formatWinePriceRangeText(wineData.price_range)}`
  );
};

const sanitizeLineWineReplyText = (value) =>
  String(value || "")
    .split(/\r?\n/)
    .filter((line) => !/市場での立ち位置|日本での流通/.test(line))
    .join("\n")
    .trim();

const renderLineWineReplyWithGroq = async (wineData) => {
  const provider = resolveActiveLlmProvider();
  if (!provider || !isWineFlowEnabledForProvider(provider)) {
    return buildLineWineReplyFallback(wineData);
  }
  const flowConfig = provider === "gemini" ? geminiWineFlowConfig : groqWineFlowConfig;
  const systemPrompt =
    "あなたはワイン説明文をLINE向けに短く分かりやすくまとめるアシスタントです。与えられたJSONだけを根拠に日本語で説明してください。項目順は固定: 1.このワインの正体 2.生産者・産地 3.生産者・ワイナリーの歴史（1〜2文で簡潔） 4.セパージュ（複数ぶどうは比率付き。比率不明なら品種名のみ） 5.味わい 6.受賞・評価ポイント（必ず年付き履歴。例: 2020年 WA 96/100） 7.価格帯（必ず日本円）。「市場での立ち位置」「日本での流通」は書かない。誇張しない。JSONにない情報を書かない。";
  try {
    let content = "";
    if (provider === "gemini") {
      content = await requestGeminiGenerateText({
        model: flowConfig.replyModel,
        systemPrompt,
        userPrompt: JSON.stringify(wineData, null, 2),
        temperature: 0.2,
        maxOutputTokens: 420,
        timeoutMs: flowConfig.timeoutMs
      });
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), flowConfig.timeoutMs);
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqConfig.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: flowConfig.replyModel,
            temperature: 0.2,
            max_tokens: 420,
            messages: [
              {
                role: "system",
                content: systemPrompt
              },
              {
                role: "user",
                content: JSON.stringify(wineData, null, 2)
              }
            ]
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`groq line reply request failed ${response.status}`);
        }
        const payload = await response.json();
        content = String(payload?.choices?.[0]?.message?.content || "").trim();
      } finally {
        clearTimeout(timer);
      }
    }
    return sanitizeLineWineReplyText(content) || buildLineWineReplyFallback(wineData);
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn(`${provider} line reply timed out`);
      return buildLineWineReplyFallback(wineData);
    }
    console.warn(`${provider} line reply failed`, error?.message || error);
    return buildLineWineReplyFallback(wineData);
  }
};

const countTokenMatches = (value, contextText) => {
  const tokens = splitSearchTokens(value).filter(
    (token) =>
      ![
        "wine",
        "vin",
        "red",
        "white",
        "grand",
        "cru",
        "classico",
        "clasico",
        "vino"
      ].includes(token)
  );
  if (!tokens.length) {
    return { matched: 0, total: 0 };
  }
  const normalizedContext = normalizeSearchText(contextText);
  const matched = tokens.filter((token) => normalizedContext.includes(token)).length;
  return { matched, total: tokens.length };
};

const isUnknownSummaryField = (value) => {
  const text = String(value || "").trim();
  return !text || text === "不明";
};

const sanitizeSummaryWithEvidence = ({
  summary,
  contextText,
  priceHints,
  varietyHints,
  grapeCompositionHints,
  tasteHints,
  featureHints,
  ratingHints,
  awardHints,
  drinkingWindowHints,
  historyHints
}) => {
  const safe = {
    region: normalizeSummaryField(summary.region),
    producer: normalizeSummaryField(summary.producer),
    market_price: normalizeSummaryField(summary.market_price),
    grapes: normalizeSummaryGrapes(summary.grapes),
    varieties: normalizeVarieties(summary.varieties),
    taste: normalizeSummaryField(summary.taste),
    features: normalizeSummaryField(summary.features),
    rating_points: normalizeSummaryField(summary.rating_points),
    awards: normalizeSummaryField(summary.awards),
    drinking_window: normalizeSummaryField(summary.drinking_window),
    winery_history: normalizeSummaryField(summary.winery_history)
  };

  const regionMatch = countTokenMatches(safe.region, contextText);
  if (
    !isUnknownSummaryField(safe.region) &&
    regionMatch.total > 0 &&
    regionMatch.matched === 0
  ) {
    safe.region = "不明";
  }

  const producerMatch = countTokenMatches(safe.producer, contextText);
  if (
    !isUnknownSummaryField(safe.producer) &&
    producerMatch.total > 0 &&
    producerMatch.matched === 0
  ) {
    safe.producer = "不明";
  }

  const hintedMarketPrice = buildMarketPriceFromHints(priceHints);
  const parsedModelPrice = parsePriceHintValue(safe.market_price);
  const parsedHintPrices = priceHints.map((item) => parsePriceHintValue(item)).filter(Boolean);

  if (!parsedModelPrice) {
    safe.market_price = hintedMarketPrice;
  } else if (parsedHintPrices.length > 0) {
    const sameCurrency = parsedHintPrices.filter((item) => item.currency === parsedModelPrice.currency);
    if (!sameCurrency.length) {
      safe.market_price = hintedMarketPrice;
    } else {
      const closestGap = sameCurrency.reduce(
        (best, item) => Math.min(best, Math.abs(item.amount - parsedModelPrice.amount) / item.amount),
        Number.POSITIVE_INFINITY
      );
      if (!Number.isFinite(closestGap) || closestGap > 0.35) {
        safe.market_price = hintedMarketPrice;
      }
    }
  }

  const mergedStructuredGrapes = normalizeGrapeComposition([
    ...safe.grapes,
    ...(Array.isArray(grapeCompositionHints) ? grapeCompositionHints : []),
    ...(Array.isArray(varietyHints) ? varietyHints.map((name) => ({ name, percentage: null })) : [])
  ]);
  safe.grapes = mergedStructuredGrapes;
  safe.varieties = formatSummaryVarietiesFromGrapes(safe.grapes);

  const modelTasteHints = collectTasteHintsFromText(safe.taste);
  const mergedTaste = dedupeTextArray([...modelTasteHints, ...(tasteHints || [])]).slice(0, 5);
  if (mergedTaste.length > 0) {
    safe.taste = mergedTaste.join(", ");
  } else {
    const tasteMatch = countTokenMatches(safe.taste, contextText);
    safe.taste =
      !isUnknownSummaryField(safe.taste) && tasteMatch.total > 0 && tasteMatch.matched > 0
        ? safe.taste
        : "不明";
  }

  const modelFeatureHints = collectFeatureHintsFromText(safe.features);
  const mergedFeatures = dedupeTextArray([...modelFeatureHints, ...(featureHints || [])]).slice(0, 8);
  if (mergedFeatures.length > 0) {
    safe.features = mergedFeatures.join(", ");
  } else {
    const featureMatch = countTokenMatches(safe.features, contextText);
    safe.features =
      !isUnknownSummaryField(safe.features) && featureMatch.total > 0 && featureMatch.matched > 0
        ? safe.features
        : "不明";
  }

  const modelRatingHints = collectRatingHintsFromText(safe.rating_points);
  const mergedRatings = dedupeTextArray([...modelRatingHints, ...(ratingHints || [])]).slice(0, 6);
  if (mergedRatings.length > 0) {
    safe.rating_points = buildRatingPointsFromHints(mergedRatings);
  } else {
    const ratingMatch = countTokenMatches(safe.rating_points, contextText);
    safe.rating_points =
      !isUnknownSummaryField(safe.rating_points) && ratingMatch.total > 0 && ratingMatch.matched > 0
        ? safe.rating_points
        : "不明";
  }

  const modelAwardHints = collectAwardHintsFromText(safe.awards);
  const mergedAwards = dedupeTextArray([...modelAwardHints, ...(awardHints || [])]).slice(0, 5);
  if (mergedAwards.length > 0) {
    safe.awards = buildAwardsFromHints(mergedAwards);
  } else {
    const awardsMatch = countTokenMatches(safe.awards, contextText);
    safe.awards =
      !isUnknownSummaryField(safe.awards) && awardsMatch.total > 0 && awardsMatch.matched > 0
        ? safe.awards
        : "不明";
  }

  const modelDrinkingWindowHints = collectDrinkingWindowHintsFromText(safe.drinking_window);
  const mergedDrinkingWindow = dedupeTextArray([...modelDrinkingWindowHints, ...(drinkingWindowHints || [])]).slice(
    0,
    5
  );
  if (mergedDrinkingWindow.length > 0) {
    safe.drinking_window = buildDrinkingWindowFromHints(mergedDrinkingWindow);
  } else {
    const drinkingMatch = countTokenMatches(safe.drinking_window, contextText);
    safe.drinking_window =
      !isUnknownSummaryField(safe.drinking_window) &&
      ((drinkingMatch.total > 0 && drinkingMatch.matched > 0) || /(?:19|20)\d{2}/.test(safe.drinking_window))
        ? safe.drinking_window
        : "不明";
  }

  const modelHistoryHints = collectHistoryHintsFromText(safe.winery_history);
  const mergedHistory = dedupeTextArray([...modelHistoryHints, ...(historyHints || [])]).slice(0, 4);
  if (mergedHistory.length > 0) {
    safe.winery_history = buildWineryHistoryFromHints(mergedHistory);
  } else {
    const historyMatch = countTokenMatches(safe.winery_history, contextText);
    safe.winery_history =
      !isUnknownSummaryField(safe.winery_history) && historyMatch.total > 0 && historyMatch.matched > 0
        ? safe.winery_history
        : "不明";
  }

  return safe;
};

const parseWikipediaPageFromUrl = (urlText) => {
  try {
    const parsed = new URL(urlText);
    if (!parsed.hostname.endsWith("wikipedia.org")) {
      return null;
    }
    const marker = "/wiki/";
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) {
      return null;
    }
    const title = decodeURIComponent(parsed.pathname.slice(index + marker.length)).replace(/_/g, " ").trim();
    if (!title) {
      return null;
    }
    return {
      title,
      langHost: parsed.hostname
    };
  } catch (error) {
    return null;
  }
};

const fetchWikipediaSummary = async (urlText) => {
  const wiki = parseWikipediaPageFromUrl(urlText);
  if (!wiki) {
    return null;
  }

  const endpoint = `https://${wiki.langHost}/api/rest_v1/page/summary/${encodeURIComponent(wiki.title)}`;
  try {
    const payload = await fetchJsonWithTimeout(endpoint, webSearchConfig.timeoutMs);
    const title = String(payload?.title || wiki.title).trim();
    const description = String(payload?.description || "").trim();
    const extract = truncateText(payload?.extract || "", 500);
    if (!title && !extract) {
      return null;
    }
    return {
      title: title || wiki.title,
      description,
      extract
    };
  } catch (error) {
    return null;
  }
};

const fetchHtmlMetaSummary = async (urlText) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), webSearchConfig.timeoutMs);
  try {
    const response = await fetch(urlText, {
      method: "GET",
      headers: {
        "User-Agent": "line-wine-bot/1.0 (+https://line-wine-api.onrender.com)"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html")) {
      return null;
    }
    const html = String(await response.text());
    const compact = html.slice(0, 180000);
    const title =
      compact.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
    const description =
      compact
        .match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)?.[1]
        ?.replace(/\s+/g, " ")
        .trim() || "";
    const ogDescription =
      compact
        .match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)?.[1]
        ?.replace(/\s+/g, " ")
        .trim() || "";
    const jsonLdBlocks = [...compact.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
      .map((match) => String(match[1] || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 4);

    const plainText = compact
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const keywordMatches = plainText.match(
      /[^。.!?\n]{0,80}(?:セパージュ|品種|ブレンド|grape|blend|variet(?:y|ies)|composition|cépage|cabernet|merlot|tempranillo|pinot|chardonnay|sauvignon|garnacha|grenache|syrah|shiraz|graciano|mazuelo|malbec|sangiovese|nebbiolo|riesling|%|価格|price|market|円|¥|\$|€|味わい|香り|特徴|テイスティング|tasting|aroma|flavor|body|酸味|タンニン|評価|point|score|parker|wine advocate|james suckling|受賞|award|medal|trophy|飲み頃|drinking window|history|歴史|創業|設立|founded|established)[^。.!?\n]{0,120}/giu
    );
    const evidenceLines = [...(keywordMatches || []), ...jsonLdBlocks]
      .map((item) => truncateText(item, 220))
      .filter(Boolean)
      .slice(0, 8);

    if (!title && !description && !ogDescription && evidenceLines.length === 0) {
      return null;
    }
    return {
      title: truncateText(title, 140),
      description: truncateText(description || ogDescription, 280),
      evidenceText: evidenceLines.join(" / ")
    };
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const buildWebSummaryContext = async (webCandidates) => {
  const contextBlocks = [];
  const priceHints = [];
  const varietyHints = [];
  const grapeCompositionHints = [];
  const tasteHints = [];
  const featureHints = [];
  const ratingHints = [];
  const awardHints = [];
  const drinkingWindowHints = [];
  const historyHints = [];
  const seenUrl = new Set();

  for (const item of webCandidates.slice(0, webSearchConfig.summaryMaxSources)) {
    const url = String(item?.url || "").trim();
    if (!url || seenUrl.has(url)) {
      continue;
    }
    seenUrl.add(url);

    let title = String(item?.title || "").trim();
    let snippet = String(item?.snippet || "").trim();
    let sourceName = String(item?.source || "web").trim();

    const wikiSummary = await fetchWikipediaSummary(url);
    if (wikiSummary) {
      title = wikiSummary.title || title;
      snippet = [wikiSummary.description, wikiSummary.extract].filter(Boolean).join(" / ").trim() || snippet;
      sourceName = "wikipedia";
    } else {
      const metaSummary = await fetchHtmlMetaSummary(url);
      if (metaSummary) {
        title = metaSummary.title || title;
        snippet = [metaSummary.description, metaSummary.evidenceText]
          .filter(Boolean)
          .join(" / ")
          .trim() || snippet;
      }
    }

    const combined = [title, snippet].filter(Boolean).join("\n");
    if (combined) {
      contextBlocks.push(`[source=${sourceName}] ${url}\n${truncateText(combined, 420)}`);
      priceHints.push(...collectPriceHintsFromText(combined));
      varietyHints.push(...collectVarietyHintsFromText(combined));
      grapeCompositionHints.push(...extractGrapeCompositionFromText(combined));
      tasteHints.push(...collectTasteHintsFromText(combined));
      featureHints.push(...collectFeatureHintsFromText(combined));
      ratingHints.push(...collectRatingHintsFromText(combined));
      awardHints.push(...collectAwardHintsFromText(combined));
      drinkingWindowHints.push(...collectDrinkingWindowHintsFromText(combined));
      historyHints.push(...collectHistoryHintsFromText(combined));
    }
  }

  return {
    contextText: contextBlocks.join("\n\n"),
    priceHints: dedupeTextArray(priceHints).slice(0, 8),
    varietyHints: dedupeTextArray(varietyHints).slice(0, 8),
    grapeCompositionHints: normalizeGrapeComposition(grapeCompositionHints).slice(0, 8),
    tasteHints: dedupeTextArray(tasteHints).slice(0, 6),
    featureHints: dedupeTextArray(featureHints).slice(0, 10),
    ratingHints: dedupeTextArray(ratingHints).slice(0, 8),
    awardHints: dedupeTextArray(awardHints).slice(0, 6),
    drinkingWindowHints: dedupeTextArray(drinkingWindowHints).slice(0, 5),
    historyHints: dedupeTextArray(historyHints).slice(0, 4)
  };
};

const requestGroqWineSummaryFromWeb = async ({
  query,
  contextText,
  priceHints = [],
  varietyHints = [],
  grapeCompositionHints = [],
  tasteHints = [],
  featureHints = [],
  ratingHints = [],
  awardHints = [],
  drinkingWindowHints = [],
  historyHints = []
}) => {
  const provider = resolveActiveLlmProvider();
  if (!provider) {
    return null;
  }
  if (!contextText.trim()) {
    return null;
  }
  const systemPrompt =
    'Extract wine info from web context. Return strict JSON: {"region":"","producer":"","market_price":"","grapes":[{"name":"","percentage":null}],"taste":"","features":"","rating_points":"","awards":"","drinking_window":"","winery_history":""}. Use only evidence in context/hints. If uncertain, use "不明". Always return grapes as an array, do not return grape information as prose.';
  const userPrompt =
    `Query: ${query}\n\n` +
    `Web context:\n${truncateText(contextText, 3000)}\n\n` +
    `Price hints: ${priceHints.join(", ") || "none"}\n\n` +
    `Variety hints: ${varietyHints.join(", ") || "none"}\n\n` +
    `Grape composition hints (structured): ${JSON.stringify(grapeCompositionHints.slice(0, 8))}\n\n` +
    `Taste hints: ${tasteHints.join(", ") || "none"}\n\n` +
    `Feature hints: ${featureHints.join(", ") || "none"}\n\n` +
    `Rating hints: ${ratingHints.join(", ") || "none"}\n\n` +
    `Award hints: ${awardHints.join(", ") || "none"}\n\n` +
    `Drinking window hints: ${drinkingWindowHints.join(", ") || "none"}\n\n` +
    `Winery history hints: ${historyHints.join(", ") || "none"}\n\n` +
    "Return only JSON.";
  try {
    let content = "";
    if (provider === "gemini") {
      content = await requestGeminiGenerateText({
        model: geminiConfig.model,
        systemPrompt,
        userPrompt,
        temperature: 0.1,
        maxOutputTokens: 300,
        timeoutMs: geminiConfig.timeoutMs
      });
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), groqConfig.timeoutMs);
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqConfig.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: groqConfig.model,
            temperature: 0.1,
            max_tokens: 300,
            messages: [
              {
                role: "system",
                content: systemPrompt
              },
              {
                role: "user",
                content: userPrompt
              }
            ]
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`groq web summary request failed ${response.status}`);
        }
        const payload = await response.json();
        content = payload?.choices?.[0]?.message?.content || "";
      } finally {
        clearTimeout(timer);
      }
    }

    const parsed = parseJsonObjectFromText(content);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return sanitizeSummaryWithEvidence({
      summary: {
        region: normalizeSummaryField(parsed.region),
        producer: normalizeSummaryField(parsed.producer),
        market_price: normalizeSummaryField(parsed.market_price),
        grapes: normalizeSummaryGrapes(parsed.grapes),
        varieties: "不明",
        taste: normalizeSummaryField(parsed.taste),
        features: normalizeSummaryField(parsed.features),
        rating_points: normalizeSummaryField(parsed.rating_points),
        awards: normalizeSummaryField(parsed.awards),
        drinking_window: normalizeSummaryField(parsed.drinking_window),
        winery_history: normalizeSummaryField(parsed.winery_history)
      },
      contextText,
      priceHints,
      varietyHints,
      grapeCompositionHints,
      tasteHints,
      featureHints,
      ratingHints,
      awardHints,
      drinkingWindowHints,
      historyHints
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn(`${provider} web summary timed out`);
      return null;
    }
    console.warn(`${provider} web summary failed`, error?.message || error);
    return null;
  }
};

const extractSuggestionsFromGroqText = (content, maxCandidates = groqConfig.maxCandidates) => {
  const raw = String(content || "").trim();
  if (!raw) {
    return [];
  }

  const suggestions = [];
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const jsonCandidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      for (const item of jsonCandidates) {
        suggestions.push(String(item || ""));
      }
      for (const key of ["wine_name", "product_name", "normalized_name", "name"]) {
        if (parsed?.[key]) {
          suggestions.push(String(parsed[key]));
        }
      }
    } catch (error) {
      // ignore parse error and continue with line parsing
    }
  }

  const lineCandidates = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*0-9.)\s]+/, "").trim())
    .filter(Boolean);
  suggestions.push(...lineCandidates);

  const normalized = dedupeTextArray(
    suggestions
      .map((item) =>
        String(item || "")
          .replace(/^["'`]+|["'`]+$/g, "")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter((item) => item.length >= 4 && item.length <= 80)
      .filter((item) => !isLikelyNoiseLine(item))
  );
  const limit = Math.max(1, Number(maxCandidates) || groqConfig.maxCandidates);
  return normalized.slice(0, limit);
};

const requestGroqQuerySuggestions = async ({ ocrText, candidates }) => {
  const provider = resolveActiveLlmProvider();
  if (!provider) {
    return [];
  }
  const systemPrompt =
    'You correct OCR text into likely wine product names. Return compact JSON only: {"candidates":["name1","name2"]}';
  const userPrompt = `OCR text:\n${truncateText(ocrText, 800)}\n\nCurrent candidates:\n${candidates.join("\n")}\n\nReturn up to ${provider === "gemini" ? geminiConfig.maxCandidates : groqConfig.maxCandidates} corrected wine names.`;
  try {
    let content = "";
    if (provider === "gemini") {
      content = await requestGeminiGenerateText({
        model: geminiConfig.model,
        systemPrompt,
        userPrompt,
        temperature: 0.1,
        maxOutputTokens: 120,
        timeoutMs: geminiConfig.timeoutMs
      });
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), groqConfig.timeoutMs);
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqConfig.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: groqConfig.model,
            temperature: 0.1,
            max_tokens: 120,
            messages: [
              {
                role: "system",
                content: systemPrompt
              },
              {
                role: "user",
                content: userPrompt
              }
            ]
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`groq request failed ${response.status}`);
        }

        const payload = await response.json();
        content = payload?.choices?.[0]?.message?.content || "";
      } finally {
        clearTimeout(timer);
      }
    }
    return extractSuggestionsFromGroqText(content, provider === "gemini" ? geminiConfig.maxCandidates : groqConfig.maxCandidates);
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn(`${provider} suggestion timed out`);
      return [];
    }
    console.warn(`${provider} suggestion failed`, error?.message || error);
    return [];
  }
};

const asGroqVisionContentType = (contentType) => {
  const normalized = String(contentType || "").toLowerCase().trim();
  if (["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(normalized)) {
    return normalized === "image/jpg" ? "image/jpeg" : normalized;
  }
  return null;
};

const requestGroqVisionSuggestions = async ({ imageBuffer, contentType, ocrHint = "" }) => {
  const provider = resolveActiveVisionProvider();
  const visionEnabled = provider === "gemini" ? geminiVisionConfig.enabled : groqVisionConfig.enabled;
  if (!provider || !visionEnabled) {
    return [];
  }
  if (!imageBuffer || imageBuffer.length <= 0) {
    return [];
  }
  const maxImageBytes = provider === "gemini" ? geminiVisionConfig.maxImageBytes : groqVisionConfig.maxImageBytes;
  const maxCandidates = provider === "gemini" ? geminiVisionConfig.maxCandidates : groqVisionConfig.maxCandidates;
  if (imageBuffer.length > maxImageBytes) {
    console.warn(
      `Skip ${provider} vision: image too large (${imageBuffer.length} > ${maxImageBytes})`
    );
    return [];
  }

  const mimeType = asGroqVisionContentType(contentType);
  if (!mimeType) {
    console.warn(`Skip ${provider} vision: unsupported content type`, contentType);
    return [];
  }

  const promptText =
    `Find likely wine product names from this label image. Return up to ${maxCandidates} short candidates. ` +
    "Prefer official bottle label names in Latin letters when possible." +
    (ocrHint ? ` OCR hint: ${truncateText(ocrHint, 250)}` : "");
  try {
    let content = "";
    if (provider === "gemini") {
      content = await requestGeminiGenerateText({
        model: geminiVisionConfig.model,
        systemPrompt: 'Extract wine label names from images. Return strict JSON only: {"candidates":["name1","name2"]}',
        userPrompt: promptText,
        imagePart: {
          mimeType,
          data: imageBuffer.toString("base64")
        },
        temperature: 0.1,
        maxOutputTokens: 180,
        timeoutMs: geminiVisionConfig.timeoutMs
      });
    } else {
      const dataUrl = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), groqVisionConfig.timeoutMs);
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqConfig.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: groqVisionConfig.model,
            temperature: 0.1,
            max_tokens: 180,
            messages: [
              {
                role: "system",
                content:
                  'Extract wine label names from images. Return strict JSON only: {"candidates":["name1","name2"]}'
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: promptText
                  },
                  {
                    type: "image_url",
                    image_url: { url: dataUrl }
                  }
                ]
              }
            ]
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`groq vision request failed ${response.status}`);
        }

        const payload = await response.json();
        content = payload?.choices?.[0]?.message?.content || "";
      } finally {
        clearTimeout(timer);
      }
    }
    const candidates = extractSuggestionsFromGroqText(content);
    return candidates.slice(0, maxCandidates);
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn(`${provider} vision timed out`);
      return [];
    }
    console.warn(`${provider} vision failed`, error?.message || error);
    return [];
  }
};

const buildWebCandidateLines = (items) =>
  items
    .slice(0, webSearchConfig.maxResults)
    .map((item, index) => `${index + 1}. ${item.title}\n${item.url}`)
    .join("\n");

const mergeWebCandidatesByUrl = (baseItems, extraItems, maxItems = 12) => {
  const merged = [];
  const seen = new Set();

  for (const item of [...(baseItems || []), ...(extraItems || [])]) {
    const url = String(item?.url || "").trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    merged.push(item);
    if (merged.length >= maxItems) {
      break;
    }
  }
  return merged;
};

const enrichWebCandidatesForMissingFields = async ({ query, summary, existingCandidates }) => {
  const missingPrice = isUnknownSummaryField(summary?.market_price);
  const missingVarieties = !Array.isArray(summary?.grapes) || summary.grapes.length === 0;
  const missingTaste = isUnknownSummaryField(summary?.taste);
  const missingFeatures = isUnknownSummaryField(summary?.features);
  const missingRatings = isUnknownSummaryField(summary?.rating_points);
  const missingAwards = isUnknownSummaryField(summary?.awards);
  const missingDrinkingWindow = isUnknownSummaryField(summary?.drinking_window);
  const missingHistory = isUnknownSummaryField(summary?.winery_history);
  if (
    !missingPrice &&
    !missingVarieties &&
    !missingTaste &&
    !missingFeatures &&
    !missingRatings &&
    !missingAwards &&
    !missingDrinkingWindow &&
    !missingHistory
  ) {
    return existingCandidates;
  }

  const enrichmentQueries = [];
  if (missingPrice) {
    enrichmentQueries.push(`${query} 価格`, `${query} market price`, `${query} price`);
  }
  if (missingVarieties) {
    enrichmentQueries.push(
      `${query} セパージュ`,
      `${query} 品種`,
      `${query} grape variety`,
      `${query} blend`,
      `${query} blend percentage`,
      `${query} grape composition`
    );
  }
  if (missingTaste || missingFeatures) {
    enrichmentQueries.push(
      `${query} 味わい`,
      `${query} 特徴`,
      `${query} テイスティングノート`,
      `${query} tasting notes`,
      `${query} flavor profile`
    );
  }
  if (missingRatings) {
    enrichmentQueries.push(
      `${query} Parker points`,
      `${query} Wine Advocate score`,
      `${query} James Suckling score`,
      `${query} rating points`
    );
  }
  if (missingAwards) {
    enrichmentQueries.push(`${query} 受賞`, `${query} awards`, `${query} medal`, `${query} trophy`);
  }
  if (missingDrinkingWindow) {
    enrichmentQueries.push(`${query} 飲み頃`, `${query} drinking window`, `${query} best from`);
  }
  if (missingHistory) {
    enrichmentQueries.push(`${query} ワイナリー 歴史`, `${query} winery history`, `${query} founded`);
  }

  let merged = [...(existingCandidates || [])];
  const keepPriorityOnly = hasPriorityDomainCandidates(existingCandidates || []);

  const runEnrichment = async (allowBroadFallback) => {
    for (const extraQuery of dedupeTextArray(enrichmentQueries).slice(0, 6)) {
      try {
        const found = await searchWebCandidates(extraQuery, {
          fallbackToBroad: allowBroadFallback
        });
        merged = mergeWebCandidatesByUrl(merged, found, webSearchConfig.summaryMaxSources + 4);
        if (merged.length >= webSearchConfig.summaryMaxSources) {
          break;
        }
      } catch (error) {
        console.warn("Web enrichment search failed", extraQuery, error?.message || error);
      }
    }
  };

  await runEnrichment(!keepPriorityOnly);

  // If we only hit one prioritized source (e.g. only Wine-Searcher),
  // run one broad supplement pass to recover missing fields like grapes/tasting notes.
  if (keepPriorityOnly) {
    const uniqueHosts = new Set(
      merged
        .map((item) => extractHostname(item?.url || ""))
        .filter(Boolean)
    );
    if (uniqueHosts.size < 2) {
      await runEnrichment(true);
    }
  }
  return merged;
};

const resolvePriceByOcrText = async (text) => {
  const candidates = extractQueryCandidatesFromOcrText(text);

  for (const query of candidates) {
    const resolved = buildSimulatedPriceReply(query);
    if (resolved.matches.length) {
      return {
        queryUsed: query,
        extractedText: text,
        ...resolved
      };
    }
  }

  const fallbackQuery = truncateText(candidates[0] || String(text || "").replace(/\s+/g, " "), 80);
  return {
    queryUsed: fallbackQuery,
    extractedText: text,
    message: buildTextByTemplate(
      "image_ocr_not_found",
      { query: fallbackQuery, extracted_text: text },
      `OCR結果から価格DBを照合できませんでした。\n抽出候補: ${fallbackQuery}`
    ),
    matches: [],
    webCandidates: []
  };
};

const processCsvIngestionRows = ({
  rows,
  ingestionFileId,
  defaultStoreId = null,
  periodYm = null,
  uploadedBy = "admin"
}) => {
  let acceptedRows = 0;
  let rejectedRows = 0;

  const defaultEffectiveDate = periodYm ? `${periodYm}-01` : null;

  for (const rowItem of rows) {
    const { rowNo, row } = rowItem;
    const productName = String(row.product_name || "").trim();
    const nameEn = String(row.name_en || "").trim();
    const sku = String(row.sku || "").trim();
    const producerFromKnownHeaders = pickFirstNonEmptyText(
      row.producer,
      row.producer_name,
      row.winery,
      row.winery_name,
      row.maker
    );
    const cepageFromKnownHeaders = pickFirstNonEmptyText(
      row.cepage,
      row.grape,
      row.grapes,
      row.variety,
      row.varieties,
      row.varietal
    );
    // D列/E列固定フォーマット向けフォールバック:
    // ヘッダー名が揺れて col_4/col_5 になった場合でも生産者/セパージュを吸収する。
    const producerFromPosition =
      !producerFromKnownHeaders && !looksLikeNumericCell(row.col_4) ? String(row.col_4 || "").trim() : "";
    const cepageFromPosition =
      !cepageFromKnownHeaders && !looksLikeNumericCell(row.col_5) ? String(row.col_5 || "").trim() : "";
    const resolvedProducer = pickFirstNonEmptyText(producerFromKnownHeaders, producerFromPosition);
    const resolvedCepage = pickFirstNonEmptyText(cepageFromKnownHeaders, cepageFromPosition);

    if (!productName && !nameEn && !sku) {
      addIngestionError({
        ingestionFileId,
        rowNo,
        errorCode: "PRODUCT_NAME_REQUIRED",
        errorMessage: "ワイン名（ワイン名 or wine_name）が必要です",
        rawPayload: JSON.stringify(row)
      });
      rejectedRows += 1;
      continue;
    }

    const retailPrice = hasValue(row.retail_price) ? parsePriceValue(row.retail_price) : null;
    if (hasValue(row.retail_price) && retailPrice === null) {
      addIngestionError({
        ingestionFileId,
        rowNo,
        errorCode: "INVALID_RETAIL_PRICE",
        errorMessage: "販売価格が不正です",
        rawPayload: JSON.stringify(row)
      });
      rejectedRows += 1;
      continue;
    }

    const purchasePrice = hasValue(row.purchase_price) ? parsePriceValue(row.purchase_price) : null;
    if (hasValue(row.purchase_price) && purchasePrice === null) {
      addIngestionError({
        ingestionFileId,
        rowNo,
        errorCode: "INVALID_PURCHASE_PRICE",
        errorMessage: "納品価格が不正です",
        rawPayload: JSON.stringify(row)
      });
      rejectedRows += 1;
      continue;
    }

    const stockQty = hasValue(row.stock_qty) ? parseIntegerAllowZero(row.stock_qty) : null;
    if (hasValue(row.stock_qty) && stockQty === null) {
      addIngestionError({
        ingestionFileId,
        rowNo,
        errorCode: "INVALID_STOCK_QTY",
        errorMessage: "在庫数が不正です",
        rawPayload: JSON.stringify(row)
      });
      rejectedRows += 1;
      continue;
    }

    let costRate = hasValue(row.cost_rate) ? parseRateValue(row.cost_rate) : null;
    if (hasValue(row.cost_rate) && costRate === null) {
      // e.g. #DIV/0! should not block catalog ingestion.
      costRate = null;
    }

    const hasLegacyPrice = hasValue(row.price);
    const legacyPrice = hasLegacyPrice ? parsePriceValue(row.price) : null;
    if (hasLegacyPrice && legacyPrice === null) {
      addIngestionError({
        ingestionFileId,
        rowNo,
        errorCode: "INVALID_PRICE",
        errorMessage: "price が不正です",
        rawPayload: JSON.stringify(row)
      });
      rejectedRows += 1;
      continue;
    }

    let rowStoreId = null;
    let effectiveDate = null;
    if (legacyPrice) {
      rowStoreId =
        resolveStoreId({
          storeId: asPositiveInt(row.store_id),
          storeCode: row.store_code || "",
          storeName: row.store_name || ""
        }) || defaultStoreId;

      if (!rowStoreId) {
        addIngestionError({
          ingestionFileId,
          rowNo,
          errorCode: "STORE_NOT_FOUND",
          errorMessage: "store_id / store_code / store_name が不足しています",
          rawPayload: JSON.stringify(row)
        });
        rejectedRows += 1;
        continue;
      }

      effectiveDate = asDate(row.effective_date) || defaultEffectiveDate;
      if (!effectiveDate) {
        addIngestionError({
          ingestionFileId,
          rowNo,
          errorCode: "INVALID_EFFECTIVE_DATE",
          errorMessage: "effective_date が不正です（YYYY-MM-DD）",
          rawPayload: JSON.stringify(row)
        });
        rejectedRows += 1;
        continue;
      }
    }

    const aliasCandidates = [productName, nameEn];
    const productPayload = {
      sku,
      name: productName || nameEn || sku,
      nameEn: nameEn || null,
      producer: resolvedProducer || null,
      cepage: resolvedCepage || null,
      vintage: String(row.vintage || "").trim() || null,
      retailPrice,
      purchasePrice,
      stockQty,
      stockStore: String(row.stock_store || "").trim() || null,
      supplierName: String(row.supplier_name || "").trim() || null,
      costRate,
      aliases: aliasCandidates
    };

    try {
      const beforeProduct = findCatalogProductByIdentity(productPayload);
      const product = upsertCatalogProduct(productPayload);

      recordIngestionProductSnapshot({
        ingestionFileId,
        productId: product.id,
        rowNo,
        wasCreated: !beforeProduct,
        beforeProduct
      });

      if (legacyPrice) {
        addPriceHistory({
          productId: product.id,
          storeId: rowStoreId,
          price: legacyPrice,
          effectiveDate,
          currency: String(row.currency || "JPY").trim() || "JPY",
          sourceFileId: ingestionFileId,
          sourceRowNo: rowNo,
          createdBy: uploadedBy
        });
      }

      acceptedRows += 1;
    } catch (error) {
      addIngestionError({
        ingestionFileId,
        rowNo,
        errorCode: "INSERT_FAILED",
        errorMessage: String(error?.message || "unknown error"),
        rawPayload: JSON.stringify(row)
      });
      rejectedRows += 1;
    }
  }

  return {
    totalRows: rows.length,
    acceptedRows,
    rejectedRows
  };
};

const ensureBackupDirectory = () => {
  fs.mkdirSync(opsConfig.backupDir, { recursive: true });
};

const asBackupTimestamp = (date = new Date()) =>
  date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");

const listBackupFiles = () => {
  ensureBackupDirectory();
  const files = fs
    .readdirSync(opsConfig.backupDir)
    .filter((name) => name.endsWith(".db"))
    .map((name) => {
      const fullPath = path.join(opsConfig.backupDir, name);
      const stat = fs.statSync(fullPath);
      return {
        fileName: name,
        fullPath,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return files;
};

const pruneBackupFiles = () => {
  if (opsConfig.backupRetention <= 0) {
    return;
  }

  const backups = listBackupFiles();
  const toDelete = backups.slice(opsConfig.backupRetention);
  for (const item of toDelete) {
    try {
      fs.unlinkSync(item.fullPath);
    } catch (error) {
      console.warn("Failed to prune backup file", item.fullPath, error);
    }
  }
};

const createBackup = ({ reason = "manual" } = {}) => {
  ensureBackupDirectory();
  const timestamp = asBackupTimestamp();
  const safeReason = String(reason || "manual")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 40) || "manual";
  const fileName = `wine_price_${timestamp}_${safeReason}.db`;
  const destination = path.join(opsConfig.backupDir, fileName);

  backupDatabaseTo(destination);
  pruneBackupFiles();

  const stat = fs.statSync(destination);
  return {
    fileName,
    fullPath: destination,
    sizeBytes: stat.size,
    createdAt: stat.mtime.toISOString()
  };
};

const lineSelectionState = new Map();
const lineSelectionTtlMs = 30 * 60 * 1000;

const getConversationKey = (event) => {
  const userId = String(event?.source?.userId || "").trim();
  if (userId) {
    return `user:${userId}`;
  }
  const groupId = String(event?.source?.groupId || "").trim();
  if (groupId) {
    return `group:${groupId}`;
  }
  const roomId = String(event?.source?.roomId || "").trim();
  if (roomId) {
    return `room:${roomId}`;
  }
  return "";
};

const pruneLineSelectionState = () => {
  const now = Date.now();
  for (const [key, item] of lineSelectionState.entries()) {
    if (now - Number(item?.updatedAt || 0) > lineSelectionTtlMs) {
      lineSelectionState.delete(key);
    }
  }
};

const setLineSelectionState = (conversationKey, query, matches) => {
  if (!conversationKey || !Array.isArray(matches) || matches.length < 2) {
    return;
  }
  pruneLineSelectionState();
  lineSelectionState.set(conversationKey, {
    mode: "select_candidate",
    query: String(query || "").trim(),
    matches,
    updatedAt: Date.now()
  });
};

const setLineStockAdjustState = (conversationKey, selectedProduct) => {
  const productId = Number(selectedProduct?.id);
  if (!conversationKey || !Number.isInteger(productId) || productId <= 0) {
    return false;
  }
  pruneLineSelectionState();
  lineSelectionState.set(conversationKey, {
    mode: "adjust_stock",
    productId,
    productLabel: formatCatalogPrimaryName(selectedProduct),
    updatedAt: Date.now()
  });
  return true;
};

const clearLineSelectionState = (conversationKey) => {
  if (!conversationKey) {
    return;
  }
  lineSelectionState.delete(conversationKey);
};

const getLineSelectionState = (conversationKey) => {
  if (!conversationKey) {
    return null;
  }
  pruneLineSelectionState();
  const item = lineSelectionState.get(conversationKey);
  if (!item) {
    return null;
  }
  item.updatedAt = Date.now();
  return item;
};

const resolveLineSelectionMode = (item) => {
  const mode = String(item?.mode || "").trim();
  if (mode === "select_candidate" || mode === "adjust_stock") {
    return mode;
  }
  if (Array.isArray(item?.matches)) {
    return "select_candidate";
  }
  return "";
};

const parseSelectionNumber = (value) => {
  const text = String(value || "").normalize("NFKC").trim();
  const matched = text.match(/^([1-9]\d?)$/);
  if (!matched) {
    return null;
  }
  return Number(matched[1]);
};

const parseStockDelta = (value) => {
  const text = String(value || "").normalize("NFKC").trim();
  const matched = text.match(/^([+-]?\d{1,4})$/);
  if (!matched) {
    return null;
  }
  return Number(matched[1]);
};

const formatSignedDelta = (value) => {
  const delta = Number(value);
  if (!Number.isFinite(delta)) {
    return "0";
  }
  return delta >= 0 ? `+${Math.round(delta)}` : String(Math.round(delta));
};

const processTextEvent = async (event, canReply) => {
  if (!canReply) {
    return;
  }

  const text = String(event.message?.text || "").trim();
  const conversationKey = getConversationKey(event);
  const conversationState = conversationKey ? getLineSelectionState(conversationKey) : null;
  const stateMode = resolveLineSelectionMode(conversationState);

  if (stateMode === "adjust_stock" && conversationKey) {
    const delta = parseStockDelta(text);
    if (delta !== null) {
      try {
        const adjusted = adjustProductStockQty({
          productId: conversationState.productId,
          delta
        });

        if (!adjusted?.product) {
          clearLineSelectionState(conversationKey);
          await sendLineReply(
            event.replyToken,
            "選択中のアイテムが見つからなくなりました。もう一度商品名を送ってください。"
          );
          return;
        }

        setLineStockAdjustState(conversationKey, adjusted.product);
        await sendLineReply(
          event.replyToken,
          [
            `${adjusted.product.name || adjusted.product.name_en || conversationState.productLabel || "対象商品"} の在庫を ${formatSignedDelta(delta)} しました。`,
            `在庫数: ${adjusted.previousQty} → ${adjusted.nextQty}`,
            "続けて増減する場合は 1 / -1 を送ってください。別の商品を探す場合は商品名を送ってください。"
          ].join("\n")
        );
        return;
      } catch (error) {
        if (error?.code === "NON_POSITIVE_STOCK" || error?.code === "NEGATIVE_STOCK") {
          const currentQty = Number.isFinite(Number(error.currentQty))
            ? Math.round(Number(error.currentQty))
            : null;
          const stockNotice =
            currentQty !== null && currentQty <= 0 ? "在庫がありません。" : "在庫が不足しています。";
          await sendLineReply(
            event.replyToken,
            `${stockNotice} 在庫を0以下にはできません。現在在庫: ${currentQty ?? "不明"}`
          );
          return;
        }
        console.error("Stock adjustment failed", error);
        await sendLineReply(
          event.replyToken,
          "在庫更新に失敗しました。時間をおいてもう一度お試しください。"
        );
        return;
      }
    }

    if (/^[+-]?\d/.test(String(text || "").normalize("NFKC").trim())) {
      await sendLineReply(
        event.replyToken,
        "在庫増減は整数で送ってください（例: 1 / -1）。"
      );
      return;
    }

    clearLineSelectionState(conversationKey);
  }

  const match = text.match(/^価格[\s:：]+(.+)$/);
  const query = (match ? match[1] : text).trim();

  if (!query) {
    const guidance = "価格を調べるには「価格 シャブリ」の形式で送ってください。";
    await sendLineReply(event.replyToken, guidance);
    return;
  }

  const selectedNumber = parseSelectionNumber(query);
  if (selectedNumber !== null && conversationKey) {
    const selection = getLineSelectionState(conversationKey);
    if (resolveLineSelectionMode(selection) === "select_candidate" && selection?.matches?.length) {
      if (selectedNumber >= 1 && selectedNumber <= selection.matches.length) {
        const selected = selection.matches[selectedNumber - 1];
        const detailLines = [
          `${selection.query} の ${selectedNumber}. を表示します。`,
          buildCatalogDetailLines(selected)
        ];
        if (setLineStockAdjustState(conversationKey, selected)) {
          detailLines.push("在庫を増減する場合は、次のメッセージで 1 / -1 のように送ってください。");
        } else {
          clearLineSelectionState(conversationKey);
        }
        const detail = detailLines.join("\n\n");
        await sendLineReply(event.replyToken, detail);
        return;
      }

      await sendLineReply(
        event.replyToken,
        `候補番号は 1〜${selection.matches.length} の範囲で入力してください。`
      );
      return;
    }
  }

  const { message, requiresSelection, matches } = buildSimulatedPriceReply(query);
  if (conversationKey) {
    if (requiresSelection) {
      setLineSelectionState(conversationKey, query, matches);
    } else {
      clearLineSelectionState(conversationKey);
    }
  }
  await sendLineReply(event.replyToken, message);
};

const processImageEvent = async (event, canReply) => {
  const imageId = String(event.message?.id || "").trim();
  let extractedText = "PENDING_OCR";
  let confidence = null;
  let resolvedByOcr = null;

  if (imageId) {
    try {
      const { imageBuffer, contentType } = await fetchLineImageBuffer(imageId);
      let ocrText = "";
      if (lineConfig.ocrEndpoint) {
        try {
          const ocr = await requestOcr(imageBuffer, contentType);
          if (ocr?.text) {
            ocrText = ocr.text;
            extractedText = ocr.text;
            confidence = ocr.confidence;
          }
        } catch (error) {
          console.error("Image OCR failed", error);
        }
      }

      if (ocrText) {
        resolvedByOcr = await resolvePriceByOcrText(ocrText);
      }
    } catch (error) {
      console.error("Image processing failed", error);
    }
  }

  saveOcrResult({
    lineEventId: event.webhookEventId,
    imageId: imageId || null,
    extractedText,
    guessedProductId: resolvedByOcr?.matches?.[0]?.product_id || null,
    confidence
  });

  if (!canReply) {
    return;
  }

  if (resolvedByOcr) {
    const conversationKey = getConversationKey(event);
    if (conversationKey && resolvedByOcr?.requiresSelection) {
      setLineSelectionState(conversationKey, resolvedByOcr.queryUsed || "", resolvedByOcr.matches || []);
    }
    await sendLineReply(event.replyToken, resolvedByOcr.message);
    return;
  }

  const fallback = buildTextByTemplate(
    "image_ocr_failed",
    {},
    "画像を受け取りましたが、今回はラベル文字を抽出できませんでした。ラベルを正面から明るい場所で撮影して、もう一度送ってください。"
  );
  await sendLineReply(event.replyToken, fallback);
};

const processLineEvent = async (event) => {
  if (event.type !== "message") {
    return;
  }

  const replyToken = String(event.replyToken || "").trim();
  const canReply =
    Boolean(lineConfig.accessToken) &&
    Boolean(replyToken) &&
    replyToken !== "00000000000000000000000000000000";

  if (event.message?.type === "text") {
    await processTextEvent(event, canReply);
    return;
  }

  if (event.message?.type === "image") {
    await processImageEvent(event, canReply);
  }
};

app.post("/webhooks/line", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}";
    const signature = req.header("x-line-signature");

    if (!verifyLineSignature(rawBody, signature)) {
      return sendError(res, 401, "invalid line signature");
    }

    const payload = JSON.parse(rawBody || "{}");
    const events = Array.isArray(payload.events) ? payload.events : [];

    for (const event of events) {
      const eventId = String(event.webhookEventId || `${event.timestamp || Date.now()}-${Math.random()}`);
      const normalizedEvent = {
        ...event,
        webhookEventId: eventId
      };

      const isNew = saveLineEvent(normalizedEvent);
      if (!isNew) {
        continue;
      }

      try {
        await processLineEvent(normalizedEvent);
      } catch (error) {
        console.error("LINE event handling failed", error);
      }
    }

    return res.json({ ok: true, processed: events.length });
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "webhook processing failed");
  }
});

app.use(express.json({ limit: "20mb" }));
app.use("/api", requireAdminAuth);
app.use("/admin", express.static(path.join(projectRoot, "public"), { extensions: ["html"] }));

app.get("/", (req, res) => {
  res.type("text/plain").send("Wine Price API is running. Open /admin");
});

app.get("/api/health", (req, res) => {
  const activeLlmProvider = resolveActiveLlmProvider();
  const activeVisionProvider = resolveActiveVisionProvider();
  const adminTokenState = resolveAdminTokenState();
  res.json({
    ok: true,
    dbPath,
    adminAuthRequired: Boolean(adminTokenState.token),
    adminTokenSource: adminTokenState.source,
    host: HOST,
    port: PORT,
    lineWebhookReady: Boolean(lineConfig.channelSecret),
    lineReplyReady: Boolean(lineConfig.accessToken),
    ocrEndpointReady: Boolean(lineConfig.ocrEndpoint),
    ocrRequestFormat: lineConfig.ocrRequestFormat,
    ocrTimeoutMs: lineConfig.ocrTimeoutMs,
    webSearchEnabled: webSearchConfig.enabled,
    webSearchProvider: webSearchConfig.provider,
    webSearchPriorityDomains: webSearchConfig.priorityDomains,
    webSearchMaxResults: webSearchConfig.maxResults,
    webSummaryMaxSources: webSearchConfig.summaryMaxSources,
    serpApiConfigured: Boolean(webSearchConfig.serpApiKey),
    llmProviderPreference: llmConfig.provider,
    llmProviderActive: activeLlmProvider || "none",
    visionProviderPreference: visionLlmConfig.provider,
    visionProviderActive: activeVisionProvider || "none",
    geminiConfigured: Boolean(geminiConfig.apiKey),
    geminiModel: geminiConfig.model,
    geminiVisionEnabled: Boolean(geminiConfig.apiKey) && geminiVisionConfig.enabled,
    geminiVisionModel: geminiVisionConfig.model,
    geminiWineFlowEnabled: Boolean(geminiConfig.apiKey) && geminiWineFlowConfig.enabled,
    geminiWineAnalysisModel: geminiWineFlowConfig.analysisModel,
    geminiWineReplyModel: geminiWineFlowConfig.replyModel,
    groqConfigured: Boolean(groqConfig.apiKey),
    groqVisionEnabled: Boolean(groqConfig.apiKey) && groqVisionConfig.enabled,
    groqVisionModel: groqVisionConfig.model,
    groqWineFlowEnabled: Boolean(groqConfig.apiKey) && groqWineFlowConfig.enabled,
    groqWineAnalysisModel: groqWineFlowConfig.analysisModel,
    groqWineReplyModel: groqWineFlowConfig.replyModel,
    backupRetention: opsConfig.backupRetention
  });
});

app.post("/api/admin/auth-token", (req, res) => {
  const useEnvToken = req.body?.useEnvToken === true;
  const newAdminToken = String(req.body?.newAdminToken || "").trim();
  if (!useEnvToken) {
    if (!newAdminToken) {
      return sendError(res, 400, "newAdminToken is required");
    }
    if (newAdminToken.length < 8) {
      return sendError(res, 400, "newAdminToken must be at least 8 characters");
    }
    if (newAdminToken.length > 200) {
      return sendError(res, 400, "newAdminToken is too long");
    }
  }

  try {
    const result = setAdminTokenOverride(useEnvToken ? "" : newAdminToken);
    const tokenState = resolveAdminTokenState();
    return res.json({
      ok: true,
      adminAuthRequired: Boolean(tokenState.token),
      adminTokenSource: tokenState.source,
      updatedAt: result.updatedAt
    });
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "failed to update admin token");
  }
});

app.get("/api/admin/backups", (req, res) => {
  const items = listBackupFiles();
  return res.json({ items });
});

app.post("/api/admin/backup", (req, res) => {
  try {
    const reason = String(req.body?.reason || "manual").trim() || "manual";
    const backup = createBackup({ reason });
    return res.status(201).json({
      ok: true,
      backup
    });
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "failed to create backup");
  }
});

app.get("/api/stores", (req, res) => {
  res.json({ items: listStores() });
});

app.post("/api/stores", (req, res) => {
  const storeCode = String(req.body?.storeCode || "").trim();
  const name = String(req.body?.name || "").trim();

  if (!storeCode || !name) {
    return sendError(res, 400, "storeCode and name are required");
  }

  try {
    const store = createStore({
      storeCode,
      name,
      isActive: req.body?.isActive !== false
    });
    res.status(201).json(store);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return sendError(res, 409, "storeCode already exists");
    }
    console.error(error);
    return sendError(res, 500, "failed to create store");
  }
});

app.get("/api/products", (req, res) => {
  const items = listProducts({
    query: req.query.query || "",
    limit: req.query.limit ? Number(req.query.limit) : 200
  });
  res.json({ items });
});

app.post("/api/products", (req, res) => {
  const name = String(req.body?.name || "").trim();
  const nameEn = String(req.body?.nameEn || req.body?.name_en || "").trim();
  if (!name && !nameEn) {
    return sendError(res, 400, "name or nameEn is required");
  }

  const retailPrice =
    hasValue(req.body?.retailPrice) || hasValue(req.body?.retail_price)
      ? parsePriceValue(req.body?.retailPrice ?? req.body?.retail_price)
      : null;
  const purchasePrice =
    hasValue(req.body?.purchasePrice) || hasValue(req.body?.purchase_price)
      ? parsePriceValue(req.body?.purchasePrice ?? req.body?.purchase_price)
      : null;
  const stockQty =
    hasValue(req.body?.stockQty) || hasValue(req.body?.stock_qty)
      ? parseIntegerAllowZero(req.body?.stockQty ?? req.body?.stock_qty)
      : null;
  const costRate =
    hasValue(req.body?.costRate) || hasValue(req.body?.cost_rate)
      ? parseRateValue(req.body?.costRate ?? req.body?.cost_rate)
      : null;

  if (
    (hasValue(req.body?.retailPrice) || hasValue(req.body?.retail_price)) &&
    retailPrice === null
  ) {
    return sendError(res, 400, "retailPrice is invalid");
  }
  if (
    (hasValue(req.body?.purchasePrice) || hasValue(req.body?.purchase_price)) &&
    purchasePrice === null
  ) {
    return sendError(res, 400, "purchasePrice is invalid");
  }
  if ((hasValue(req.body?.stockQty) || hasValue(req.body?.stock_qty)) && stockQty === null) {
    return sendError(res, 400, "stockQty is invalid");
  }
  if ((hasValue(req.body?.costRate) || hasValue(req.body?.cost_rate)) && costRate === null) {
    return sendError(res, 400, "costRate is invalid");
  }

  try {
    const product = createProduct({
      sku: String(req.body?.sku || "").trim() || null,
      name: name || nameEn,
      nameEn: nameEn || null,
      producer: String(req.body?.producer || "").trim() || null,
      cepage: String(req.body?.cepage || "").trim() || null,
      vintage: String(req.body?.vintage || "").trim() || null,
      unit: String(req.body?.unit || "").trim() || null,
      retailPrice,
      purchasePrice,
      stockQty,
      stockStore: String(req.body?.stockStore || req.body?.stock_store || "").trim() || null,
      supplierName: String(req.body?.supplierName || req.body?.supplier_name || "").trim() || null,
      costRate,
      aliases: Array.isArray(req.body?.aliases) ? req.body.aliases : []
    });
    res.status(201).json(product);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "failed to create product");
  }
});

app.get("/api/prices/current", (req, res) => {
  const items = listCurrentPrices({
    productId: req.query.productId ? Number(req.query.productId) : null,
    storeId: req.query.storeId ? Number(req.query.storeId) : null,
    limit: req.query.limit ? Number(req.query.limit) : 300
  });
  res.json({ items });
});

app.get("/api/prices/history", (req, res) => {
  const items = listPriceHistory({
    productId: req.query.productId ? Number(req.query.productId) : null,
    storeId: req.query.storeId ? Number(req.query.storeId) : null,
    limit: req.query.limit ? Number(req.query.limit) : 300
  });
  res.json({ items });
});

app.post("/api/prices", (req, res) => {
  const productId = asPositiveInt(req.body?.productId);
  const price = asPositiveInt(req.body?.price);
  const effectiveDate = asDate(req.body?.effectiveDate);

  const storeId = resolveStoreId({
    storeId: asPositiveInt(req.body?.storeId),
    storeCode: req.body?.storeCode || "",
    storeName: req.body?.storeName || ""
  });

  if (!productId || !storeId || !price || !effectiveDate) {
    return sendError(
      res,
      400,
      "productId, storeId(or storeCode/storeName), price, effectiveDate(YYYY-MM-DD) are required"
    );
  }

  try {
    const row = addPriceHistory({
      productId,
      storeId,
      price,
      effectiveDate,
      currency: String(req.body?.currency || "JPY").trim() || "JPY",
      sourceFileId: req.body?.sourceFileId ? Number(req.body.sourceFileId) : null,
      sourceRowNo: req.body?.sourceRowNo ? Number(req.body.sourceRowNo) : null,
      createdBy: String(req.body?.createdBy || "admin").trim() || "admin"
    });
    res.status(201).json(row);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "failed to add price");
  }
});

app.get("/api/ingestion/files", (req, res) => {
  const items = listIngestionFiles({
    limit: req.query.limit ? Number(req.query.limit) : 200
  });
  return res.json({ items });
});

const buildIngestionTemplateCsv = () =>
  [
    "年代,ワイン名,wine_name,生産者,セパージュ,販売価格,納品価格,在庫数,在庫店舗,納品業者,原価率",
    "2021,マコン・クラシコ,Macan Clasico,Bodegas Benjamin de Rothschild & Vega Sicilia,Tempranillo,6980,4200,24,新宿倉庫,ABCトレーディング,60.2",
    "2019,シャトー・マルゴー,Chateau Margaux,Chateau Margaux,Cabernet Sauvignon/Merlot,198000,132000,2,銀座店,XYZインポーター,66.7"
  ].join("\n");

app.get("/template/wine_price_template.csv", (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"wine_master_template.csv\"");
  return res.send(buildIngestionTemplateCsv());
});

app.get("/api/ingestion/template", (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"wine_master_template.csv\"");
  return res.send(buildIngestionTemplateCsv());
});

app.get("/api/ingestion/mappings", (req, res) => {
  const items = listStoreCsvMappings({
    limit: req.query.limit ? Number(req.query.limit) : 200
  });
  return res.json({ items });
});

app.get("/api/ingestion/mappings/:storeId", (req, res) => {
  const storeId = asPositiveInt(req.params.storeId);
  if (!storeId) {
    return sendError(res, 400, "invalid storeId");
  }

  const item = getStoreCsvMapping(storeId);
  if (!item) {
    return sendError(res, 404, "mapping not found");
  }

  return res.json(item);
});

app.post("/api/ingestion/mappings", (req, res) => {
  const storeId = asPositiveInt(req.body?.storeId);
  if (!storeId) {
    return sendError(res, 400, "storeId is required");
  }

  const headerMapping = req.body?.headerMapping;
  if (!headerMapping || typeof headerMapping !== "object" || Array.isArray(headerMapping)) {
    return sendError(res, 400, "headerMapping must be an object");
  }

  const delimiter = String(req.body?.delimiter || "").trim() || null;
  if (delimiter && ![",", "\t", ";"].includes(delimiter)) {
    return sendError(res, 400, "delimiter must be one of ',', '\\t', ';'");
  }

  const row = upsertStoreCsvMapping({
    storeId,
    headerMapping,
    delimiter,
    updatedBy: String(req.body?.updatedBy || "admin").trim() || "admin"
  });
  return res.status(201).json(row);
});

app.get("/api/ingestion/files/:id/errors", (req, res) => {
  const ingestionFileId = asPositiveInt(req.params.id);
  if (!ingestionFileId) {
    return sendError(res, 400, "invalid ingestion file id");
  }

  const items = listIngestionErrors({
    ingestionFileId,
    limit: req.query.limit ? Number(req.query.limit) : 500
  });
  return res.json({ items });
});

app.delete("/api/ingestion/files/:id", (req, res) => {
  const ingestionFileId = asPositiveInt(req.params.id);
  if (!ingestionFileId) {
    return sendError(res, 400, "invalid ingestion file id");
  }

  try {
    const deleted = deleteIngestionFile(ingestionFileId);
    if (!deleted) {
      return sendError(res, 404, "ingestion file not found");
    }
    return res.json({
      ok: true,
      ...deleted
    });
  } catch (error) {
    if (error?.code === "ROLLBACK_DATA_MISSING") {
      return sendError(
        res,
        409,
        "この履歴はロールバック情報が無いため削除できません。新仕様適用後の取込データのみロールバック対応です。"
      );
    }
    if (error?.code === "ROLLBACK_CONFLICT") {
      const productHint = error?.productName
        ? `（競合商品: ${error.productName}）`
        : error?.productId
          ? `（競合商品ID: ${error.productId}）`
          : "";
      return sendError(
        res,
        409,
        `この履歴より新しいCSVが同一商品を更新しているため、先に新しい履歴を削除してください${productHint}`
      );
    }
    if (error?.code === "ROLLBACK_DATA_CORRUPTED") {
      return sendError(res, 500, "ロールバック情報が壊れているため削除できません");
    }
    console.error(error);
    return sendError(res, 500, "failed to delete ingestion file");
  }
});

app.post("/api/ingestion/csv", (req, res) => {
  const csvText = String(req.body?.csvText || "");
  const fileBase64 = String(req.body?.fileBase64 || "");
  const fileMimeType = String(req.body?.fileMimeType || "").trim().toLowerCase();
  const fileName = String(req.body?.fileName || "upload.csv").trim() || "upload.csv";
  const fileExtension = String(path.extname(fileName) || "").trim().toLowerCase();

  const inputPeriodYm = String(req.body?.periodYm || "").trim();
  const periodYm = inputPeriodYm ? asPeriodYm(inputPeriodYm) : null;
  if (inputPeriodYm && !periodYm) {
    return sendError(res, 400, "periodYm must be YYYY-MM");
  }

  const defaultStoreId = resolveStoreId({
    storeId: asPositiveInt(req.body?.storeId),
    storeCode: String(req.body?.storeCode || "").trim(),
    storeName: String(req.body?.storeName || "").trim()
  });

  const storeMapping = defaultStoreId ? getStoreCsvMapping(defaultStoreId) : null;
  const parseOptions = {
    headerMapping: storeMapping?.header_mapping || null,
    delimiter: storeMapping?.delimiter || null
  };

  let parsed = null;
  let fileHashInput = "";
  if (csvText.trim()) {
    parsed = parseCsvText(csvText, parseOptions);
    fileHashInput = csvText;
  } else if (fileBase64.trim()) {
    const fileBuffer = decodeBase64Payload(fileBase64);
    if (!fileBuffer) {
      return sendError(res, 400, "fileBase64 is invalid");
    }

    const isExcel =
      [".xlsx", ".xls"].includes(fileExtension) ||
      fileMimeType.includes("spreadsheetml") ||
      fileMimeType.includes("ms-excel");
    const isCsvLike =
      [".csv", ".txt", ".tsv"].includes(fileExtension) ||
      fileMimeType.includes("csv") ||
      fileMimeType === "text/plain";

    if (isExcel) {
      try {
        parsed = parseExcelBuffer(fileBuffer, {
          headerMapping: parseOptions.headerMapping
        });
      } catch (error) {
        return sendError(res, 400, `failed to parse excel: ${String(error?.message || "invalid file")}`);
      }
    } else if (isCsvLike || !fileExtension) {
      parsed = parseCsvText(fileBuffer.toString("utf8"), parseOptions);
    } else {
      return sendError(res, 400, "unsupported file format (allowed: csv, xlsx, xls)");
    }

    fileHashInput = fileBuffer;
  } else {
    return sendError(res, 400, "csvText or fileBase64 is required");
  }

  if (!parsed.rows.length) {
    return sendError(res, 400, "ingestion rows are empty");
  }

  const uploadedBy = String(req.body?.uploadedBy || "admin").trim() || "admin";
  const fileHash = crypto.createHash("sha256").update(fileHashInput).digest("hex");

  let ingestionFile = null;
  try {
    ingestionFile = createIngestionFile({
      storeId: defaultStoreId,
      fileName,
      fileHash,
      periodYm,
      uploadedBy,
      status: "PROCESSING",
      totalRows: parsed.rows.length
    });
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE")) {
      const existing = getIngestionFileByHash(fileHash);
      return res.status(409).json({
        error: "same file already ingested",
        duplicate: true,
        ingestionFile: existing || null
      });
    }
    console.error(error);
    return sendError(res, 500, "failed to create ingestion file");
  }

  try {
    const result = processCsvIngestionRows({
      rows: parsed.rows,
      ingestionFileId: ingestionFile.id,
      defaultStoreId,
      periodYm,
      uploadedBy
    });

    const status =
      result.rejectedRows === 0 ? "SUCCESS" : result.acceptedRows > 0 ? "PARTIAL" : "FAILED";
    const completed = completeIngestionFile({
      id: ingestionFile.id,
      status,
      totalRows: result.totalRows,
      acceptedRows: result.acceptedRows,
      rejectedRows: result.rejectedRows
    });

    const errorItems =
      result.rejectedRows > 0
        ? listIngestionErrors({ ingestionFileId: ingestionFile.id, limit: 30 })
        : [];

    return res.status(201).json({
      ingestionFile: completed,
      result: {
        ...result,
        status
      },
      errors: errorItems
    });
  } catch (error) {
    console.error(error);
    completeIngestionFile({
      id: ingestionFile.id,
      status: "FAILED",
      totalRows: parsed.rows.length,
      acceptedRows: 0,
      rejectedRows: parsed.rows.length
    });
    return sendError(res, 500, "ingestion failed");
  }
});

app.get("/api/reply-templates", (req, res) => {
  res.json({ items: listReplyTemplates() });
});

app.post("/api/reply-templates", (req, res) => {
  const templateKey = String(req.body?.templateKey || "").trim();
  const body = String(req.body?.body || "").trim();
  if (!templateKey || !body) {
    return sendError(res, 400, "templateKey and body are required");
  }

  const row = upsertReplyTemplate({
    templateKey,
    body,
    isActive: req.body?.isActive !== false
  });
  res.status(201).json(row);
});

app.post("/api/reply-templates/rename", (req, res) => {
  const oldTemplateKey = String(req.body?.oldTemplateKey || "").trim();
  const newTemplateKey = String(req.body?.newTemplateKey || "").trim();
  if (!oldTemplateKey || !newTemplateKey) {
    return sendError(res, 400, "oldTemplateKey and newTemplateKey are required");
  }

  try {
    const row = renameReplyTemplateKey({
      oldTemplateKey,
      newTemplateKey
    });
    if (!row) {
      return sendError(res, 404, "source template key not found");
    }
    return res.json(row);
  } catch (error) {
    if (error?.code === "TEMPLATE_KEY_CONFLICT") {
      return sendError(res, 409, "newTemplateKey already exists");
    }
    if (String(error?.message || "").includes("UNIQUE")) {
      return sendError(res, 409, "newTemplateKey already exists");
    }
    console.error(error);
    return sendError(res, 500, "failed to rename template key");
  }
});

app.post("/api/ocr/resolve", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) {
    return sendError(res, 400, "text is required");
  }

  const resolved = await resolvePriceByOcrText(text);
  return res.json(resolved);
});

app.post("/api/ocr/vision-url", async (req, res) => {
  return sendError(res, 410, "vision-url endpoint is disabled in DB-only reset mode");
});

app.post("/api/line/simulate", (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) {
    return sendError(res, 400, "query is required");
  }

  const { message, matches } = buildSimulatedPriceReply(query);
  res.json({ query, message, matches });
});

app.listen(PORT, HOST, () => {
  console.log(`Wine Price API started: http://${HOST}:${PORT}`);
});
