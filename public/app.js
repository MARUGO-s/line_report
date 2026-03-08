const flashEl = document.getElementById("flash");
const systemStatusEl = document.getElementById("systemStatus");

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

const api = {
  async get(path) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.json();
  },
  async post(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.json();
  }
};

const notify = (message, isError = false) => {
  flashEl.textContent = message;
  flashEl.className = isError ? "flash error" : "flash";
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

const loadSystem = async () => {
  const result = await api.get("/api/health");
  systemStatusEl.textContent = `${result.host}:${result.port} / Webhook: ${result.lineWebhookReady ? "OK" : "NG"} / Reply: ${result.lineReplyReady ? "OK" : "NG"} / OCR: ${result.ocrEndpointReady ? "OK" : "NG"}`;
};

const loadStores = async () => {
  const result = await api.get("/api/stores");
  renderStores(result.items || []);
};

const loadProducts = async () => {
  const q = productSearchEl.value.trim();
  const result = await api.get(`/api/products?query=${encodeURIComponent(q)}`);
  renderProducts(result.items || []);
};

const loadCurrentPrices = async () => {
  const result = await api.get("/api/prices/current?limit=100");
  renderCurrentPrices(result.items || []);
};

const loadTemplates = async () => {
  const result = await api.get("/api/reply-templates");
  renderTemplates(result.items || []);
};

const loadIngestionFiles = async () => {
  const result = await api.get("/api/ingestion/files?limit=100");
  renderIngestionFiles(result.items || []);
};

const loadIngestionErrors = async (ingestionFileId) => {
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
  const result = await api.get(`/api/ingestion/mappings/${encodeURIComponent(storeId)}`);
  csvMappingResult.textContent = JSON.stringify(result, null, 2);
  csvMappingForm.elements.headerMappingJson.value = JSON.stringify(result.header_mapping || {}, null, 2);
  csvMappingForm.elements.delimiter.value = result.delimiter || "";
  return result;
};

storeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
    notify(`店舗保存に失敗: ${error.message}`, true);
  }
});

productForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
    notify(`商品保存に失敗: ${error.message}`, true);
  }
});

priceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
    notify(`価格保存に失敗: ${error.message}`, true);
  }
});

templateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
    notify(`テンプレート保存に失敗: ${error.message}`, true);
  }
});

csvIngestionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
    notify(`CSV取り込み失敗: ${error.message}`, true);
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
    .catch((error) => notify(`エラー詳細取得に失敗: ${error.message}`, true));
});

csvMappingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(csvMappingForm);
  const storeId = Number(formData.get("storeId"));
  const delimiter = normalizeDelimiterValue(formData.get("delimiter"));
  const headerMappingJson = String(formData.get("headerMappingJson") || "").trim();

  let headerMapping;
  try {
    headerMapping = JSON.parse(headerMappingJson);
  } catch (error) {
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
    notify(`CSVマッピング保存に失敗: ${error.message}`, true);
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
    notify(`CSVマッピング読込に失敗: ${error.message}`, true);
  }
});

simulateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(simulateForm);

  try {
    const result = await api.post("/api/line/simulate", {
      query: String(formData.get("query") || "").trim()
    });
    simulateResult.textContent = JSON.stringify(result, null, 2);
    notify("シミュレーションを実行しました。");
  } catch (error) {
    notify(`シミュレーション失敗: ${error.message}`, true);
  }
});

ocrResolveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(ocrResolveForm);

  try {
    const result = await api.post("/api/ocr/resolve", {
      text: String(formData.get("text") || "").trim()
    });
    ocrResolveResult.textContent = JSON.stringify(result, null, 2);
    notify("OCR照合テストを実行しました。");
  } catch (error) {
    notify(`OCR照合テスト失敗: ${error.message}`, true);
  }
});

refreshProductsButton.addEventListener("click", () => {
  loadProducts().catch((error) => notify(`商品再読込に失敗: ${error.message}`, true));
});

productSearchEl.addEventListener("input", () => {
  loadProducts().catch((error) => notify(`商品検索に失敗: ${error.message}`, true));
});

const boot = async () => {
  try {
    await Promise.all([
      loadSystem(),
      loadStores(),
      loadProducts(),
      loadCurrentPrices(),
      loadTemplates(),
      loadIngestionFiles()
    ]);
    notify("初期化しました。");
  } catch (error) {
    notify(`初期化に失敗: ${error.message}`, true);
  }
};

boot();
