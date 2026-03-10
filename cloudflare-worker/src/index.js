const DEFAULT_MAINTENANCE_HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ただいま休止中です</title>
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
  </style>
</head>
<body>
  <main class="card">
    <h1>サービス休止中</h1>
    <p>現在は稼働時間外です。時間をおいて再度アクセスしてください。</p>
  </main>
</body>
</html>`;

const trimSlash = (value) => String(value || "").replace(/\/+$/, "");

const withTimeout = async (promise, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promise(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

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

export default {
  async fetch(request, env) {
    const appUrl = trimSlash(env.APP_URL || "https://line-wine-api.onrender.com");
    const healthUrl = String(env.HEALTH_URL || `${appUrl}/api/health`).trim();
    const timeoutMs = Math.max(500, Number(env.HEALTH_TIMEOUT_MS || 2500) || 2500);

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
