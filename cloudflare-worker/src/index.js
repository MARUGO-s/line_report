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
      display: flex;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 11px 20px;
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
    <p>現在は稼働時間外です。必要な場合は下のボタンで起動してください。</p>
    <div class="controls">
      <button id="resume-btn" type="button">稼働させる</button>
    </div>
    <div id="status" class="status"></div>
    <p class="note">起動には通常20〜60秒かかります。起動後は自動で画面が切り替わります。</p>
  </main>
  <script>
    const statusEl = document.getElementById("status");
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
      resumeBtn.disabled = true;
      setStatus("起動リクエストを送信しています...");
      try {
        const response = await fetch("/__resume", {
          method: "POST"
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
const lineReplyApiUrl = "https://api.line.me/v2/bot/message/reply";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const timingSafeEqual = (left, right) => {
  const leftText = String(left || "");
  const rightText = String(right || "");
  if (leftText.length !== rightText.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < leftText.length; i += 1) {
    diff |= leftText.charCodeAt(i) ^ rightText.charCodeAt(i);
  }
  return diff === 0;
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

const callRenderSuspend = async ({ apiKey, serviceId, timeoutMs }) => {
  const endpoint = `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/suspend`;
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

const callRenderServiceStatus = async ({ apiKey, serviceId, timeoutMs }) => {
  const endpoint = `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}`;
  return withTimeout(
    (signal) =>
      fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json"
        },
        signal
      }),
    timeoutMs
  );
};

const parseRenderErrorDetail = (detailText) => {
  const text = String(detailText || "").trim();
  if (!text) {
    return { message: "" };
  }
  try {
    const parsed = JSON.parse(text);
    return { message: String(parsed?.message || text) };
  } catch {
    return { message: text };
  }
};

const fetchRenderState = async ({ env, timeoutMs }) => {
  const renderApiKey = String(env.RENDER_API_KEY || "").trim();
  const renderServiceId = String(env.RENDER_SERVICE_ID || "").trim();
  if (!renderApiKey || !renderServiceId) {
    return null;
  }
  try {
    const response = await callRenderServiceStatus({
      apiKey: renderApiKey,
      serviceId: renderServiceId,
      timeoutMs: Math.max(2000, timeoutMs + 2000)
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return null;
    }
    return {
      suspended: String(payload.suspended || ""),
      suspenders: Array.isArray(payload.suspenders) ? payload.suspenders.map((x) => String(x || "")) : []
    };
  } catch {
    return null;
  }
};

const verifyLineSignature = async ({ bodyBuffer, signature, channelSecret }) => {
  const normalizedSignature = String(signature || "").trim();
  if (!normalizedSignature) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(channelSecret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, bodyBuffer);
  const expected = toBase64(signed);
  return timingSafeEqual(expected, normalizedSignature);
};

const sendPausedLineReply = async ({ accessToken, replyToken, message, timeoutMs }) => {
  const response = await withTimeout(
    (signal) =>
      fetch(lineReplyApiUrl, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          replyToken,
          messages: [{ type: "text", text: message }]
        })
      }),
    timeoutMs
  );
  if (response.ok) {
    return { ok: true };
  }
  const bodyText = await response.text().catch(() => "");
  return {
    ok: false,
    status: response.status,
    detail: bodyText.slice(0, 300)
  };
};

const normalizeCommandText = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();

const isResumeCommand = (text) => {
  const normalized = normalizeCommandText(text);
  return [
    "起動",
    "再開",
    "再稼働",
    "サーバー起動",
    "サーバー再開",
    "resume",
    "start"
  ].includes(normalized);
};

const isSuspendCommand = (text) => {
  const normalized = normalizeCommandText(text);
  return [
    "休止",
    "停止",
    "サーバー休止",
    "サーバー停止",
    "suspend",
    "stop"
  ].includes(normalized);
};

const handlePausedLineWebhook = async ({ env, bodyBuffer, timeoutMs, signature, healthUrl }) => {
  const lineAccessToken = String(env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
  if (!lineAccessToken) {
    return asJson(500, { ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN が未設定です。" });
  }

  const lineChannelSecret = String(env.LINE_CHANNEL_SECRET || "").trim();
  if (lineChannelSecret) {
    const valid = await verifyLineSignature({
      bodyBuffer,
      signature,
      channelSecret: lineChannelSecret
    });
    if (!valid) {
      return asJson(401, { ok: false, error: "invalid line signature" });
    }
  }

  let payload;
  try {
    payload = JSON.parse(textDecoder.decode(bodyBuffer));
  } catch {
    return asJson(400, { ok: false, error: "invalid webhook payload" });
  }

  const pausedMessage = String(env.PAUSED_LINE_REPLY_TEXT || "").trim()
    || "ただいまの時間はサーバーが休止中です。";
  const pausedWithGuide = `${pausedMessage}\n再開する場合は「起動」と送信してください。`;
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const replyTargets = events
    .map((event) => ({
      replyToken: String(event?.replyToken || "").trim(),
      type: String(event?.type || ""),
      messageType: String(event?.message?.type || ""),
      messageText: String(event?.message?.text || "").trim()
    }))
    .filter((event) => event.replyToken && event.replyToken !== "00000000000000000000000000000000");

  if (!replyTargets.length) {
    return asJson(200, { ok: true, paused: true, replied: 0 });
  }

  let resumeResultPromise = null;
  const getResumeResult = async () => {
    if (!resumeResultPromise) {
      resumeResultPromise = (async () => {
        const response = await handleResumeRequest({ env, healthUrl, timeoutMs });
        const payload = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, payload };
      })();
    }
    return resumeResultPromise;
  };

  const results = await Promise.all(
    replyTargets.map(async (event) => {
      let replyText = pausedWithGuide;
      if (event.type === "message" && event.messageType === "text" && isResumeCommand(event.messageText)) {
        const resumeResult = await getResumeResult();
        if (resumeResult.ok) {
          replyText = String(resumeResult.payload?.message || "").trim()
            || "起動リクエストを受け付けました。20〜60秒ほどで利用可能になります。";
        } else {
          const detail = parseRenderErrorDetail(resumeResult.payload?.detail).message;
          if (/only services suspended by a user can be resumed/i.test(detail)) {
            const state = await fetchRenderState({ env, timeoutMs });
            if (state?.suspended === "not_suspended") {
              replyText = "再開処理中の可能性があります。30〜90秒待ってからもう一度メッセージを送ってください。";
            } else {
              replyText = "現在の停止状態ではLINEから再開できません。管理画面から再開してください。";
            }
          } else {
            replyText = "再開に失敗しました。時間をおいて再試行してください。";
          }
        }
      } else if (event.type === "message" && event.messageType === "text" && isSuspendCommand(event.messageText)) {
        replyText = "現在は休止中です。再開する場合は「起動」と送信してください。";
      }
      return sendPausedLineReply({
        accessToken: lineAccessToken,
        replyToken: event.replyToken,
        message: replyText,
        timeoutMs: Math.max(2000, timeoutMs + 3000)
      });
    })
  );

  const failed = results.find((result) => !result.ok);
  if (failed) {
    return asJson(502, {
      ok: false,
      error: `LINE reply failed (${failed.status})`,
      detail: failed.detail || ""
    });
  }

  return asJson(200, { ok: true, paused: true, replied: replyTargets.length });
};

const forwardRequestToApp = async ({ request, appUrl, bodyBuffer }) => {
  const targetUrl = buildRedirectUrl(request.url, appUrl);
  return fetch(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: bodyBuffer
  });
};

const handleResumeRequest = async ({ env, healthUrl, timeoutMs }) => {
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

const handleSuspendRequest = async ({ env, timeoutMs }) => {
  const renderApiKey = String(env.RENDER_API_KEY || "").trim();
  const renderServiceId = String(env.RENDER_SERVICE_ID || "").trim();
  if (!renderApiKey || !renderServiceId) {
    return asJson(500, {
      ok: false,
      error: "RENDER_API_KEY または RENDER_SERVICE_ID が未設定です。"
    });
  }

  try {
    const response = await callRenderSuspend({
      apiKey: renderApiKey,
      serviceId: renderServiceId,
      timeoutMs: Math.max(2000, timeoutMs + 2000)
    });
    if (!response.ok && response.status !== 409) {
      const bodyText = await response.text().catch(() => "");
      return asJson(502, {
        ok: false,
        error: `Render休止APIで失敗しました (${response.status})`,
        detail: bodyText.slice(0, 300)
      });
    }
    return asJson(200, {
      ok: true,
      message: "休止リクエストを受け付けました。数十秒で休止状態になります。"
    });
  } catch (error) {
    return asJson(502, {
      ok: false,
      error: `Render休止APIに接続できませんでした: ${error?.message || "unknown"}`
    });
  }
};

const handleLiveLineWebhook = async ({ env, bodyBuffer, timeoutMs, signature, healthUrl, request, appUrl }) => {
  const lineChannelSecret = String(env.LINE_CHANNEL_SECRET || "").trim();
  if (lineChannelSecret) {
    const valid = await verifyLineSignature({
      bodyBuffer,
      signature,
      channelSecret: lineChannelSecret
    });
    if (!valid) {
      return asJson(401, { ok: false, error: "invalid line signature" });
    }
  }

  let payload;
  try {
    payload = JSON.parse(textDecoder.decode(bodyBuffer));
  } catch {
    return asJson(400, { ok: false, error: "invalid webhook payload" });
  }

  const events = Array.isArray(payload?.events) ? payload.events : [];
  const parsedEvents = events.map((event) => ({
    replyToken: String(event?.replyToken || "").trim(),
    type: String(event?.type || ""),
    messageType: String(event?.message?.type || ""),
    messageText: String(event?.message?.text || "").trim()
  }));

  const commandEvents = parsedEvents.filter(
    (event) =>
      event.replyToken &&
      event.replyToken !== "00000000000000000000000000000000" &&
      event.type === "message" &&
      event.messageType === "text" &&
      (isSuspendCommand(event.messageText) || isResumeCommand(event.messageText))
  );

  const allEventsAreCommand =
    events.length > 0 &&
    commandEvents.length === events.length;

  if (!allEventsAreCommand) {
    return forwardRequestToApp({ request, appUrl, bodyBuffer });
  }

  const lineAccessToken = String(env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
  if (!lineAccessToken) {
    return asJson(500, { ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN が未設定です。" });
  }

  let suspendResultPromise = null;
  let resumeResultPromise = null;
  const getSuspendResult = async () => {
    if (!suspendResultPromise) {
      suspendResultPromise = (async () => {
        const response = await handleSuspendRequest({ env, timeoutMs });
        const payload = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, payload };
      })();
    }
    return suspendResultPromise;
  };
  const getResumeResult = async () => {
    if (!resumeResultPromise) {
      resumeResultPromise = (async () => {
        const response = await handleResumeRequest({ env, healthUrl, timeoutMs });
        const payload = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, payload };
      })();
    }
    return resumeResultPromise;
  };

  const results = await Promise.all(
    commandEvents.map(async (event) => {
      let replyText = "コマンドを受け付けました。";
      if (isSuspendCommand(event.messageText)) {
        const suspendResult = await getSuspendResult();
        if (suspendResult.ok) {
          replyText = String(suspendResult.payload?.message || "").trim()
            || "休止リクエストを受け付けました。数十秒で休止状態になります。";
        } else {
          replyText = "休止に失敗しました。時間をおいて再試行してください。";
        }
      } else if (isResumeCommand(event.messageText)) {
        const resumeResult = await getResumeResult();
        if (resumeResult.ok) {
          replyText = String(resumeResult.payload?.message || "").trim()
            || "起動リクエストを受け付けました。";
        } else {
          replyText = "再開に失敗しました。時間をおいて再試行してください。";
        }
      }
      return sendPausedLineReply({
        accessToken: lineAccessToken,
        replyToken: event.replyToken,
        message: replyText,
        timeoutMs: Math.max(2000, timeoutMs + 3000)
      });
    })
  );

  const failed = results.find((result) => !result.ok);
  if (failed) {
    return asJson(502, {
      ok: false,
      error: `LINE reply failed (${failed.status})`,
      detail: failed.detail || ""
    });
  }

  return asJson(200, { ok: true, live: true, handledCommands: commandEvents.length });
};

export default {
  async fetch(request, env) {
    const appUrl = trimSlash(env.APP_URL || "https://line-wine-api.onrender.com");
    const healthUrl = String(env.HEALTH_URL || `${appUrl}/api/health`).trim();
    const timeoutMs = Math.max(500, Number(env.HEALTH_TIMEOUT_MS || 2500) || 2500);
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/webhooks/line" && request.method === "POST") {
      const bodyBuffer = await request.arrayBuffer();
      const healthy = await isHealthy(healthUrl, timeoutMs);
      if (healthy) {
        return handleLiveLineWebhook({
          env,
          bodyBuffer,
          timeoutMs,
          signature: request.headers.get("x-line-signature"),
          healthUrl,
          request,
          appUrl
        });
      }
      return handlePausedLineWebhook({
        env,
        bodyBuffer,
        timeoutMs,
        signature: request.headers.get("x-line-signature"),
        healthUrl
      });
    }

    if (path === "/__health" && request.method === "GET") {
      const healthy = await isHealthy(healthUrl, timeoutMs);
      return asJson(200, { ok: true, healthy });
    }

    if (path === "/__resume" && request.method === "POST") {
      return handleResumeRequest({ env, healthUrl, timeoutMs });
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
