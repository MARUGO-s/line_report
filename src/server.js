import "dotenv/config";
import crypto from "node:crypto";
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

const lineConfig = {
  channelSecret: String(process.env.LINE_CHANNEL_SECRET || "").trim(),
  accessToken: String(process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  ocrEndpoint: String(process.env.OCR_ENDPOINT || "").trim(),
  ocrAuthToken: String(process.env.OCR_AUTH_TOKEN || "").trim(),
  ocrRequestFormat: String(process.env.OCR_REQUEST_FORMAT || "json_base64").trim(),
  ocrBase64Field: String(process.env.OCR_BASE64_FIELD || "imageBase64").trim(),
  ocrImageField: String(process.env.OCR_IMAGE_FIELD || "image").trim(),
  ocrTimeoutMs: Math.max(1000, Number(process.env.OCR_TIMEOUT_MS || 12000) || 12000)
};

const sendError = (res, status, message) => res.status(status).json({ error: message });

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
      formData.append(
        lineConfig.ocrImageField || "image",
        new Blob([imageBuffer], { type: contentType }),
        `line-upload.${ext}`
      );
      body = formData;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
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

const extractQueryCandidatesFromOcrText = (text) => {
  const base = String(text || "").trim();
  if (!base) {
    return [];
  }

  const splitCandidates = base
    .split(/[\n\r\t,，、/|]/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((line) => line.replace(/[0-9０-９]+(?:円|ml|ML|年|本|%|度)?/g, " ").replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 2 && line.length <= 80);

  return [...new Set([base, ...splitCandidates])].slice(0, 10);
};

const resolvePriceByOcrText = (text) => {
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

  const fallbackQuery = candidates[0] || String(text || "").trim();
  return {
    queryUsed: fallbackQuery,
    extractedText: text,
    message: buildTextByTemplate(
      "image_ocr_not_found",
      { query: fallbackQuery, extracted_text: text },
      `OCR結果から価格を照合できませんでした。\n抽出: ${String(text || "").slice(0, 100)}`
    ),
    matches: []
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

  if (imageId && lineConfig.ocrEndpoint) {
    try {
      const { imageBuffer, contentType } = await fetchLineImageBuffer(imageId);
      const ocr = await requestOcr(imageBuffer, contentType);
      if (ocr?.text) {
        extractedText = ocr.text;
        confidence = ocr.confidence;
        resolvedByOcr = resolvePriceByOcrText(ocr.text);
      }
    } catch (error) {
      console.error("Image OCR failed", error);
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
app.use("/admin", express.static(path.join(projectRoot, "public"), { extensions: ["html"] }));

app.get("/", (req, res) => {
  res.type("text/plain").send("Wine Price API is running. Open /admin");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    dbPath,
    host: HOST,
    port: PORT,
    lineWebhookReady: Boolean(lineConfig.channelSecret),
    lineReplyReady: Boolean(lineConfig.accessToken),
    ocrEndpointReady: Boolean(lineConfig.ocrEndpoint),
    ocrRequestFormat: lineConfig.ocrRequestFormat,
    ocrTimeoutMs: lineConfig.ocrTimeoutMs
  });
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

app.post("/api/ocr/resolve", (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) {
    return sendError(res, 400, "text is required");
  }

  const resolved = resolvePriceByOcrText(text);
  return res.json(resolved);
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
