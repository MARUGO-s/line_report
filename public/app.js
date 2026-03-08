const flashEl = document.getElementById("flash");
const systemStatusEl = document.getElementById("systemStatus");

const authForm = document.getElementById("authForm");
const clearTokenBtn = document.getElementById("clearTokenBtn");
const authStatusEl = document.getElementById("authStatus");

const backupForm = document.getElementById("backupForm");
const backupsTable = document.getElementById("backupsTable");
const backupResult = document.getElementById("backupResult");

const storeForm = document.getElementById("storeForm");
const storesTable = document.getElementById("storesTable");

const productForm = document.getElementById("productForm");
const productSearchEl = document.getElementById("productSearch");
const refreshProductsButton = document.getElementById("refreshProducts");
const productsTable = document.getElementById("productsTable");

const priceForm = document.getElementById("priceForm");
const currentPricesTable = document.getElementById("currentPricesTable");

const templateForm = document.getElementById("templateForm");
const templatesTable = document.getElementById("templatesTable");

const csvIngestionForm = document.getElementById("csvIngestionForm");
const csvIngestionResult = document.getElementById("csvIngestionResult");
const ingestionFilesTable = document.getElementById("ingestionFilesTable");
const ingestionErrorsResult = document.getElementById("ingestionErrorsResult");

const csvMappingForm = document.getElementById("csvMappingForm");
const loadCsvMappingBtn = document.getElementById("loadCsvMappingBtn");
const csvMappingResult = document.getElementById("csvMappingResult");

const simulateForm = document.getElementById("simulateForm");
const simulateResult = document.getElementById("simulateResult");
const ocrResolveForm = document.getElementById("ocrResolveForm");
const ocrResolveResult = document.getElementById("ocrResolveResult");

const downloadTemplateBtn = document.getElementById("downloadTemplateBtn");

const STORAGE_ADMIN_TOKEN_KEY = "line_wine_admin_token";

const readStoredAdminToken = () => {
  try {
    return String(localStorage.getItem(STORAGE_ADMIN_TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
};

const writeStoredAdminToken = (value) => {
  try {
    if (value) {
      localStorage.setItem(STORAGE_ADMIN_TOKEN_KEY, value);
    } else {
      localStorage.removeItem(STORAGE_ADMIN_TOKEN_KEY);
    }
  } catch {
    // ignore storage errors in private mode
  }
};

const state = {
  adminToken: readStoredAdminToken(),
  adminAuthRequired: false
};

const buildAuthHeaders = () => (state.adminToken ? { "x-admin-token": state.adminToken } : {});

class ApiError extends Error {
  constructor(message, status, bodyText) {
    super(message);
    this.name = "ApiError";
    this.status = Number(status) || 0;
    this.bodyText = String(bodyText || "");
  }
}

const parseApiErrorMessage = (status, bodyText) => {
  if (!bodyText) {
    return `HTTP ${status}`;
  }

  try {
    const parsed = JSON.parse(bodyText);
    if (parsed?.error) {
      return String(parsed.error);
    }
  } catch {
    // not json
  }

  return bodyText.length > 300 ? `${bodyText.slice(0, 300)}...` : bodyText;
};

const api = {
  async request(path, { method = "GET", headers = {}, body, responseType = "json" } = {}) {
    const response = await fetch(path, {
      method,
      headers: {
        ...buildAuthHeaders(),
        ...headers
      },
      body
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new ApiError(parseApiErrorMessage(response.status, bodyText), response.status, bodyText);
    }

    if (responseType === "blob") {
      return {
        blob: await response.blob(),
        disposition: String(response.headers.get("content-disposition") || "")
      };
    }

    if (responseType === "text") {
      return response.text();
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  },
  async get(path) {
    return this.request(path);
  },
  async post(path, body) {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  },
  async getBlob(path) {
    return this.request(path, { responseType: "blob" });
  }
};

const previewData = {
  stores: [{ id: 1, store_code: "SHINJUKU", name: "新宿店" }],
  products: [
    {
      id: 1,
      sku: "WINE-0001",
      name: "Chablis Premier Cru",
      producer: "Domaine X",
      vintage: "2022",
      aliases: ["シャブリ"]
    }
  ],
  currentPrices: [
    {
      product_id: 1,
      product_name: "Chablis Premier Cru",
      sku: "WINE-0001",
      producer: "Domaine X",
      vintage: "2022",
      store_id: 1,
      store_code: "SHINJUKU",
      store_name: "新宿店",
      latest_price: 4400,
      currency: "JPY",
      effective_date: "2026-03-22",
      updated_at: "2026-03-08T10:42:23.298Z"
    }
  ],
  templates: [
    { id: 1, template_key: "price_found", is_active: 1, updated_at: "2026-03-08T10:00:00.000Z" },
    {
      id: 2,
      template_key: "price_not_found",
      is_active: 1,
      updated_at: "2026-03-08T10:00:00.000Z"
    },
    {
      id: 3,
      template_key: "image_received",
      is_active: 1,
      updated_at: "2026-03-08T10:00:00.000Z"
    }
  ],
  ingestionFiles: [
    {
      id: 2,
      file_name: "import_jp_header_2026-03.csv",
      status: "SUCCESS",
      total_rows: 2,
      accepted_rows: 2,
      rejected_rows: 0,
      uploaded_at: "2026-03-08T10:42:23.297Z"
    },
    {
      id: 1,
      file_name: "import_2026-03.csv",
      status: "PARTIAL",
      total_rows: 2,
      accepted_rows: 1,
      rejected_rows: 1,
      uploaded_at: "2026-03-08T10:38:35.068Z"
    }
  ],
  ingestionErrorsByFile: {
    "1": {
      items: [
        {
          id: 1,
          ingestion_file_id: 1,
          row_no: 3,
          error_code: "PRODUCT_NOT_FOUND",
          error_message: "product_id / sku / product_name から商品を特定できません"
        }
      ]
    },
    "2": { items: [] }
  },
  mappingsByStore: {
    "1": {
      store_id: 1,
      store_code: "SHINJUKU",
      store_name: "新宿店",
      delimiter: null,
      header_mapping: {
        商品コード: "sku",
        商品名: "product_name",
        店舗コード: "store_code",
        価格: "price",
        適用日: "effective_date"
      }
    }
  },
  backups: [
    {
      fileName: "wine_price_20260308_194523_before_release.db",
      sizeBytes: 118784,
      createdAt: "2026-03-08T10:45:23.000Z"
    }
  ]
};

let isStaticPreview = false;

const notify = (message, isError = false) => {
  flashEl.textContent = message;
  flashEl.className = isError ? "flash error" : "flash";
};

const isAuthError = (error) => error instanceof ApiError && error.status === 401;

const handleAuthError = () => {
  updateAuthStatus("認証エラー: ADMIN_TOKENを確認してください。");
  notify("認証エラー: 管理トークンが無効です。", true);
};

const handleOperationError = (prefix, error) => {
  if (isAuthError(error)) {
    handleAuthError();
    return;
  }
  notify(`${prefix}: ${error.message}`, true);
};

const syncAuthInput = () => {
  authForm.elements.adminToken.value = state.adminToken;
};

const updateAuthStatus = (message = "") => {
  if (isStaticPreview) {
    authStatusEl.textContent = "静的プレビューでは認証確認は行いません。";
    return;
  }

  if (message) {
    authStatusEl.textContent = message;
    return;
  }

  if (!state.adminAuthRequired) {
    authStatusEl.textContent = "このサーバーでは管理認証は任意です。";
    return;
  }

  authStatusEl.textContent = state.adminToken
    ? "管理認証が有効です。保存済みトークンで接続します。"
    : "管理認証が必須です。ADMIN_TOKEN を入力して保存してください。";
};

const safeDate = (value) => {
  if (!value) {
    return "-";
  }
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) {
    return value;
  }
  return d.toLocaleString("ja-JP");
};

const formatBytes = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return "-";
  }
  if (num < 1024) {
    return `${num} B`;
  }
  if (num < 1024 * 1024) {
    return `${(num / 1024).toFixed(1)} KB`;
  }
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
};

const renderStores = (items) => {
  storesTable.innerHTML = "";
  if (!items.length) {
    storesTable.innerHTML = '<tr><td colspan="3">データがありません</td></tr>';
    return;
  }

  for (const item of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.id}</td>
      <td>${item.store_code}</td>
      <td>${item.name}</td>
    `;
    storesTable.appendChild(tr);
  }
};

const renderProducts = (items) => {
  productsTable.innerHTML = "";
  if (!items.length) {
    productsTable.innerHTML = '<tr><td colspan="4">データがありません</td></tr>';
    return;
  }

  for (const item of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.id}</td>
      <td>${item.sku ?? ""}</td>
      <td>${item.name}</td>
      <td>${(item.aliases || []).join(", ")}</td>
    `;
    productsTable.appendChild(tr);
  }
};

const renderCurrentPrices = (items) => {
  currentPricesTable.innerHTML = "";
  if (!items.length) {
    currentPricesTable.innerHTML = '<tr><td colspan="4">データがありません</td></tr>';
    return;
  }

  for (const item of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.product_name}</td>
      <td>${item.store_name}</td>
      <td>${Number(item.latest_price).toLocaleString("ja-JP")}円</td>
      <td>${item.effective_date}</td>
    `;
    currentPricesTable.appendChild(tr);
  }
};

const renderTemplates = (items) => {
  templatesTable.innerHTML = "";
  if (!items.length) {
    templatesTable.innerHTML = '<tr><td colspan="4">データがありません</td></tr>';
    return;
  }

  for (const item of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.id}</td>
      <td><code>${item.template_key}</code></td>
      <td>${item.is_active ? "有効" : "無効"}</td>
      <td>${safeDate(item.updated_at)}</td>
    `;
    templatesTable.appendChild(tr);
  }
};

const renderIngestionFiles = (items) => {
  ingestionFilesTable.innerHTML = "";
  if (!items.length) {
    ingestionFilesTable.innerHTML = '<tr><td colspan="5">データがありません</td></tr>';
    return;
  }

  for (const item of items) {
    const tr = document.createElement("tr");
    tr.dataset.ingestionId = item.id;
    tr.style.cursor = "pointer";
    tr.innerHTML = `
      <td>${item.id}</td>
      <td>${item.file_name}</td>
      <td>${item.status}</td>
      <td>${item.accepted_rows}/${item.total_rows} (err:${item.rejected_rows})</td>
      <td>${safeDate(item.uploaded_at)}</td>
    `;
    ingestionFilesTable.appendChild(tr);
  }
};

const renderBackups = (items) => {
  backupsTable.innerHTML = "";
  if (!items.length) {
    backupsTable.innerHTML = '<tr><td colspan="3">バックアップはありません</td></tr>';
    return;
  }

  for (const item of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.fileName}</td>
      <td>${formatBytes(item.sizeBytes)}</td>
      <td>${safeDate(item.createdAt)}</td>
    `;
    backupsTable.appendChild(tr);
  }
};

const findPreviewMatches = (query) => {
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return [];
  }

  return previewData.currentPrices.filter((item) => {
    const names = [
      item.product_name,
      item.sku,
      item.producer,
      ...(previewData.products.find((p) => p.id === item.product_id)?.aliases || [])
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();

    return names.includes(q);
  });
};

const buildPreviewSimulate = (query) => {
  const q = String(query || "").trim();
  const matches = findPreviewMatches(q);
  if (!matches.length) {
    return {
      query: q,
      message: `${q} に一致する価格が見つかりませんでした。`,
      matches: []
    };
  }

  const lines = matches
    .slice(0, 5)
    .map((item) => `・${item.store_name}: ${Number(item.latest_price).toLocaleString("ja-JP")}円 (${item.effective_date})`)
    .join("\n");

  return {
    query: q,
    message: `${matches[0].product_name} の最新価格です。\n${lines}`,
    matches
  };
};

const buildPreviewOcrResolve = (text) => {
  const raw = String(text || "").trim();
  const candidates = [
    raw,
    ...raw
      .split(/[\n\r,，、/|]/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
  ];

  for (const candidate of candidates) {
    const simulated = buildPreviewSimulate(candidate);
    if (simulated.matches.length) {
      return {
        queryUsed: candidate,
        extractedText: raw,
        message: simulated.message,
        matches: simulated.matches
      };
    }
  }

  return {
    queryUsed: candidates[0] || "",
    extractedText: raw,
    message: `OCR結果から価格を照合できませんでした。\n抽出候補: ${candidates[0] || ""}`,
    matches: []
  };
};

const extractFileNameFromDisposition = (dispositionHeader, fallback = "download.csv") => {
  const raw = String(dispositionHeader || "");
  const utf8Match = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1].trim());
  }
  const plainMatch = raw.match(/filename="?([^\";]+)"?/i);
  if (plainMatch?.[1]) {
    return plainMatch[1].trim();
  }
  return fallback;
};

const saveBlobToFile = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

const disableMutationFormsForStaticPreview = () => {
  const forms = [
    authForm,
    backupForm,
    storeForm,
    productForm,
    priceForm,
    templateForm,
    csvIngestionForm,
    csvMappingForm
  ];
  for (const form of forms) {
    for (const element of form.elements) {
      element.disabled = true;
    }
  }
  loadCsvMappingBtn.disabled = true;
  downloadTemplateBtn.disabled = true;
};

const activateStaticPreviewMode = (reason = "") => {
  isStaticPreview = true;
  systemStatusEl.textContent = "GitHub Pages 静的プレビューモード（保存APIは無効）";
  disableMutationFormsForStaticPreview();

  renderStores(previewData.stores);
  renderProducts(previewData.products);
  renderCurrentPrices(previewData.currentPrices);
  renderTemplates(previewData.templates);
  renderIngestionFiles(previewData.ingestionFiles);
  renderBackups(previewData.backups);

  updateAuthStatus();
  backupResult.textContent = "静的プレビューではバックアップAPIは利用できません。";
  csvIngestionResult.textContent = "静的プレビューではCSV取り込みAPIは利用できません。";
  ingestionErrorsResult.textContent = "履歴行をクリックするとデモのエラー詳細を表示します。";
  csvMappingResult.textContent = "静的プレビューではマッピング保存APIは利用できません。";

  const suffix = reason ? ` (${reason})` : "";
  notify(`静的プレビューモードで表示中です${suffix}`);
};

const loadSystem = async () => {
  if (isStaticPreview) {
    return;
  }

  const result = await api.get("/api/health");
  state.adminAuthRequired = Boolean(result.adminAuthRequired);
  updateAuthStatus();
  systemStatusEl.textContent = `${result.host}:${result.port} / Auth: ${result.adminAuthRequired ? (state.adminToken ? "ON" : "REQUIRED") : "OFF"} / Webhook: ${result.lineWebhookReady ? "OK" : "NG"} / Reply: ${result.lineReplyReady ? "OK" : "NG"} / OCR: ${result.ocrEndpointReady ? "OK" : "NG"} / Backup保持: ${result.backupRetention}`;
};

const loadStores = async () => {
  if (isStaticPreview) {
    renderStores(previewData.stores);
    return;
  }

  const result = await api.get("/api/stores");
  renderStores(result.items || []);
};

const loadProducts = async () => {
  const q = productSearchEl.value.trim();

  if (isStaticPreview) {
    const filtered = q
      ? previewData.products.filter((item) => {
          const text = [item.name, item.sku, item.producer, ...(item.aliases || [])]
            .filter(Boolean)
            .join("\n")
            .toLowerCase();
          return text.includes(q.toLowerCase());
        })
      : previewData.products;
    renderProducts(filtered);
    return;
  }

  const result = await api.get(`/api/products?query=${encodeURIComponent(q)}`);
  renderProducts(result.items || []);
};

const loadCurrentPrices = async () => {
  if (isStaticPreview) {
    renderCurrentPrices(previewData.currentPrices);
    return;
  }

  const result = await api.get("/api/prices/current?limit=100");
  renderCurrentPrices(result.items || []);
};

const loadTemplates = async () => {
  if (isStaticPreview) {
    renderTemplates(previewData.templates);
    return;
  }

  const result = await api.get("/api/reply-templates");
  renderTemplates(result.items || []);
};

const loadIngestionFiles = async () => {
  if (isStaticPreview) {
    renderIngestionFiles(previewData.ingestionFiles);
    return;
  }

  const result = await api.get("/api/ingestion/files?limit=100");
  renderIngestionFiles(result.items || []);
};

const loadBackups = async () => {
  if (isStaticPreview) {
    renderBackups(previewData.backups);
    return;
  }

  const result = await api.get("/api/admin/backups");
  renderBackups(result.items || []);
};

const clearProtectedViews = () => {
  renderStores([]);
  renderProducts([]);
  renderCurrentPrices([]);
  renderTemplates([]);
  renderIngestionFiles([]);
  renderBackups([]);
  backupResult.textContent = "認証後にバックアップを実行できます。";
  csvIngestionResult.textContent = "認証後にCSV取り込みを実行できます。";
  ingestionErrorsResult.textContent = "認証後にエラー詳細を表示できます。";
  csvMappingResult.textContent = "認証後にマッピングを保存できます。";
};

const loadProtectedData = async () => {
  await Promise.all([
    loadStores(),
    loadProducts(),
    loadCurrentPrices(),
    loadTemplates(),
    loadIngestionFiles(),
    loadBackups()
  ]);
};

const loadIngestionErrors = async (ingestionFileId) => {
  if (isStaticPreview) {
    const result = previewData.ingestionErrorsByFile[String(ingestionFileId)] || { items: [] };
    ingestionErrorsResult.textContent = JSON.stringify(result, null, 2);
    return;
  }

  const result = await api.get(`/api/ingestion/files/${encodeURIComponent(ingestionFileId)}/errors`);
  ingestionErrorsResult.textContent = JSON.stringify(result, null, 2);
};

const normalizeDelimiterValue = (value) => {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  if (text.toUpperCase() === "TAB" || text === "\\t") {
    return "\t";
  }
  return text;
};

const loadCsvMapping = async (storeId) => {
  if (isStaticPreview) {
    const result = previewData.mappingsByStore[String(storeId)];
    if (!result) {
      throw new Error("preview mapping not found");
    }
    csvMappingResult.textContent = JSON.stringify(result, null, 2);
    csvMappingForm.elements.headerMappingJson.value = JSON.stringify(result.header_mapping || {}, null, 2);
    csvMappingForm.elements.delimiter.value = result.delimiter || "";
    return result;
  }

  const result = await api.get(`/api/ingestion/mappings/${encodeURIComponent(storeId)}`);
  csvMappingResult.textContent = JSON.stringify(result, null, 2);
  csvMappingForm.elements.headerMappingJson.value = JSON.stringify(result.header_mapping || {}, null, 2);
  csvMappingForm.elements.delimiter.value = result.delimiter || "";
  return result;
};

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isStaticPreview) {
    notify("静的プレビューでは認証設定は利用できません。", true);
    return;
  }

  const formData = new FormData(authForm);
  state.adminToken = String(formData.get("adminToken") || "").trim();
  writeStoredAdminToken(state.adminToken);
  updateAuthStatus();

  try {
    await loadSystem();
    await loadProtectedData();
    notify("管理認証トークンを保存しました。");
  } catch (error) {
    handleOperationError("認証確認に失敗", error);
  }
});

clearTokenBtn.addEventListener("click", async () => {
  if (isStaticPreview) {
    notify("静的プレビューでは認証設定は利用できません。", true);
    return;
  }

  state.adminToken = "";
  writeStoredAdminToken("");
  syncAuthInput();
  updateAuthStatus();

  if (state.adminAuthRequired) {
    clearProtectedViews();
    notify("管理トークンをクリアしました。", false);
    return;
  }

  try {
    await loadProtectedData();
    notify("管理トークンをクリアしました。");
  } catch (error) {
    handleOperationError("再読込に失敗", error);
  }
});

backupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isStaticPreview) {
    notify("静的プレビューではバックアップ実行できません。", true);
    return;
  }

  const formData = new FormData(backupForm);
  const reason = String(formData.get("reason") || "").trim() || "manual";

  try {
    const result = await api.post("/api/admin/backup", { reason });
    backupResult.textContent = JSON.stringify(result, null, 2);
    await loadBackups();
    notify("バックアップを作成しました。");
  } catch (error) {
    handleOperationError("バックアップ作成に失敗", error);
  }
});

downloadTemplateBtn.addEventListener("click", async () => {
  if (isStaticPreview) {
    notify("静的プレビューではCSVテンプレート取得は利用できません。", true);
    return;
  }

  try {
    const response = await api.getBlob("/api/ingestion/template");
    const fileName = extractFileNameFromDisposition(response.disposition, "wine_price_template.csv");
    saveBlobToFile(response.blob, fileName);
    notify("テンプレートCSVをダウンロードしました。");
  } catch (error) {
    handleOperationError("テンプレートCSV取得に失敗", error);
  }
});

storeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isStaticPreview) {
    notify("静的プレビューでは店舗保存できません。", true);
    return;
  }

  const formData = new FormData(storeForm);

  try {
    await api.post("/api/stores", {
      storeCode: String(formData.get("storeCode") || "").trim(),
      name: String(formData.get("name") || "").trim()
    });
    storeForm.reset();
    await loadStores();
    notify("店舗を保存しました。");
  } catch (error) {
    handleOperationError("店舗保存に失敗", error);
  }
});

productForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isStaticPreview) {
    notify("静的プレビューでは商品保存できません。", true);
    return;
  }

  const formData = new FormData(productForm);
  const aliasesRaw = String(formData.get("aliases") || "").trim();

  try {
    await api.post("/api/products", {
      sku: String(formData.get("sku") || "").trim(),
      name: String(formData.get("name") || "").trim(),
      producer: String(formData.get("producer") || "").trim(),
      vintage: String(formData.get("vintage") || "").trim(),
      aliases: aliasesRaw ? aliasesRaw.split(",").map((v) => v.trim()) : []
    });
    productForm.reset();
    await loadProducts();
    notify("商品を保存しました。");
  } catch (error) {
    handleOperationError("商品保存に失敗", error);
  }
});

priceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isStaticPreview) {
    notify("静的プレビューでは価格保存できません。", true);
    return;
  }

  const formData = new FormData(priceForm);

  try {
    await api.post("/api/prices", {
      productId: Number(formData.get("productId")),
      storeId: Number(formData.get("storeId")),
      price: Number(formData.get("price")),
      effectiveDate: String(formData.get("effectiveDate") || "").trim(),
      createdBy: "admin"
    });
    priceForm.reset();
    await loadCurrentPrices();
    notify("価格を保存しました。");
  } catch (error) {
    handleOperationError("価格保存に失敗", error);
  }
});

templateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isStaticPreview) {
    notify("静的プレビューではテンプレート保存できません。", true);
    return;
  }

  const formData = new FormData(templateForm);

  try {
    await api.post("/api/reply-templates", {
      templateKey: String(formData.get("templateKey") || "").trim(),
      body: String(formData.get("body") || "").trim()
    });
    templateForm.reset();
    await loadTemplates();
    notify("テンプレートを保存しました。");
  } catch (error) {
    handleOperationError("テンプレート保存に失敗", error);
  }
});

csvIngestionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isStaticPreview) {
    notify("静的プレビューではCSV取り込みできません。", true);
    return;
  }

  const formData = new FormData(csvIngestionForm);
  const file = formData.get("csvFile");

  if (!(file instanceof File) || !file.size) {
    notify("CSVファイルを選択してください。", true);
    return;
  }

  try {
    const csvText = await file.text();
    const storeIdRaw = String(formData.get("storeId") || "").trim();
    const payload = {
      fileName: file.name,
      csvText,
      periodYm: String(formData.get("periodYm") || "").trim(),
      uploadedBy: String(formData.get("uploadedBy") || "").trim() || "admin"
    };
    if (storeIdRaw) {
      payload.storeId = Number(storeIdRaw);
    }

    const result = await api.post("/api/ingestion/csv", payload);
    csvIngestionResult.textContent = JSON.stringify(result, null, 2);
    await Promise.all([loadIngestionFiles(), loadCurrentPrices()]);
    notify("CSV取り込みを実行しました。");
  } catch (error) {
    handleOperationError("CSV取り込み失敗", error);
  }
});

ingestionFilesTable.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-ingestion-id]");
  if (!row) {
    return;
  }

  const ingestionId = row.dataset.ingestionId;
  loadIngestionErrors(ingestionId)
    .then(() => notify(`取り込みID ${ingestionId} のエラー詳細を読み込みました。`))
    .catch((error) => handleOperationError("エラー詳細取得に失敗", error));
});

csvMappingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isStaticPreview) {
    notify("静的プレビューではCSVマッピング保存できません。", true);
    return;
  }

  const formData = new FormData(csvMappingForm);
  const storeId = Number(formData.get("storeId"));
  const delimiter = normalizeDelimiterValue(formData.get("delimiter"));
  const headerMappingJson = String(formData.get("headerMappingJson") || "").trim();

  let headerMapping;
  try {
    headerMapping = JSON.parse(headerMappingJson);
  } catch {
    notify("ヘッダーマッピングJSONの形式が不正です。", true);
    return;
  }

  try {
    const result = await api.post("/api/ingestion/mappings", {
      storeId,
      delimiter,
      headerMapping,
      updatedBy: "admin"
    });
    csvMappingResult.textContent = JSON.stringify(result, null, 2);
    notify("店舗別CSVマッピングを保存しました。");
  } catch (error) {
    handleOperationError("CSVマッピング保存に失敗", error);
  }
});

loadCsvMappingBtn.addEventListener("click", async () => {
  const storeIdRaw = String(csvMappingForm.elements.storeId.value || "").trim();
  if (!storeIdRaw) {
    notify("店舗IDを入力してください。", true);
    return;
  }

  try {
    await loadCsvMapping(storeIdRaw);
    notify("CSVマッピングを読み込みました。");
  } catch (error) {
    handleOperationError("CSVマッピング読込に失敗", error);
  }
});

simulateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(simulateForm);
  const query = String(formData.get("query") || "").trim();

  try {
    const result = isStaticPreview
      ? buildPreviewSimulate(query)
      : await api.post("/api/line/simulate", { query });
    simulateResult.textContent = JSON.stringify(result, null, 2);
    notify("シミュレーションを実行しました。");
  } catch (error) {
    handleOperationError("シミュレーション失敗", error);
  }
});

ocrResolveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(ocrResolveForm);
  const text = String(formData.get("text") || "").trim();

  try {
    const result = isStaticPreview
      ? buildPreviewOcrResolve(text)
      : await api.post("/api/ocr/resolve", { text });
    ocrResolveResult.textContent = JSON.stringify(result, null, 2);
    notify("OCR照合テストを実行しました。");
  } catch (error) {
    handleOperationError("OCR照合テスト失敗", error);
  }
});

refreshProductsButton.addEventListener("click", () => {
  loadProducts().catch((error) => handleOperationError("商品再読込に失敗", error));
});

productSearchEl.addEventListener("input", () => {
  loadProducts().catch((error) => handleOperationError("商品検索に失敗", error));
});

const boot = async () => {
  syncAuthInput();
  updateAuthStatus("接続確認中...");

  try {
    await loadSystem();
    await loadProtectedData();
    notify("初期化しました。");
  } catch (error) {
    if (isAuthError(error)) {
      clearProtectedViews();
      handleAuthError();
      return;
    }
    activateStaticPreviewMode(String(error?.message || "API unavailable"));
  }
};

boot();
