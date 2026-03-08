import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  addIngestionError,
  addPriceHistory,
  completeIngestionFile,
  createProduct,
  createStore,
  createIngestionFile,
  dbPath,
  findCurrentPricesByQuery,
  getIngestionFileByHash,
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
  renderTemplate,
  resolveProductId,
  resolveStoreId,
  saveLineEvent,
  saveOcrResult,
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

const webSearchConfig = {
  enabled: asBooleanEnv(process.env.WEB_SEARCH_ENABLED, false),
  timeoutMs: Math.max(1000, Number(process.env.WEB_SEARCH_TIMEOUT_MS || 5000) || 5000),
  maxResults: Math.max(1, Math.min(5, Number(process.env.WEB_SEARCH_MAX_RESULTS || 3) || 3)),
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
    return parsed.length > 0 ? parsed : ["www.enoteca.co.jp"];
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
  adminToken: String(process.env.ADMIN_TOKEN || "").trim()
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

const requireAdminAuth = (req, res, next) => {
  if (!securityConfig.adminToken) {
    return next();
  }

  if (req.path === "/health") {
    return next();
  }

  const token = extractAdminTokenFromRequest(req);
  if (token && token === securityConfig.adminToken) {
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
  winename: "product_name",
  itemname: "product_name",
  商品名: "product_name",
  ワイン名: "product_name",
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
  通貨: "currency"
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

const buildPriceLines = (rows) =>
  rows
    .map((row) => `・${row.store_name}: ${Number(row.latest_price).toLocaleString("ja-JP")}円 (${row.effective_date})`)
    .join("\n");

const buildTextByTemplate = (templateKey, variables, fallbackText) => {
  const template = getActiveReplyTemplateByKey(templateKey);
  if (!template) {
    return fallbackText;
  }
  return renderTemplate(template.body, variables);
};

const ensureDefaultTemplates = () => {
  const existingKeys = new Set(listReplyTemplates().map((item) => item.template_key));
  const defaults = [
    { key: "price_found", body: "{{product_name}} の最新価格です。\n{{lines}}" },
    { key: "price_not_found", body: "{{query}} に一致する価格が見つかりませんでした。" },
    { key: "image_received", body: "画像を受け取りました。OCR解析後に価格候補を返します。" },
    {
      key: "image_ocr_not_found",
      body: "OCR結果から価格を照合できませんでした。\n抽出候補: {{query}}"
    },
    {
      key: "image_ocr_web_candidates",
      body:
        "価格DBには見つかりませんでした。\n抽出候補: {{query}}\nWeb候補:\n{{web_lines}}\n※この候補は参考情報です。"
    },
    {
      key: "image_ocr_web_summary",
      body:
        "価格DBには見つかりませんでした。Web情報を要約します。\n産地: {{region}}\n生産者: {{producer}}\n市場価格: {{market_price}}\nセパージュ: {{varieties}}\n※Web参照の要約です。"
    }
  ];

  for (const template of defaults) {
    if (existingKeys.has(template.key)) {
      continue;
    }
    upsertReplyTemplate({
      templateKey: template.key,
      body: template.body,
      isActive: true
    });
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
  const matches = findCurrentPricesByQuery(query, 3);
  if (!matches.length) {
    return {
      message: buildTextByTemplate(
        "price_not_found",
        { query },
        `${query} に一致する価格が見つかりませんでした。`
      ),
      matches: []
    };
  }

  return {
    message: buildTextByTemplate(
      "price_found",
      {
        query,
        product_name: matches[0].product_name,
        lines: buildPriceLines(matches.slice(0, 5))
      },
      `${matches[0].product_name} の最新価格\n${buildPriceLines(matches.slice(0, 5))}`
    ),
    matches
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

  // Keep only likely product/info pages from the priority domain.
  if (/\/item\/|\/archives\/|\/article\/|\/producer\/|\/shop\//.test(url)) {
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

  const endpoint = new URL("https://serpapi.com/search.json");
  endpoint.searchParams.set("engine", webSearchConfig.serpApiEngine || "google");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set(
    "num",
    String(Math.max(webSearchConfig.maxResults, webSearchConfig.serpApiNum))
  );
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
    if (items.length >= webSearchConfig.maxResults) {
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

const searchWebCandidates = async (query) => {
  if (!webSearchConfig.enabled) {
    return [];
  }
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

  const candidates = [];
  for (const searchQuery of queryVariants) {
    if (candidates.length >= webSearchConfig.maxResults) {
      break;
    }

    if (trySerpApi && webSearchConfig.serpApiKey) {
      for (const domain of webSearchConfig.priorityDomains) {
        if (candidates.length >= webSearchConfig.maxResults) {
          break;
        }
        try {
          const siteQuery = `site:${domain} ${searchQuery}`.trim();
          const serpSiteRaw = await searchSerpApiCandidates(siteQuery, { preferredDomain: domain });
          const serpSite = serpSiteRaw.filter((item) =>
            isLikelyRelevantPriorityCandidate(item, searchQuery, domain)
          );
          candidates.push(
            ...serpSite.map((item) => ({
              ...item,
              source: `${item.source || "serpapi"}-priority:${domain}`
            }))
          );
        } catch (error) {
          console.warn("SerpAPI priority search failed", domain, error?.message || error);
        }
      }
      if (candidates.length >= webSearchConfig.maxResults) {
        break;
      }

      try {
        const serp = await searchSerpApiCandidates(searchQuery);
        candidates.push(...serp);
      } catch (error) {
        console.warn("SerpAPI search failed", error?.message || error);
      }
      if (candidates.length >= webSearchConfig.maxResults) {
        break;
      }
    }

    if (!tryFreeSources) {
      continue;
    }

    const wiki = await searchWikipediaCandidates(searchQuery);
    candidates.push(...wiki);
    if (candidates.length >= webSearchConfig.maxResults) {
      break;
    }

    try {
      const ddg = await searchDuckDuckGoCandidates(searchQuery);
      candidates.push(...ddg);
    } catch (error) {
      console.warn("DuckDuckGo search failed", error?.message || error);
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
    if (deduped.length >= webSearchConfig.maxResults) {
      break;
    }
  }
  return deduped;
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

    if (!title && !description) {
      return null;
    }
    return {
      title: truncateText(title, 140),
      description: truncateText(description, 280)
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
  const seenUrl = new Set();

  for (const item of webCandidates.slice(0, webSearchConfig.maxResults)) {
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
        snippet = metaSummary.description || snippet;
      }
    }

    const combined = [title, snippet].filter(Boolean).join("\n");
    if (combined) {
      contextBlocks.push(`[source=${sourceName}] ${url}\n${truncateText(combined, 420)}`);
      priceHints.push(...collectPriceHintsFromText(combined));
    }
  }

  return {
    contextText: contextBlocks.join("\n\n"),
    priceHints: dedupeTextArray(priceHints).slice(0, 6)
  };
};

const requestGroqWineSummaryFromWeb = async ({ query, contextText, priceHints = [] }) => {
  if (!groqConfig.apiKey) {
    return null;
  }
  if (!contextText.trim()) {
    return null;
  }

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
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content:
              'Extract wine info from web context. Return strict JSON: {"region":"","producer":"","market_price":"","varieties":""}. If unknown use "不明".'
          },
          {
            role: "user",
            content:
              `Query: ${query}\n\n` +
              `Web context:\n${truncateText(contextText, 3000)}\n\n` +
              `Price hints: ${priceHints.join(", ") || "none"}\n\n` +
              "Return only JSON."
          }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`groq web summary request failed ${response.status}`);
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonObjectFromText(content);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const marketPriceFromHints = priceHints.length > 0 ? `参考: ${priceHints[0]}` : "不明";
    return {
      region: normalizeSummaryField(parsed.region),
      producer: normalizeSummaryField(parsed.producer),
      market_price: normalizeSummaryField(parsed.market_price || marketPriceFromHints),
      varieties: normalizeVarieties(parsed.varieties)
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn("Groq web summary timed out");
      return null;
    }
    console.warn("Groq web summary failed", error?.message || error);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const extractSuggestionsFromGroqText = (content) => {
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
  return normalized.slice(0, groqConfig.maxCandidates);
};

const requestGroqQuerySuggestions = async ({ ocrText, candidates }) => {
  if (!groqConfig.apiKey) {
    return [];
  }

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
            content:
              "You correct OCR text into likely wine product names. Return compact JSON only: {\"candidates\":[\"name1\",\"name2\"]}"
          },
          {
            role: "user",
            content: `OCR text:\n${truncateText(ocrText, 800)}\n\nCurrent candidates:\n${candidates.join("\n")}\n\nReturn up to ${groqConfig.maxCandidates} corrected wine names.`
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`groq request failed ${response.status}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content || "";
    return extractSuggestionsFromGroqText(content);
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn("Groq suggestion timed out");
      return [];
    }
    console.warn("Groq suggestion failed", error?.message || error);
    return [];
  } finally {
    clearTimeout(timer);
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
  if (!groqVisionConfig.enabled || !groqConfig.apiKey) {
    return [];
  }
  if (!imageBuffer || imageBuffer.length <= 0) {
    return [];
  }
  if (imageBuffer.length > groqVisionConfig.maxImageBytes) {
    console.warn(
      `Skip Groq vision: image too large (${imageBuffer.length} > ${groqVisionConfig.maxImageBytes})`
    );
    return [];
  }

  const mimeType = asGroqVisionContentType(contentType);
  if (!mimeType) {
    console.warn("Skip Groq vision: unsupported content type", contentType);
    return [];
  }

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
                text:
                  `Find likely wine product names from this label image. Return up to ${groqVisionConfig.maxCandidates} short candidates. ` +
                  "Prefer official bottle label names in Latin letters when possible." +
                  (ocrHint ? ` OCR hint: ${truncateText(ocrHint, 250)}` : "")
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
    const content = payload?.choices?.[0]?.message?.content || "";
    const candidates = extractSuggestionsFromGroqText(content);
    return candidates.slice(0, groqVisionConfig.maxCandidates);
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn("Groq vision timed out");
      return [];
    }
    console.warn("Groq vision failed", error?.message || error);
    return [];
  } finally {
    clearTimeout(timer);
  }
};

const buildWebCandidateLines = (items) =>
  items
    .slice(0, webSearchConfig.maxResults)
    .map((item, index) => `${index + 1}. ${item.title}\n${item.url}`)
    .join("\n");

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
  let webCandidates = [];
  let queryUsedForWeb = fallbackQuery;

  if (webSearchConfig.enabled && fallbackQuery) {
    const groqSuggestions = await requestGroqQuerySuggestions({ ocrText: text, candidates });
    const searchQueries = dedupeTextArray([...groqSuggestions, ...candidates]).slice(0, 3);

    for (const query of searchQueries) {
      try {
        const found = await searchWebCandidates(query);
        if (found.length > 0) {
          webCandidates = found;
          queryUsedForWeb = query;
          break;
        }
      } catch (error) {
        console.warn("Web search fallback failed", query, error?.message || error);
      }
    }
  }

  if (webCandidates.length > 0) {
    const webContext = await buildWebSummaryContext(webCandidates);
    const summarized = await requestGroqWineSummaryFromWeb({
      query: queryUsedForWeb,
      contextText: webContext.contextText,
      priceHints: webContext.priceHints
    });
    const summary = summarized || {
      region: "不明",
      producer: queryUsedForWeb || "不明",
      market_price: webContext.priceHints[0] ? `参考: ${webContext.priceHints[0]}` : "不明",
      varieties: "不明"
    };

    return {
      queryUsed: queryUsedForWeb,
      extractedText: text,
      message: buildTextByTemplate(
        "image_ocr_web_summary",
        {
          query: queryUsedForWeb,
          region: summary.region,
          producer: summary.producer,
          market_price: summary.market_price,
          varieties: summary.varieties
        },
        `価格DBには見つかりませんでした。Web情報を要約します。\n産地: ${summary.region}\n生産者: ${summary.producer}\n市場価格: ${summary.market_price}\nセパージュ: ${summary.varieties}\n※Web参照の要約です。`
      ),
      matches: [],
      webCandidates,
      webSummary: summary
    };
  }

  return {
    queryUsed: fallbackQuery,
    extractedText: text,
    message: buildTextByTemplate(
      "image_ocr_not_found",
      { query: fallbackQuery, extracted_text: text },
      `OCR結果から価格を照合できませんでした。\n抽出候補: ${fallbackQuery}`
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
    const rowProductId = resolveProductId({
      productId: asPositiveInt(row.product_id),
      sku: row.sku || "",
      name: row.product_name || ""
    });

    if (!rowProductId) {
      addIngestionError({
        ingestionFileId,
        rowNo,
        errorCode: "PRODUCT_NOT_FOUND",
        errorMessage: "product_id / sku / product_name から商品を特定できません",
        rawPayload: JSON.stringify(row)
      });
      rejectedRows += 1;
      continue;
    }

    const rowStoreId =
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

    const price = parsePriceValue(row.price);
    if (!price) {
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

    const effectiveDate = asDate(row.effective_date) || defaultEffectiveDate;
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

    try {
      addPriceHistory({
        productId: rowProductId,
        storeId: rowStoreId,
        price,
        effectiveDate,
        currency: String(row.currency || "JPY").trim() || "JPY",
        sourceFileId: ingestionFileId,
        sourceRowNo: rowNo,
        createdBy: uploadedBy
      });
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

const processTextEvent = async (event, canReply) => {
  if (!canReply) {
    return;
  }

  const text = String(event.message?.text || "").trim();
  const match = text.match(/^価格[\s:：]+(.+)$/);
  const query = (match ? match[1] : text).trim();

  if (!query) {
    const guidance = "価格を調べるには「価格 シャブリ」の形式で送ってください。";
    await sendLineReply(event.replyToken, guidance);
    return;
  }

  const { message } = buildSimulatedPriceReply(query);
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

      let visionCandidates = [];
      try {
        visionCandidates = await requestGroqVisionSuggestions({
          imageBuffer,
          contentType,
          ocrHint: ocrText
        });
      } catch (error) {
        console.error("Groq vision extraction failed", error);
      }

      if (!ocrText && visionCandidates.length > 0) {
        extractedText = visionCandidates.join("\n");
      }

      const candidateBlocks = [];
      if (visionCandidates.length > 0) {
        candidateBlocks.push(visionCandidates.join("\n"));
      }
      if (ocrText) {
        candidateBlocks.push(ocrText);
      }

      if (candidateBlocks.length > 0) {
        resolvedByOcr = await resolvePriceByOcrText(candidateBlocks.join("\n"));
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
    await sendLineReply(event.replyToken, resolvedByOcr.message);
    return;
  }

  const fallback = buildTextByTemplate(
    "image_received",
    {},
    "画像を受け取りました。OCR解析後に価格候補を返します。"
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

app.use(express.json({ limit: "1mb" }));
app.use("/api", requireAdminAuth);
app.use("/admin", express.static(path.join(projectRoot, "public"), { extensions: ["html"] }));

app.get("/", (req, res) => {
  res.type("text/plain").send("Wine Price API is running. Open /admin");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    dbPath,
    adminAuthRequired: Boolean(securityConfig.adminToken),
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
    serpApiConfigured: Boolean(webSearchConfig.serpApiKey),
    groqConfigured: Boolean(groqConfig.apiKey),
    groqVisionEnabled: Boolean(groqConfig.apiKey) && groqVisionConfig.enabled,
    groqVisionModel: groqVisionConfig.model,
    backupRetention: opsConfig.backupRetention
  });
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
  if (!name) {
    return sendError(res, 400, "name is required");
  }

  try {
    const product = createProduct({
      sku: String(req.body?.sku || "").trim() || null,
      name,
      producer: String(req.body?.producer || "").trim() || null,
      vintage: String(req.body?.vintage || "").trim() || null,
      unit: String(req.body?.unit || "").trim() || null,
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

app.get("/api/ingestion/template", (req, res) => {
  const template = [
    "sku,product_name,store_code,price,effective_date,currency",
    "WINE-0001,Chablis Premier Cru,SHINJUKU,4200,2026-03-15,JPY",
    "WINE-0002,Sancerre Blanc,GINZA,4980,2026-03-15,JPY"
  ].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"wine_price_template.csv\"");
  return res.send(template);
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

app.post("/api/ingestion/csv", (req, res) => {
  const csvText = String(req.body?.csvText || "");
  if (!csvText.trim()) {
    return sendError(res, 400, "csvText is required");
  }

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
  const parsed = parseCsvText(csvText, {
    headerMapping: storeMapping?.header_mapping || null,
    delimiter: storeMapping?.delimiter || null
  });
  if (!parsed.rows.length) {
    return sendError(res, 400, "CSV rows are empty");
  }

  const uploadedBy = String(req.body?.uploadedBy || "admin").trim() || "admin";
  const fileName = String(req.body?.fileName || "upload.csv").trim() || "upload.csv";
  const fileHash = crypto.createHash("sha256").update(csvText).digest("hex");

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
    return sendError(res, 500, "csv ingestion failed");
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

app.post("/api/ocr/resolve", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) {
    return sendError(res, 400, "text is required");
  }

  const resolved = await resolvePriceByOcrText(text);
  return res.json(resolved);
});

app.post("/api/ocr/vision-url", async (req, res) => {
  const imageUrl = String(req.body?.imageUrl || "").trim();
  if (!imageUrl) {
    return sendError(res, 400, "imageUrl is required");
  }

  try {
    const { imageBuffer, contentType } = await fetchImageBufferByUrl(
      imageUrl,
      groqVisionConfig.timeoutMs,
      groqVisionConfig.maxImageBytes
    );
    const candidates = await requestGroqVisionSuggestions({ imageBuffer, contentType });
    const resolved = candidates.length > 0 ? await resolvePriceByOcrText(candidates.join("\n")) : null;

    return res.json({
      imageUrl,
      contentType,
      byteSize: imageBuffer.length,
      candidates,
      resolved
    });
  } catch (error) {
    console.error("Vision url test failed", error);
    return sendError(res, 500, String(error?.message || "vision url test failed"));
  }
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
