const DEFAULT_MAINTENANCE_HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>サービス休止中</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: grid;
      place-items: center;
    }
    .card {
      width: min(680px, 92vw);
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 16px;
      padding: 24px;
      box-sizing: border-box;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 24px;
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: #cbd5e1;
    }
    .note {
      margin-top: 12px;
      font-size: 13px;
      color: #94a3b8;
    }
    .controls {
      margin-top: 18px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #334155;
      background: #0b1220;
      color: #e2e8f0;
      border-radius: 10px;
      padding: 11px 12px;
      font-size: 14px;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 11px 16px;
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
      background: #2563eb;
      cursor: pointer;
      white-space: nowrap;
    }
    button[disabled] {
      opacity: 0.65;
      cursor: not-allowed;
    }
    .status {
      margin-top: 12px;
      min-height: 22px;
      color: #bfdbfe;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>サービス休止中</h1>
    <p>現在は稼働時間外です。必要な場合は管理キーを入力して起動してください。</p>
    <div class="controls">
      <input id="resume-key" type="password" placeholder="管理キーを入力" autocomplete="off" />
      <button id="resume-btn" type="button">稼働させる</button>
    </div>
    <div id="status" class="status"></div>
    <p class="note">起動には通常20〜60秒かかります。起動後は自動で画面が切り替わります。</p>
  </main>
  <script>
    const statusEl = document.getElementById("status");
    const keyInput = document.getElementById("resume-key");
    const resumeBtn = document.getElementById("resume-btn");
    let pollingId = null;

    const setStatus = (message) => {
      statusEl.textContent = message;
    };

    const pollHealth = async () => {
      try {
        const response = await fetch("/__health", {
          method: "GET",
          cache: "no-store"
        });
        if (!response.ok) {
          return false;
        }
        const payload = await response.json();
        if (payload && payload.healthy) {
          window.location.replace(window.location.pathname + window.location.search);
          return true;
        }
      } catch (_) {}
      return false;
    };

    const startPolling = async () => {
      if (pollingId) {
        clearInterval(pollingId);
      }
      await pollHealth();
      pollingId = setInterval(pollHealth, 2500);
    };

    resumeBtn.addEventListener("click", async () => {
      const key = keyInput.value.trim();
      if (!key) {
        setStatus("管理キーを入力してください。");
        return;
      }
      resumeBtn.disabled = true;
      setStatus("起動リクエストを送信しています...");
      try {
        const response = await fetch("/__resume", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ key })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setStatus(payload.error || "起動リクエストに失敗しました。");
          resumeBtn.disabled = false;
          return;
        }
        setStatus(payload.message || "起動リクエストを受け付けました。起動を待っています...");
        await startPolling();
      } catch (_) {
        setStatus("通信に失敗しました。時間をおいて再試行してください。");
        resumeBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

const trimSlash = (value) => String(value || "").replace(/\/+$/, "");
const jsonHeaders = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store"
};

const withTimeout = async (promise, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promise(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

const asJson = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders
  });

const isHealthy = async (healthUrl, timeoutMs) => {
  try {
    const response = await withTimeout(
      (signal) =>
        fetch(healthUrl, {
          method: "GET",
          signal,
          headers: {
            "cache-control": "no-cache"
          }
        }),
      timeoutMs
    );
    return response.ok;
  } catch {
    return false;
  }
};

const buildRedirectUrl = (requestUrl, appBaseUrl) => {
  const incoming = new URL(requestUrl);
  const target = new URL(trimSlash(appBaseUrl) || incoming.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target.toString();
};

const callRenderResume = async ({ apiKey, serviceId, timeoutMs }) => {
  const endpoint = `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/resume`;
  return withTimeout(
    (signal) =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        signal
      }),
    timeoutMs
  );
};

const parseRequestJson = async (request) => {
  try {
    return await request.json();
  } catch {
    return {};
  }
};

const toSha256Hex = async (value) => {
  const data = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const handleResumeRequest = async ({ request, env, healthUrl, timeoutMs }) => {
  const expectedKeyHash = String(env.RESUME_KEY_SHA256 || "").trim().toLowerCase();
  if (!expectedKeyHash) {
    return asJson(500, { ok: false, error: "RESUME_KEY_SHA256 が未設定です。" });
  }

  const payload = await parseRequestJson(request);
  const inputKey = String(payload?.key || "").trim();
  if (!inputKey) {
    return asJson(400, { ok: false, error: "管理キーを入力してください。" });
  }

  const inputHash = await toSha256Hex(inputKey);
  if (inputHash !== expectedKeyHash) {
    return asJson(401, { ok: false, error: "管理キーが正しくありません。" });
  }

  const renderApiKey = String(env.RENDER_API_KEY || "").trim();
  const renderServiceId = String(env.RENDER_SERVICE_ID || "").trim();
  if (!renderApiKey || !renderServiceId) {
    return asJson(500, {
      ok: false,
      error: "RENDER_API_KEY または RENDER_SERVICE_ID が未設定です。"
    });
  }

  const alreadyHealthy = await isHealthy(healthUrl, timeoutMs);
  if (alreadyHealthy) {
    return asJson(200, { ok: true, message: "すでに稼働中です。画面を切り替えます..." });
  }

  try {
    const response = await callRenderResume({
      apiKey: renderApiKey,
      serviceId: renderServiceId,
      timeoutMs: Math.max(2000, timeoutMs + 2000)
    });
    if (!response.ok && response.status !== 409) {
      const bodyText = await response.text().catch(() => "");
      return asJson(502, {
        ok: false,
        error: `Render再開APIで失敗しました (${response.status})`,
        detail: bodyText.slice(0, 300)
      });
    }
    return asJson(200, {
      ok: true,
      message: "起動リクエストを送信しました。起動完了を確認しています..."
    });
  } catch (error) {
    return asJson(502, {
      ok: false,
      error: `Render再開APIに接続できませんでした: ${error?.message || "unknown"}`
    });
  }
};

export default {
  async fetch(request, env) {
    const appUrl = trimSlash(env.APP_URL || "https://line-wine-api.onrender.com");
    const healthUrl = String(env.HEALTH_URL || `${appUrl}/api/health`).trim();
    const timeoutMs = Math.max(500, Number(env.HEALTH_TIMEOUT_MS || 2500) || 2500);
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/__health" && request.method === "GET") {
      const healthy = await isHealthy(healthUrl, timeoutMs);
      return asJson(200, { ok: true, healthy });
    }

    if (path === "/__resume" && request.method === "POST") {
      return handleResumeRequest({ request, env, healthUrl, timeoutMs });
    }

    const healthy = await isHealthy(healthUrl, timeoutMs);
    if (healthy) {
      const redirectTo = buildRedirectUrl(request.url, appUrl);
      return Response.redirect(redirectTo, 302);
    }

    const html = String(env.MAINTENANCE_HTML || DEFAULT_MAINTENANCE_HTML);
    return new Response(html, {
      status: 503,
      headers: {
        "content-type": "text/html; charset=UTF-8",
        "cache-control": "no-store"
      }
    });
  }
};
