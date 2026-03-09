import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

export const dbPath = process.env.DB_PATH
  ? path.resolve(projectRoot, process.env.DB_PATH)
  : path.join(projectRoot, "wine_price.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schemaPath = path.join(projectRoot, "schema.sql");
if (fs.existsSync(schemaPath)) {
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  db.exec(schemaSql);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS store_csv_mappings (
    store_id INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
    header_mapping_json TEXT NOT NULL,
    delimiter TEXT,
    updated_by TEXT,
    updated_at TEXT NOT NULL
  );
`);

const ensureColumn = (tableName, columnName, columnDefinition) => {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => String(row.name || ""));
  if (columns.includes(columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
};

ensureColumn("products", "name_en", "TEXT");
ensureColumn("products", "retail_price", "INTEGER");
ensureColumn("products", "purchase_price", "INTEGER");
ensureColumn("products", "stock_qty", "INTEGER");
ensureColumn("products", "stock_store", "TEXT");
ensureColumn("products", "supplier_name", "TEXT");
ensureColumn("products", "cost_rate", "REAL");

const nowIso = () => new Date().toISOString();

const toNullableText = (value) => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

const toNullableInteger = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  const normalized = text.replace(/[,\s￥¥円%]/g, "");
  if (!normalized) {
    return null;
  }
  const num = Number(normalized);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.round(num);
};

const toNullableReal = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  const normalized = text.replace(/[,\s％%]/g, "");
  if (!normalized) {
    return null;
  }
  const num = Number(normalized);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.round(num * 100) / 100;
};

const normalizeAliases = (aliases) => {
  if (!Array.isArray(aliases)) {
    return [];
  }
  const values = [];
  for (const raw of aliases) {
    const base = String(raw || "").trim();
    if (!base) {
      continue;
    }
    values.push(base);
    const normalized = base.normalize("NFKC").trim();
    if (normalized && normalized !== base) {
      values.push(normalized);
    }
    const compact = normalized.replace(/\s+/g, "");
    if (compact && compact !== normalized) {
      values.push(compact);
    }
    const lowered = normalized.toLowerCase();
    if (lowered && lowered !== normalized) {
      values.push(lowered);
    }
  }
  return [...new Set(values)];
};

const getStoreByCodeStmt = db.prepare(
  "SELECT id, store_code, name, is_active, created_at FROM stores WHERE store_code = ?"
);

const getStoreByIdStmt = db.prepare(
  "SELECT id, store_code, name, is_active, created_at FROM stores WHERE id = ?"
);

const listStoresStmt = db.prepare(
  "SELECT id, store_code, name, is_active, created_at FROM stores ORDER BY created_at DESC"
);

const createStoreStmt = db.prepare(`
  INSERT INTO stores (store_code, name, is_active, created_at)
  VALUES (@store_code, @name, @is_active, @created_at)
`);

export const listStores = () => listStoresStmt.all();

export const createStore = ({ storeCode, name, isActive = true }) => {
  createStoreStmt.run({
    store_code: String(storeCode).trim(),
    name: String(name).trim(),
    is_active: isActive ? 1 : 0,
    created_at: nowIso()
  });
  return getStoreByCodeStmt.get(String(storeCode).trim());
};

const readAliasesStmt = db.prepare(
  "SELECT alias FROM product_aliases WHERE product_id = ? ORDER BY alias ASC"
);

const listProductsStmt = db.prepare(`
  SELECT
    p.id, p.sku, p.name, p.name_en, p.producer, p.vintage, p.unit,
    p.retail_price, p.purchase_price, p.stock_qty, p.stock_store, p.supplier_name, p.cost_rate,
    p.created_at, p.updated_at
  FROM products p
  WHERE (
    @query = ''
    OR p.name LIKE @like
    OR IFNULL(p.name_en, '') LIKE @like
    OR IFNULL(p.producer, '') LIKE @like
    OR IFNULL(p.sku, '') LIKE @like
    OR EXISTS (
      SELECT 1
      FROM product_aliases pa
      WHERE pa.product_id = p.id AND pa.alias LIKE @like
    )
  )
  ORDER BY p.updated_at DESC
  LIMIT @limit
`);

export const listProducts = ({ query = "", limit = 200 } = {}) => {
  const q = String(query).trim();
  return listProductsStmt.all({
    query: q,
    like: `%${q}%`,
    limit: Number(limit)
  }).map((row) => ({
    ...row,
    aliases: readAliasesStmt.all(row.id).map((v) => v.alias)
  }));
};

const insertProductStmt = db.prepare(`
  INSERT INTO products (
    sku, name, name_en, producer, vintage, unit,
    retail_price, purchase_price, stock_qty, stock_store, supplier_name, cost_rate,
    created_at, updated_at
  )
  VALUES (
    @sku, @name, @name_en, @producer, @vintage, @unit,
    @retail_price, @purchase_price, @stock_qty, @stock_store, @supplier_name, @cost_rate,
    @created_at, @updated_at
  )
`);

const updateProductStmt = db.prepare(`
  UPDATE products
  SET
    sku = @sku,
    name = @name,
    name_en = @name_en,
    producer = @producer,
    vintage = @vintage,
    unit = @unit,
    retail_price = @retail_price,
    purchase_price = @purchase_price,
    stock_qty = @stock_qty,
    stock_store = @stock_store,
    supplier_name = @supplier_name,
    cost_rate = @cost_rate,
    updated_at = @updated_at
  WHERE id = @id
`);

const insertAliasStmt = db.prepare(`
  INSERT INTO product_aliases (product_id, alias)
  VALUES (?, ?)
  ON CONFLICT(product_id, alias) DO NOTHING
`);

const getProductByIdStmt = db.prepare(`
  SELECT
    id, sku, name, name_en, producer, vintage, unit,
    retail_price, purchase_price, stock_qty, stock_store, supplier_name, cost_rate,
    created_at, updated_at
  FROM products WHERE id = ?
`);

const buildProductWritePayload = (payload = {}) => ({
  sku: toNullableText(payload.sku),
  name: toNullableText(payload.name),
  name_en: toNullableText(payload.nameEn ?? payload.name_en),
  producer: toNullableText(payload.producer),
  vintage: toNullableText(payload.vintage),
  unit: toNullableText(payload.unit),
  retail_price: toNullableInteger(payload.retailPrice ?? payload.retail_price),
  purchase_price: toNullableInteger(payload.purchasePrice ?? payload.purchase_price),
  stock_qty: toNullableInteger(payload.stockQty ?? payload.stock_qty),
  stock_store: toNullableText(payload.stockStore ?? payload.stock_store),
  supplier_name: toNullableText(payload.supplierName ?? payload.supplier_name),
  cost_rate: toNullableReal(payload.costRate ?? payload.cost_rate)
});

const createProductTx = db.transaction((payload) => {
  const timestamp = nowIso();
  const normalized = buildProductWritePayload(payload);
  if (!normalized.name && !normalized.name_en) {
    throw new Error("name is required");
  }

  if (!normalized.name) {
    normalized.name = normalized.name_en;
  }
  const info = insertProductStmt.run({
    ...normalized,
    created_at: timestamp,
    updated_at: timestamp
  });

  const productId = Number(info.lastInsertRowid);
  const aliasCandidates = normalizeAliases([
    ...(Array.isArray(payload.aliases) ? payload.aliases : []),
    normalized.name,
    normalized.name_en
  ]);
  for (const alias of aliasCandidates) {
    insertAliasStmt.run(productId, alias);
  }

  return productId;
});

export const getProductById = (id) => {
  const row = getProductByIdStmt.get(Number(id));
  if (!row) {
    return null;
  }
  return {
    ...row,
    aliases: readAliasesStmt.all(row.id).map((v) => v.alias)
  };
};

export const createProduct = (payload) => {
  const id = createProductTx(payload);
  return getProductById(id);
};

const findCatalogProductByIdentityStmt = db.prepare(`
  SELECT p.id
  FROM products p
  LEFT JOIN product_aliases pa ON pa.product_id = p.id
  WHERE (
    @sku IS NOT NULL
    AND @sku <> ''
    AND IFNULL(p.sku, '') = @sku
  )
  OR (
    @name IS NOT NULL
    AND @name <> ''
    AND (
      p.name = @name
      OR IFNULL(p.name_en, '') = @name
      OR pa.alias = @name
    )
  )
  OR (
    @name_en IS NOT NULL
    AND @name_en <> ''
    AND (
      p.name = @name_en
      OR IFNULL(p.name_en, '') = @name_en
      OR pa.alias = @name_en
    )
  )
  ORDER BY p.updated_at DESC
  LIMIT 1
`);

const upsertCatalogProductTx = db.transaction((payload) => {
  const normalized = buildProductWritePayload(payload);
  if (!normalized.name && !normalized.name_en && !normalized.sku) {
    throw new Error("sku or name is required");
  }

  const lookupName = normalized.name || normalized.name_en || normalized.sku;
  const existing = findCatalogProductByIdentityStmt.get({
    sku: normalized.sku,
    name: normalized.name || lookupName,
    name_en: normalized.name_en || lookupName
  });

  if (!existing) {
    const id = createProductTx({
      ...normalized,
      name: normalized.name || normalized.name_en || lookupName,
      aliases: payload.aliases
    });
    return getProductById(id);
  }

  const current = getProductById(existing.id);
  const updated = {
    id: current.id,
    sku: normalized.sku ?? current.sku ?? null,
    name: normalized.name ?? current.name ?? normalized.name_en ?? current.name_en ?? lookupName,
    name_en: normalized.name_en ?? current.name_en ?? null,
    producer: normalized.producer ?? current.producer ?? null,
    vintage: normalized.vintage ?? current.vintage ?? null,
    unit: normalized.unit ?? current.unit ?? null,
    retail_price: normalized.retail_price ?? current.retail_price ?? null,
    purchase_price: normalized.purchase_price ?? current.purchase_price ?? null,
    stock_qty: normalized.stock_qty ?? current.stock_qty ?? null,
    stock_store: normalized.stock_store ?? current.stock_store ?? null,
    supplier_name: normalized.supplier_name ?? current.supplier_name ?? null,
    cost_rate: normalized.cost_rate ?? current.cost_rate ?? null,
    updated_at: nowIso()
  };

  updateProductStmt.run(updated);

  const aliasCandidates = normalizeAliases([
    ...(Array.isArray(current.aliases) ? current.aliases : []),
    ...(Array.isArray(payload.aliases) ? payload.aliases : []),
    updated.name,
    updated.name_en
  ]);
  for (const alias of aliasCandidates) {
    insertAliasStmt.run(current.id, alias);
  }

  return getProductById(current.id);
});

export const upsertCatalogProduct = (payload) => upsertCatalogProductTx(payload);

const listCurrentPricesStmt = db.prepare(`
  SELECT cp.product_id, p.name AS product_name, p.sku, p.producer, p.vintage,
         cp.store_id, s.store_code, s.name AS store_name,
         cp.latest_price, cp.currency, cp.effective_date, cp.updated_at
  FROM current_prices cp
  JOIN products p ON p.id = cp.product_id
  JOIN stores s ON s.id = cp.store_id
  WHERE (@productId IS NULL OR cp.product_id = @productId)
    AND (@storeId IS NULL OR cp.store_id = @storeId)
  ORDER BY cp.updated_at DESC
  LIMIT @limit
`);

export const listCurrentPrices = ({ productId = null, storeId = null, limit = 300 } = {}) => {
  return listCurrentPricesStmt.all({
    productId: productId ? Number(productId) : null,
    storeId: storeId ? Number(storeId) : null,
    limit: Number(limit)
  });
};

const listHistoryStmt = db.prepare(`
  SELECT ph.id, ph.product_id, p.name AS product_name, p.sku,
         ph.store_id, s.store_code, s.name AS store_name,
         ph.price, ph.currency, ph.effective_date,
         ph.source_file_id, ph.source_row_no, ph.created_by, ph.created_at
  FROM price_history ph
  JOIN products p ON p.id = ph.product_id
  JOIN stores s ON s.id = ph.store_id
  WHERE (@productId IS NULL OR ph.product_id = @productId)
    AND (@storeId IS NULL OR ph.store_id = @storeId)
  ORDER BY ph.created_at DESC
  LIMIT @limit
`);

export const listPriceHistory = ({ productId = null, storeId = null, limit = 300 } = {}) => {
  return listHistoryStmt.all({
    productId: productId ? Number(productId) : null,
    storeId: storeId ? Number(storeId) : null,
    limit: Number(limit)
  });
};

const getCurrentPriceStmt = db.prepare(
  "SELECT * FROM current_prices WHERE product_id = ? AND store_id = ?"
);

const insertHistoryStmt = db.prepare(`
  INSERT INTO price_history (
    product_id, store_id, price, currency, effective_date,
    source_file_id, source_row_no, created_by, created_at
  ) VALUES (
    @product_id, @store_id, @price, @currency, @effective_date,
    @source_file_id, @source_row_no, @created_by, @created_at
  )
`);

const upsertCurrentStmt = db.prepare(`
  INSERT INTO current_prices (
    product_id, store_id, latest_price, currency, effective_date, history_id, updated_at
  ) VALUES (
    @product_id, @store_id, @latest_price, @currency, @effective_date, @history_id, @updated_at
  )
  ON CONFLICT(product_id, store_id) DO UPDATE SET
    latest_price = excluded.latest_price,
    currency = excluded.currency,
    effective_date = excluded.effective_date,
    history_id = excluded.history_id,
    updated_at = excluded.updated_at
`);

const addPriceTx = db.transaction((payload) => {
  const createdAt = nowIso();

  const info = insertHistoryStmt.run({
    product_id: payload.productId,
    store_id: payload.storeId,
    price: payload.price,
    currency: payload.currency || "JPY",
    effective_date: payload.effectiveDate,
    source_file_id: payload.sourceFileId || null,
    source_row_no: payload.sourceRowNo || null,
    created_by: payload.createdBy || "admin",
    created_at: createdAt
  });

  const historyId = Number(info.lastInsertRowid);
  const existing = getCurrentPriceStmt.get(payload.productId, payload.storeId);
  const shouldUpdate =
    !existing ||
    payload.effectiveDate > existing.effective_date ||
    (payload.effectiveDate === existing.effective_date && createdAt >= existing.updated_at);

  if (shouldUpdate) {
    upsertCurrentStmt.run({
      product_id: payload.productId,
      store_id: payload.storeId,
      latest_price: payload.price,
      currency: payload.currency || "JPY",
      effective_date: payload.effectiveDate,
      history_id: historyId,
      updated_at: createdAt
    });
  }

  return historyId;
});

const getHistoryByIdStmt = db.prepare(`
  SELECT ph.id, ph.product_id, p.name AS product_name, p.sku,
         ph.store_id, s.store_code, s.name AS store_name,
         ph.price, ph.currency, ph.effective_date,
         ph.source_file_id, ph.source_row_no, ph.created_by, ph.created_at
  FROM price_history ph
  JOIN products p ON p.id = ph.product_id
  JOIN stores s ON s.id = ph.store_id
  WHERE ph.id = ?
`);

export const addPriceHistory = (payload) => {
  const historyId = addPriceTx(payload);
  return getHistoryByIdStmt.get(historyId);
};

const searchProductIdsStmt = db.prepare(`
  SELECT DISTINCT p.id
  FROM products p
  LEFT JOIN product_aliases pa ON pa.product_id = p.id
  WHERE p.name LIKE @like
     OR IFNULL(p.name_en, '') LIKE @like
     OR IFNULL(p.sku, '') LIKE @like
     OR IFNULL(p.producer, '') LIKE @like
     OR IFNULL(pa.alias, '') LIKE @like
  ORDER BY p.updated_at DESC
  LIMIT @limit
`);

const currentByIdsStmt = db.prepare(`
  SELECT cp.product_id, p.name AS product_name, p.sku, p.producer, p.vintage,
         cp.store_id, s.store_code, s.name AS store_name,
         cp.latest_price, cp.currency, cp.effective_date, cp.updated_at
  FROM current_prices cp
  JOIN products p ON p.id = cp.product_id
  JOIN stores s ON s.id = cp.store_id
  WHERE cp.product_id IN (SELECT value FROM json_each(@idsJson))
  ORDER BY p.name ASC, cp.latest_price ASC
`);

export const findCurrentPricesByQuery = (query, limitProducts = 3) => {
  const q = String(query).trim();
  if (!q) {
    return [];
  }

  const idRows = searchProductIdsStmt.all({
    like: `%${q}%`,
    limit: Number(limitProducts)
  });

  if (!idRows.length) {
    return [];
  }

  return currentByIdsStmt.all({ idsJson: JSON.stringify(idRows.map((v) => v.id)) });
};

const searchCatalogProductsStmt = db.prepare(`
  SELECT
    p.id, p.sku, p.name, p.name_en, p.producer, p.vintage, p.unit,
    p.retail_price, p.purchase_price, p.stock_qty, p.stock_store, p.supplier_name, p.cost_rate,
    p.created_at, p.updated_at
  FROM products p
  WHERE (
    p.name LIKE @like
    OR IFNULL(p.name_en, '') LIKE @like
    OR IFNULL(p.sku, '') LIKE @like
    OR IFNULL(p.producer, '') LIKE @like
    OR EXISTS (
      SELECT 1
      FROM product_aliases pa
      WHERE pa.product_id = p.id AND pa.alias LIKE @like
    )
  )
  ORDER BY
    CASE
      WHEN p.name = @exact OR IFNULL(p.name_en, '') = @exact OR EXISTS (
        SELECT 1 FROM product_aliases pa WHERE pa.product_id = p.id AND pa.alias = @exact
      ) THEN 0
      WHEN p.name LIKE @prefix OR IFNULL(p.name_en, '') LIKE @prefix OR EXISTS (
        SELECT 1 FROM product_aliases pa WHERE pa.product_id = p.id AND pa.alias LIKE @prefix
      ) THEN 1
      ELSE 2
    END,
    p.updated_at DESC
  LIMIT @limit
`);

export const findCatalogProductsByQuery = (query, limit = 5) => {
  const q = String(query).trim();
  if (!q) {
    return [];
  }
  return searchCatalogProductsStmt
    .all({
      like: `%${q}%`,
      exact: q,
      prefix: `${q}%`,
      limit: Number(limit) || 5
    })
    .map((row) => ({
      ...row,
      aliases: readAliasesStmt.all(row.id).map((v) => v.alias)
    }));
};

const listReplyTemplatesStmt = db.prepare(`
  SELECT id, template_key, body, is_active, updated_at
  FROM line_reply_templates
  ORDER BY template_key ASC
`);

export const listReplyTemplates = () => listReplyTemplatesStmt.all();

const upsertTemplateStmt = db.prepare(`
  INSERT INTO line_reply_templates (template_key, body, is_active, updated_at)
  VALUES (@template_key, @body, @is_active, @updated_at)
  ON CONFLICT(template_key) DO UPDATE SET
    body = excluded.body,
    is_active = excluded.is_active,
    updated_at = excluded.updated_at
`);

const getTemplateByKeyStmt = db.prepare(
  "SELECT id, template_key, body, is_active, updated_at FROM line_reply_templates WHERE template_key = ?"
);

export const upsertReplyTemplate = ({ templateKey, body, isActive = true }) => {
  upsertTemplateStmt.run({
    template_key: String(templateKey).trim(),
    body: String(body),
    is_active: isActive ? 1 : 0,
    updated_at: nowIso()
  });
  return getTemplateByKeyStmt.get(String(templateKey).trim());
};

const getActiveTemplateByKeyStmt = db.prepare(
  "SELECT id, template_key, body, is_active, updated_at FROM line_reply_templates WHERE template_key = ? AND is_active = 1"
);

export const getActiveReplyTemplateByKey = (templateKey) =>
  getActiveTemplateByKeyStmt.get(String(templateKey).trim());

export const renderTemplate = (body, variables) =>
  String(body).replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    const value = variables[key];
    return value === undefined || value === null ? "" : String(value);
  });

export const resolveStoreId = ({ storeId = null, storeCode = "", storeName = "" }) => {
  if (storeId) {
    const row = getStoreByIdStmt.get(Number(storeId));
    return row ? row.id : null;
  }

  const code = String(storeCode).trim();
  if (code) {
    const row = getStoreByCodeStmt.get(code);
    return row ? row.id : null;
  }

  const name = String(storeName).trim();
  if (!name) {
    return null;
  }

  const created = createStore({
    storeCode: `AUTO_${Date.now()}`,
    name,
    isActive: true
  });
  return created.id;
};

const insertLineEventStmt = db.prepare(`
  INSERT INTO line_events (event_id, event_type, user_id, payload_json, created_at)
  VALUES (@event_id, @event_type, @user_id, @payload_json, @created_at)
  ON CONFLICT(event_id) DO NOTHING
`);

export const saveLineEvent = (event) => {
  const info = insertLineEventStmt.run({
    event_id: String(event.webhookEventId || "").trim(),
    event_type: String(event.type || "unknown"),
    user_id: event.source?.userId || null,
    payload_json: JSON.stringify(event),
    created_at: nowIso()
  });
  return info.changes > 0;
};

const insertOcrResultStmt = db.prepare(`
  INSERT INTO ocr_results (line_event_id, image_id, extracted_text, guessed_product_id, confidence, created_at)
  VALUES (@line_event_id, @image_id, @extracted_text, @guessed_product_id, @confidence, @created_at)
`);

export const saveOcrResult = ({
  lineEventId = null,
  imageId = null,
  extractedText = "",
  guessedProductId = null,
  confidence = null
}) => {
  insertOcrResultStmt.run({
    line_event_id: lineEventId,
    image_id: imageId,
    extracted_text: String(extractedText),
    guessed_product_id: guessedProductId ? Number(guessedProductId) : null,
    confidence: confidence === null || confidence === undefined ? null : Number(confidence),
    created_at: nowIso()
  });
};

export const backupDatabaseTo = (destinationPath) => {
  const safePath = String(destinationPath || "").replace(/'/g, "''");
  if (!safePath) {
    throw new Error("destinationPath is required");
  }

  db.pragma("wal_checkpoint(FULL)");
  db.exec(`VACUUM INTO '${safePath}'`);
  return destinationPath;
};

const getProductBySkuStmt = db.prepare(
  "SELECT id, sku, name FROM products WHERE sku = ? LIMIT 1"
);

const getProductByNameOrAliasStmt = db.prepare(`
  SELECT p.id, p.sku, p.name
  FROM products p
  LEFT JOIN product_aliases pa ON pa.product_id = p.id
  WHERE p.name = @name
     OR IFNULL(p.name_en, '') = @name
     OR LOWER(p.name) = LOWER(@name)
     OR LOWER(IFNULL(p.name_en, '')) = LOWER(@name)
     OR pa.alias = @name
     OR LOWER(IFNULL(pa.alias, '')) = LOWER(@name)
  ORDER BY p.updated_at DESC
  LIMIT 1
`);

export const resolveProductId = ({ productId = null, sku = "", name = "" }) => {
  if (productId) {
    const row = getProductByIdStmt.get(Number(productId));
    return row ? row.id : null;
  }

  const normalizedSku = String(sku).trim();
  if (normalizedSku) {
    const row = getProductBySkuStmt.get(normalizedSku);
    if (row) {
      return row.id;
    }
  }

  const normalizedName = String(name).trim();
  if (!normalizedName) {
    return null;
  }

  const row = getProductByNameOrAliasStmt.get({ name: normalizedName });
  return row ? row.id : null;
};

const insertIngestionFileStmt = db.prepare(`
  INSERT INTO ingestion_files (
    store_id, file_name, file_hash, period_ym, status,
    total_rows, accepted_rows, rejected_rows, uploaded_by, uploaded_at
  ) VALUES (
    @store_id, @file_name, @file_hash, @period_ym, @status,
    @total_rows, @accepted_rows, @rejected_rows, @uploaded_by, @uploaded_at
  )
`);

const getIngestionFileByIdStmt = db.prepare(`
  SELECT f.id, f.store_id, s.store_code, s.name AS store_name,
         f.file_name, f.file_hash, f.period_ym, f.status,
         f.total_rows, f.accepted_rows, f.rejected_rows,
         f.uploaded_by, f.uploaded_at
  FROM ingestion_files f
  LEFT JOIN stores s ON s.id = f.store_id
  WHERE f.id = ?
`);

const getIngestionFileByHashStmt = db.prepare(`
  SELECT f.id, f.store_id, s.store_code, s.name AS store_name,
         f.file_name, f.file_hash, f.period_ym, f.status,
         f.total_rows, f.accepted_rows, f.rejected_rows,
         f.uploaded_by, f.uploaded_at
  FROM ingestion_files f
  LEFT JOIN stores s ON s.id = f.store_id
  WHERE f.file_hash = ?
`);

const updateIngestionFileStmt = db.prepare(`
  UPDATE ingestion_files
  SET status = @status,
      total_rows = @total_rows,
      accepted_rows = @accepted_rows,
      rejected_rows = @rejected_rows
  WHERE id = @id
`);

export const createIngestionFile = ({
  storeId = null,
  fileName,
  fileHash,
  periodYm = null,
  uploadedBy = "admin",
  status = "PENDING",
  totalRows = 0
}) => {
  insertIngestionFileStmt.run({
    store_id: storeId ? Number(storeId) : null,
    file_name: String(fileName || "upload.csv").trim(),
    file_hash: String(fileHash).trim(),
    period_ym: periodYm ? String(periodYm).trim() : null,
    status: String(status).trim(),
    total_rows: Number(totalRows) || 0,
    accepted_rows: 0,
    rejected_rows: 0,
    uploaded_by: String(uploadedBy || "admin").trim() || "admin",
    uploaded_at: nowIso()
  });

  const latest = getIngestionFileByHashStmt.get(String(fileHash).trim());
  return latest || null;
};

export const getIngestionFileByHash = (fileHash) =>
  getIngestionFileByHashStmt.get(String(fileHash).trim());

export const completeIngestionFile = ({
  id,
  status,
  totalRows = 0,
  acceptedRows = 0,
  rejectedRows = 0
}) => {
  updateIngestionFileStmt.run({
    id: Number(id),
    status: String(status).trim(),
    total_rows: Number(totalRows) || 0,
    accepted_rows: Number(acceptedRows) || 0,
    rejected_rows: Number(rejectedRows) || 0
  });
  return getIngestionFileByIdStmt.get(Number(id));
};

const insertIngestionErrorStmt = db.prepare(`
  INSERT INTO ingestion_errors (
    ingestion_file_id, row_no, error_code, error_message, raw_payload, created_at
  ) VALUES (
    @ingestion_file_id, @row_no, @error_code, @error_message, @raw_payload, @created_at
  )
`);

export const addIngestionError = ({
  ingestionFileId,
  rowNo = null,
  errorCode,
  errorMessage = "",
  rawPayload = null
}) => {
  insertIngestionErrorStmt.run({
    ingestion_file_id: Number(ingestionFileId),
    row_no: rowNo === null || rowNo === undefined ? null : Number(rowNo),
    error_code: String(errorCode).trim(),
    error_message: String(errorMessage || "").trim() || null,
    raw_payload: rawPayload === null || rawPayload === undefined ? null : String(rawPayload),
    created_at: nowIso()
  });
};

const listIngestionFilesStmt = db.prepare(`
  SELECT f.id, f.store_id, s.store_code, s.name AS store_name,
         f.file_name, f.file_hash, f.period_ym, f.status,
         f.total_rows, f.accepted_rows, f.rejected_rows,
         f.uploaded_by, f.uploaded_at
  FROM ingestion_files f
  LEFT JOIN stores s ON s.id = f.store_id
  ORDER BY f.uploaded_at DESC
  LIMIT @limit
`);

export const listIngestionFiles = ({ limit = 200 } = {}) =>
  listIngestionFilesStmt.all({ limit: Number(limit) || 200 });

const listIngestionErrorsStmt = db.prepare(`
  SELECT id, ingestion_file_id, row_no, error_code, error_message, raw_payload, created_at
  FROM ingestion_errors
  WHERE ingestion_file_id = @ingestion_file_id
  ORDER BY row_no ASC, id ASC
  LIMIT @limit
`);

export const listIngestionErrors = ({ ingestionFileId, limit = 500 } = {}) =>
  listIngestionErrorsStmt.all({
    ingestion_file_id: Number(ingestionFileId),
    limit: Number(limit) || 500
  });

const getStoreCsvMappingStmt = db.prepare(`
  SELECT m.store_id, s.store_code, s.name AS store_name,
         m.header_mapping_json, m.delimiter, m.updated_by, m.updated_at
  FROM store_csv_mappings m
  JOIN stores s ON s.id = m.store_id
  WHERE m.store_id = ?
`);

const upsertStoreCsvMappingStmt = db.prepare(`
  INSERT INTO store_csv_mappings (
    store_id, header_mapping_json, delimiter, updated_by, updated_at
  ) VALUES (
    @store_id, @header_mapping_json, @delimiter, @updated_by, @updated_at
  )
  ON CONFLICT(store_id) DO UPDATE SET
    header_mapping_json = excluded.header_mapping_json,
    delimiter = excluded.delimiter,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
`);

const listStoreCsvMappingsStmt = db.prepare(`
  SELECT m.store_id, s.store_code, s.name AS store_name,
         m.header_mapping_json, m.delimiter, m.updated_by, m.updated_at
  FROM store_csv_mappings m
  JOIN stores s ON s.id = m.store_id
  ORDER BY m.updated_at DESC
  LIMIT @limit
`);

const normalizeStoreCsvMappingRow = (row) => {
  if (!row) {
    return null;
  }

  let headerMapping = {};
  try {
    headerMapping = JSON.parse(row.header_mapping_json || "{}");
  } catch {
    headerMapping = {};
  }

  return {
    ...row,
    header_mapping: headerMapping
  };
};

export const getStoreCsvMapping = (storeId) =>
  normalizeStoreCsvMappingRow(getStoreCsvMappingStmt.get(Number(storeId)));

export const upsertStoreCsvMapping = ({
  storeId,
  headerMapping,
  delimiter = null,
  updatedBy = "admin"
}) => {
  upsertStoreCsvMappingStmt.run({
    store_id: Number(storeId),
    header_mapping_json: JSON.stringify(headerMapping || {}),
    delimiter: delimiter ? String(delimiter).trim() : null,
    updated_by: String(updatedBy || "admin").trim() || "admin",
    updated_at: nowIso()
  });
  return getStoreCsvMapping(Number(storeId));
};

export const listStoreCsvMappings = ({ limit = 200 } = {}) =>
  listStoreCsvMappingsStmt
    .all({ limit: Number(limit) || 200 })
    .map((row) => normalizeStoreCsvMappingRow(row));
