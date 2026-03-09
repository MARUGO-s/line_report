const flashEl = document.getElementById("flash");
const systemStatusEl = document.getElementById("systemStatus");

const authForm = document.getElementById("authForm");
const clearTokenBtn = document.getElementById("clearTokenBtn");
const authStatusEl = document.getElementById("authStatus");
const adminTokenRotateForm = document.getElementById("adminTokenRotateForm");
const adminTokenRotateResult = document.getElementById("adminTokenRotateResult");

const downloadTemplateBtn = document.getElementById("downloadTemplateBtn");
const csvIngestionForm = document.getElementById("csvIngestionForm");
const csvIngestionResult = document.getElementById("csvIngestionResult");

const ingestionFilesTable = document.getElementById("ingestionFilesTable");
const ingestionErrorsResult = document.getElementById("ingestionErrorsResult");

const templateForm = document.getElementById("templateForm");
const templateEditTarget = document.getElementById("templateEditTarget");
const resetTemplateFormBtn = document.getElementById("resetTemplateFormBtn");
const templatesTable = document.getElementById("templatesTable");
const templatePreview = document.getElementById("templatePreview");
const templateKeyShortcuts = document.getElementById("templateKeyShortcuts");
const templateVariableShortcuts = document.getElementById("templateVariableShortcuts");

const templateCsvText = [
  "年代,ワイン名,wine_name,販売価格,納品価格,在庫数,在庫店舗,納品業者,原価率",
  "2021,マコン・クラシコ,Macan Clasico,6980,4200,24,新宿倉庫,ABCトレーディング,60.2",
  "2019,シャトー・マルゴー,Chateau Margaux,198000,132000,2,銀座店,XYZインポーター,66.7"
].join("\n");

const STORAGE_ADMIN_TOKEN_KEY = "line_wine_admin_token";

const TEMPLATE_KEY_SUGGESTIONS = [
  "price_found",
  "price_not_found",
  "image_received",
  "image_ocr_failed",
  "image_ocr_not_found",
  "image_ocr_web_candidates",
  "image_ocr_web_summary"
];

const TEMPLATE_VARIABLE_SUGGESTIONS = [
  "{{query}}",
  "{{product_name}}",
  "{{lines}}",
  "{{region}}",
  "{{producer}}",
  "{{market_price}}",
  "{{varieties}}",
  "{{taste}}",
  "{{features}}",
  "{{rating_points}}",
  "{{awards}}",
  "{{drinking_window}}",
  "{{winery_history}}",
  "{{sources}}",
  "{{search_mode}}",
  "{{source_urls}}",
  "{{web_lines}}"
];

const TEMPLATE_PREVIEW_VALUES = {
  query: "ドンペリニョン",
  product_name: "ドンペリニョン・ヴィンテージ 2012",
  lines: "年代: 2012\n納品価格: 15,000円\n販売価格: 22,000円\n納品業者: Sample Supplier",
  region: "シャンパーニュ",
  producer: "Dom Perignon",
  market_price: "参考レンジ: JPY 21,000 - 24,000",
  varieties: "シャルドネ, ピノ・ノワール",
  taste: "果実味とミネラルが調和したエレガントな味わい",
  features: "繊細な泡立ち、長い余韻",
  rating_points: "2012: 96/100",
  awards: "2019 Decanter Gold",
  drinking_window: "2024-2035",
  winery_history: "歴史あるシャンパーニュメゾン。",
  sources: "Wine-Searcher, Vivino",
  search_mode: "DB優先検索",
  source_urls: "https://example.com/wine-1",
  web_lines: "1. 候補A\n2. 候補B"
};

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
    // ignore
  }
};

const state = {
  adminToken: readStoredAdminToken(),
  adminAuthRequired: false,
  isStaticPreview: false,
  templates: [],
  templateEditOriginalKey: ""
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

const isAuthError = (error) => error instanceof ApiError && error.status === 401;

const updateAuthStatus = (message = "") => {
  if (state.isStaticPreview) {
    authStatusEl.textContent = "静的プレビューモードです。保存APIは無効です。";
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
    : "管理認証が必須です。ADMIN_TOKENを入力して保存してください。";
};

const syncAuthInput = () => {
  authForm.elements.adminToken.value = state.adminToken;
};

const buildPreviewText = (templateBody) =>
  String(templateBody || "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    return TEMPLATE_PREVIEW_VALUES[key] ?? `{{${key}}}`;
  });

const updateTemplatePreview = () => {
  const body = String(templateForm.elements.body.value || "").trim();
  if (!body) {
    templatePreview.textContent = "テンプレート本文を入力するとプレビューされます。";
    return;
  }
  templatePreview.textContent = buildPreviewText(body);
};

const setTemplateEditMode = (originalKey = "") => {
  state.templateEditOriginalKey = String(originalKey || "").trim();
  if (state.templateEditOriginalKey) {
    templateEditTarget.textContent = `編集中: ${state.templateEditOriginalKey}（キー名を変更して保存できます）`;
    return;
  }
  templateEditTarget.textContent = "新規作成モード";
};

const resetTemplateForm = () => {
  templateForm.reset();
  setTemplateEditMode("");
  updateTemplatePreview();
};

const refreshAdminTokenRotateFormState = () => {
  const useEnv = adminTokenRotateForm.elements.useEnvToken.checked;
  adminTokenRotateForm.elements.newAdminToken.disabled = useEnv;
  adminTokenRotateForm.elements.confirmAdminToken.disabled = useEnv;
};

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderTemplateKeyShortcuts = () => {
  templateKeyShortcuts.innerHTML = "";
  for (const key of TEMPLATE_KEY_SUGGESTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.dataset.key = key;
    btn.textContent = key;
    templateKeyShortcuts.appendChild(btn);
  }
};

const renderTemplateVariableShortcuts = () => {
  templateVariableShortcuts.innerHTML = "";
  for (const variable of TEMPLATE_VARIABLE_SUGGESTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip chip-soft";
    btn.dataset.variable = variable;
    btn.textContent = variable;
    templateVariableShortcuts.appendChild(btn);
  }
};

const insertTextAtCursor = (textarea, value) => {
  if (!(textarea instanceof HTMLTextAreaElement)) {
    return;
  }
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = `${before}${value}${after}`;
  const pos = start + value.length;
  textarea.focus();
  textarea.selectionStart = pos;
  textarea.selectionEnd = pos;
};

const renderTemplates = (items) => {
  state.templates = Array.isArray(items) ? items : [];
  templatesTable.innerHTML = "";

  if (!state.templates.length) {
    templatesTable.innerHTML = '<tr><td colspan="4">テンプレートがありません</td></tr>';
    return;
  }

  state.templates.forEach((item, index) => {
    const tr = document.createElement("tr");
    tr.dataset.index = String(index);
    tr.innerHTML = `
      <td><code>${escapeHtml(item.template_key)}</code></td>
      <td>${item.is_active ? "有効" : "無効"}</td>
      <td>${safeDate(item.updated_at)}</td>
      <td><button type="button" class="chip" data-template-edit="${index}">編集</button></td>
    `;
    templatesTable.appendChild(tr);
  });
};

const renderIngestionFiles = (items) => {
  ingestionFilesTable.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    ingestionFilesTable.innerHTML = '<tr><td colspan="5">履歴がありません</td></tr>';
    return;
  }

  for (const item of items) {
    const tr = document.createElement("tr");
    tr.dataset.ingestionId = String(item.id);
    tr.style.cursor = "pointer";
    tr.innerHTML = `
      <td>${item.id}</td>
      <td>${escapeHtml(item.file_name)}</td>
      <td>${escapeHtml(item.status)}</td>
      <td>${item.accepted_rows}/${item.total_rows} (err:${item.rejected_rows})</td>
      <td>${safeDate(item.uploaded_at)}</td>
    `;
    ingestionFilesTable.appendChild(tr);
  }
};

const extractFileNameFromDisposition = (dispositionHeader, fallback = "download.csv") => {
  const raw = String(dispositionHeader || "");
  const utf8Match = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1].trim());
  }
  const plainMatch = raw.match(/filename="?([^";]+)"?/i);
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

const activateStaticPreviewMode = (reason = "") => {
  state.isStaticPreview = true;
  systemStatusEl.textContent = "GitHub Pages 静的プレビューモード（保存APIは無効）";
  updateAuthStatus();
  setTemplateEditMode("");
  renderTemplates([
    { template_key: "price_found", is_active: 1, updated_at: new Date().toISOString(), body: "{{product_name}} の検索結果です。\\n{{lines}}" },
    { template_key: "price_not_found", is_active: 1, updated_at: new Date().toISOString(), body: "{{query}} に一致する価格が見つかりませんでした。" }
  ]);
  renderIngestionFiles([]);
  csvIngestionResult.textContent = "静的プレビューではCSV取り込みAPIは利用できません。";
  ingestionErrorsResult.textContent = "静的プレビューではエラー詳細取得は利用できません。";

  const suffix = reason ? ` (${reason})` : "";
  notify(`静的プレビューモードで表示中です${suffix}`);
};

const loadSystem = async () => {
  if (state.isStaticPreview) {
    return;
  }

  const result = await api.get("/api/health");
  state.adminAuthRequired = Boolean(result.adminAuthRequired);
  updateAuthStatus();
  systemStatusEl.textContent = `${result.host}:${result.port} / Auth: ${result.adminAuthRequired ? (state.adminToken ? "ON" : "REQUIRED") : "OFF"} / Source: ${result.adminTokenSource || "-"} / Webhook: ${result.lineWebhookReady ? "OK" : "NG"} / Reply: ${result.lineReplyReady ? "OK" : "NG"}`;
};

const loadTemplates = async () => {
  if (state.isStaticPreview) {
    return;
  }
  const result = await api.get("/api/reply-templates");
  renderTemplates(result.items || []);
};

const loadIngestionFiles = async () => {
  if (state.isStaticPreview) {
    return;
  }
  const result = await api.get("/api/ingestion/files?limit=100");
  renderIngestionFiles(result.items || []);
};

const loadIngestionErrors = async (ingestionFileId) => {
  if (state.isStaticPreview) {
    return;
  }
  const result = await api.get(`/api/ingestion/files/${encodeURIComponent(ingestionFileId)}/errors`);
  ingestionErrorsResult.textContent = JSON.stringify(result, null, 2);
};

const loadProtectedData = async () => {
  await Promise.all([loadTemplates(), loadIngestionFiles()]);
};

const handleOperationError = (prefix, error) => {
  if (isAuthError(error)) {
    updateAuthStatus("認証エラー: ADMIN_TOKENを確認してください。");
    notify("認証エラー: 管理トークンが無効です。", true);
    return;
  }
  notify(`${prefix}: ${error.message}`, true);
};

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.isStaticPreview) {
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

clearTokenBtn.addEventListener("click", () => {
  if (state.isStaticPreview) {
    notify("静的プレビューでは認証設定は利用できません。", true);
    return;
  }
  state.adminToken = "";
  writeStoredAdminToken("");
  syncAuthInput();
  updateAuthStatus();
  notify("管理トークンをクリアしました。");
});

adminTokenRotateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.isStaticPreview) {
    notify("静的プレビューではトークン更新できません。", true);
    return;
  }

  const formData = new FormData(adminTokenRotateForm);
  const useEnvToken = formData.get("useEnvToken") === "on";
  const newAdminToken = String(formData.get("newAdminToken") || "").trim();
  const confirmAdminToken = String(formData.get("confirmAdminToken") || "").trim();

  if (!useEnvToken) {
    if (newAdminToken.length < 8) {
      notify("新しいトークンは8文字以上にしてください。", true);
      return;
    }
    if (newAdminToken !== confirmAdminToken) {
      notify("確認用トークンが一致しません。", true);
      return;
    }
  }

  try {
    const result = await api.post("/api/admin/auth-token", {
      useEnvToken,
      newAdminToken: useEnvToken ? "" : newAdminToken
    });
    adminTokenRotateResult.textContent = JSON.stringify(result, null, 2);
    if (!useEnvToken) {
      state.adminToken = newAdminToken;
      writeStoredAdminToken(newAdminToken);
      syncAuthInput();
    }
    adminTokenRotateForm.reset();
    await loadSystem();
    await loadProtectedData();
    notify(useEnvToken ? "管理認証トークンを環境変数設定へ戻しました。" : "管理認証トークンを更新しました。");
  } catch (error) {
    handleOperationError("管理認証トークン更新に失敗", error);
  }
});

adminTokenRotateForm.elements.useEnvToken.addEventListener("change", () => {
  refreshAdminTokenRotateFormState();
});

downloadTemplateBtn.addEventListener("click", async () => {
  if (state.isStaticPreview) {
    saveBlobToFile(new Blob([templateCsvText], { type: "text/csv;charset=utf-8" }), "wine_master_template.csv");
    notify("テンプレートCSVをダウンロードしました。");
    return;
  }

  try {
    let response;
    try {
      response = await api.getBlob("/template/wine_price_template.csv");
    } catch {
      response = await api.getBlob("/api/ingestion/template");
    }
    const fileName = extractFileNameFromDisposition(response.disposition, "wine_master_template.csv");
    saveBlobToFile(response.blob, fileName);
    notify("テンプレートCSVをダウンロードしました。");
  } catch (error) {
    handleOperationError("テンプレートCSV取得に失敗", error);
  }
});

csvIngestionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.isStaticPreview) {
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
    const payload = {
      fileName: file.name,
      csvText,
      periodYm: String(formData.get("periodYm") || "").trim(),
      uploadedBy: String(formData.get("uploadedBy") || "").trim() || "admin"
    };

    const storeIdRaw = String(formData.get("storeId") || "").trim();
    if (storeIdRaw) {
      payload.storeId = Number(storeIdRaw);
    }

    const result = await api.post("/api/ingestion/csv", payload);
    csvIngestionResult.textContent = JSON.stringify(result, null, 2);
    await loadIngestionFiles();
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

templateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.isStaticPreview) {
    notify("静的プレビューではテンプレート保存できません。", true);
    return;
  }

  const formData = new FormData(templateForm);
  const payload = {
    templateKey: String(formData.get("templateKey") || "").trim(),
    body: String(formData.get("body") || "").trim()
  };

  if (!payload.templateKey || !payload.body) {
    notify("キーと本文を入力してください。", true);
    return;
  }

  try {
    const beforeKey = state.templateEditOriginalKey;
    const renamed = Boolean(beforeKey && beforeKey !== payload.templateKey);
    if (renamed) {
      await api.post("/api/reply-templates/rename", {
        oldTemplateKey: beforeKey,
        newTemplateKey: payload.templateKey
      });
    }
    await api.post("/api/reply-templates", payload);
    await loadTemplates();
    setTemplateEditMode(payload.templateKey);
    notify(
      renamed
        ? `テンプレートキーを ${beforeKey} から ${payload.templateKey} に変更して保存しました。`
        : "テンプレートを保存しました。"
    );
  } catch (error) {
    handleOperationError("テンプレート保存に失敗", error);
  }
});

templateKeyShortcuts.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-key]");
  if (!button) {
    return;
  }
  templateForm.elements.templateKey.value = button.dataset.key;
  templateForm.elements.body.focus();
  notify(`テンプレートキー ${button.dataset.key} を入力しました。`);
});

templateVariableShortcuts.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-variable]");
  if (!button) {
    return;
  }
  insertTextAtCursor(templateForm.elements.body, button.dataset.variable);
  updateTemplatePreview();
});

templatesTable.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-template-edit]");
  if (!button) {
    return;
  }

  const index = Number(button.dataset.templateEdit);
  if (!Number.isInteger(index) || index < 0 || index >= state.templates.length) {
    return;
  }

  const row = state.templates[index];
  templateForm.elements.templateKey.value = String(row.template_key || "");
  templateForm.elements.body.value = String(row.body || "");
  setTemplateEditMode(row.template_key || "");
  updateTemplatePreview();
  templateForm.elements.body.focus();
  notify(`テンプレート ${row.template_key} を編集欄に読み込みました。`);
});

resetTemplateFormBtn.addEventListener("click", () => {
  resetTemplateForm();
  notify("新規作成モードに戻しました。");
});

templateForm.elements.body.addEventListener("input", () => {
  updateTemplatePreview();
});

const boot = async () => {
  syncAuthInput();
  renderTemplateKeyShortcuts();
  renderTemplateVariableShortcuts();
  refreshAdminTokenRotateFormState();
  setTemplateEditMode("");
  updateTemplatePreview();
  updateAuthStatus("接続確認中...");

  try {
    await loadSystem();
    await loadProtectedData();
    notify("初期化しました。");
  } catch (error) {
    if (isAuthError(error)) {
      updateAuthStatus("認証エラー: ADMIN_TOKENを確認してください。");
      notify("認証エラー: 管理トークンが無効です。", true);
      return;
    }
    activateStaticPreviewMode(String(error?.message || "API unavailable"));
  }
};

boot();
