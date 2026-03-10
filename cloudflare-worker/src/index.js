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
const linePushApiUrl = "https://api.line.me/v2/bot/message/push";
const lineDummyReplyToken = "00000000000000000000000000000000";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const diagCacheRequest = new Request("https://linewine-internal.local/__diag/last-webhook");
const DEFAULT_SUSPEND_CRON_UTC = "0 17 * * *";
const DEFAULT_RESUME_CRON_UTC = "0 3 * * *";
const runtimeDiagnostics = {
  lastWebhook: null
};

const isFalseLike = (value) =>
  ["0", "false", "off", "no", "disabled"].includes(String(value || "").trim().toLowerCase());

const getAutoScheduleConfig = (env) => ({
  enabled: !isFalseLike(env.AUTO_SUSPEND_RESUME_ENABLED),
  suspendCronUtc: String(env.SUSPEND_CRON_UTC || DEFAULT_SUSPEND_CRON_UTC).trim() || DEFAULT_SUSPEND_CRON_UTC,
  resumeCronUtc: String(env.RESUME_CRON_UTC || DEFAULT_RESUME_CRON_UTC).trim() || DEFAULT_RESUME_CRON_UTC
});

const setRuntimeWebhookDiag = (update) => {
  runtimeDiagnostics.lastWebhook = {
    ...(runtimeDiagnostics.lastWebhook && typeof runtimeDiagnostics.lastWebhook === "object"
      ? runtimeDiagnostics.lastWebhook
      : {}),
    updatedAt: new Date().toISOString(),
    ...update
  };
};

const persistRuntimeWebhookDiag = async (payload) => {
  try {
    await caches.default.put(
      diagCacheRequest,
      new Response(JSON.stringify(payload || null), {
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "cache-control": "max-age=1800"
        }
      })
    );
  } catch {}
};

const loadPersistedRuntimeWebhookDiag = async () => {
  try {
    const response = await caches.default.match(diagCacheRequest);
    if (!response) {
      return null;
    }
    return response.json().catch(() => null);
  } catch {
    return null;
  }
};

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

const callLineBotInfo = async ({ accessToken, timeoutMs }) =>
  withTimeout(
    (signal) =>
      fetch("https://api.line.me/v2/bot/info", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        },
        signal
      }),
    timeoutMs
  );

const callLineWebhookEndpointInfo = async ({ accessToken, timeoutMs }) =>
  withTimeout(
    (signal) =>
      fetch("https://api.line.me/v2/bot/channel/webhook/endpoint", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        },
        signal
      }),
    timeoutMs
  );

const callLineMessageQuota = async ({ accessToken, timeoutMs }) =>
  withTimeout(
    (signal) =>
      fetch("https://api.line.me/v2/bot/message/quota", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        },
        signal
      }),
    timeoutMs
  );

const callLineWebhookTest = async ({ accessToken, timeoutMs }) =>
  withTimeout(
    (signal) =>
      fetch("https://api.line.me/v2/bot/channel/webhook/test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: "{}",
        signal
      }),
    timeoutMs
  );

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
  try {
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
  } catch (error) {
    return {
      ok: false,
      status: 0,
      detail: `reply exception: ${String(error?.message || "unknown").slice(0, 260)}`
    };
  }
};

const sendLinePushMessage = async ({ accessToken, to, message, timeoutMs }) => {
  try {
    const response = await withTimeout(
      (signal) =>
        fetch(linePushApiUrl, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            to,
            messages: [{ type: "text", text: message }]
          })
        }),
      timeoutMs
    );
    if (response.ok) {
      return { ok: true, via: "push" };
    }
    const bodyText = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      detail: bodyText.slice(0, 300)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      detail: `push exception: ${String(error?.message || "unknown").slice(0, 260)}`
    };
  }
};

const resolvePushTarget = (event) => {
  const source = event && typeof event === "object" ? event.source : null;
  return String(source?.groupId || source?.roomId || source?.userId || "").trim();
};

const sendLineMessageWithFallback = async ({ accessToken, replyToken, pushTo, message, timeoutMs }) => {
  if (hasUsableReplyToken(replyToken)) {
    const replyResult = await sendPausedLineReply({
      accessToken,
      replyToken,
      message,
      timeoutMs
    });
    if (replyResult.ok) {
      return { ok: true, via: "reply" };
    }
    if (!pushTo) {
      return replyResult;
    }
    const pushResult = await sendLinePushMessage({
      accessToken,
      to: pushTo,
      message,
      timeoutMs
    });
    if (pushResult.ok) {
      return { ok: true, via: "push_fallback", replyStatus: replyResult.status };
    }
    return {
      ok: false,
      status: pushResult.status,
      detail: `reply:${replyResult.status} ${replyResult.detail || ""} / push:${pushResult.status} ${pushResult.detail || ""}`.slice(0, 300)
    };
  }

  if (!pushTo) {
    return { ok: false, status: 400, detail: "no replyToken and no push target" };
  }
  const pushResult = await sendLinePushMessage({
    accessToken,
    to: pushTo,
    message,
    timeoutMs
  });
  if (pushResult.ok) {
    return { ok: true, via: "push" };
  }
  return pushResult;
};

const sendLineMessagePushPreferred = async ({ accessToken, replyToken, pushTo, message, timeoutMs }) => {
  if (pushTo) {
    const pushResult = await sendLinePushMessage({
      accessToken,
      to: pushTo,
      message,
      timeoutMs
    });
    if (pushResult.ok) {
      return { ok: true, via: "push" };
    }
    if (hasUsableReplyToken(replyToken)) {
      const replyResult = await sendPausedLineReply({
        accessToken,
        replyToken,
        message,
        timeoutMs
      });
      if (replyResult.ok) {
        return { ok: true, via: "reply_fallback", pushStatus: pushResult.status };
      }
      return {
        ok: false,
        status: replyResult.status || pushResult.status,
        detail: `push:${pushResult.status} ${pushResult.detail || ""} / reply:${replyResult.status} ${replyResult.detail || ""}`.slice(0, 300)
      };
    }
    return pushResult;
  }
  return sendLineMessageWithFallback({
    accessToken,
    replyToken,
    pushTo,
    message,
    timeoutMs
  });
};

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isResumeAlreadyRunningMessage = (payload) =>
  String(payload?.message || "").includes("すでに稼働中");

const buildResumeLineAcceptedText = (payload) => {
  if (isResumeAlreadyRunningMessage(payload)) {
    return "起動完了しています（すでに稼働中です）。";
  }
  return "起動リクエストを受け付けました。起動完了まで20〜90秒ほどかかる場合があります。完了したら「起動完了」と送信します。";
};

const buildResumeImmediateAckText = () =>
  "起動リクエストを受け付けました。起動完了まで20〜90秒ほどかかる場合があります。";

const tryQueueResumeCompletionNotice = ({
  backgroundTask,
  env,
  accessToken,
  pushTo,
  healthUrl,
  timeoutMs,
  resumePayload
}) => {
  if (typeof backgroundTask !== "function" || !accessToken || !pushTo) {
    return false;
  }
  if (isResumeAlreadyRunningMessage(resumePayload)) {
    return false;
  }

  const completionText = String(env.RESUME_COMPLETE_PUSH_TEXT || "").trim() || "起動完了しました。";
  const pollIntervalMs = Math.max(3000, Number(env.RESUME_COMPLETE_POLL_MS || 5000) || 5000);
  const maxWaitMs = Math.max(30000, Number(env.RESUME_COMPLETE_MAX_WAIT_MS || 180000) || 180000);
  const pollTimeoutMs = Math.max(1000, timeoutMs);

  const task = (async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
      await sleep(pollIntervalMs);
      const healthy = await isHealthy(healthUrl, pollTimeoutMs);
      if (!healthy) {
        continue;
      }
      await sendLinePushMessage({
        accessToken,
        to: pushTo,
        message: completionText,
        timeoutMs: Math.max(5000, pollTimeoutMs + 3000)
      });
      return;
    }
  })().catch(() => {});

  backgroundTask(task);
  return true;
};

const queueResumeBackgroundFlow = ({
  backgroundTask,
  env,
  accessToken,
  pushTo,
  healthUrl,
  timeoutMs
}) => {
  if (typeof backgroundTask !== "function") {
    return false;
  }
  const task = (async () => {
    const response = await handleResumeRequest({ env, healthUrl, timeoutMs });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (accessToken && pushTo) {
        await sendLinePushMessage({
          accessToken,
          to: pushTo,
          message: "起動に失敗しました。時間をおいて再試行してください。",
          timeoutMs: Math.max(5000, timeoutMs + 3000)
        });
      }
      return;
    }

    if (isResumeAlreadyRunningMessage(payload)) {
      if (accessToken && pushTo) {
        await sendLinePushMessage({
          accessToken,
          to: pushTo,
          message: "起動完了しています（すでに稼働中です）。",
          timeoutMs: Math.max(5000, timeoutMs + 3000)
        });
      }
      return;
    }

    tryQueueResumeCompletionNotice({
      backgroundTask,
      env,
      accessToken,
      pushTo,
      healthUrl,
      timeoutMs,
      resumePayload: payload
    });
  })().catch(async () => {
    if (accessToken && pushTo) {
      await sendLinePushMessage({
        accessToken,
        to: pushTo,
        message: "起動処理でエラーが発生しました。管理画面で状態を確認してください。",
        timeoutMs: Math.max(5000, timeoutMs + 3000)
      });
    }
  });

  backgroundTask(task);
  return true;
};

const queueSuspendBackgroundFlow = ({
  backgroundTask,
  env,
  accessToken,
  pushTo,
  timeoutMs
}) => {
  if (typeof backgroundTask !== "function") {
    return false;
  }
  const task = (async () => {
    const response = await handleSuspendRequest({ env, timeoutMs });
    if (!accessToken || !pushTo) {
      return;
    }
    if (!response.ok) {
      await sendLinePushMessage({
        accessToken,
        to: pushTo,
        message: "休止に失敗しました。時間をおいて再試行してください。",
        timeoutMs: Math.max(5000, timeoutMs + 3000)
      });
      return;
    }
    await sendLinePushMessage({
      accessToken,
      to: pushTo,
      message: "休止完了しました。",
      timeoutMs: Math.max(5000, timeoutMs + 3000)
    });
  })().catch(async () => {
    if (accessToken && pushTo) {
      await sendLinePushMessage({
        accessToken,
        to: pushTo,
        message: "休止処理でエラーが発生しました。管理画面で状態を確認してください。",
        timeoutMs: Math.max(5000, timeoutMs + 3000)
      });
    }
  });

  backgroundTask(task);
  return true;
};

const normalizeCommandText = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[。．｡、，,!！?？]/g, "")
    .replace(/\s+/g, "")
    .trim();

const hasUsableReplyToken = (replyToken) => {
  const token = String(replyToken || "").trim();
  return Boolean(token) && token !== lineDummyReplyToken;
};

const includesAnyKeyword = (text, keywords) =>
  keywords.some((keyword) => text === keyword || text.includes(keyword));

const isResumeCommand = (text) => {
  const normalized = normalizeCommandText(text);
  const resumeKeywords = [
    "起動",
    "再開",
    "再稼働",
    "サーバー起動",
    "サーバー再開",
    "resume",
    "start"
  ];
  return includesAnyKeyword(normalized, resumeKeywords);
};

const isSuspendCommand = (text) => {
  const normalized = normalizeCommandText(text);
  const suspendKeywords = [
    "休止",
    "停止",
    "サーバー休止",
    "サーバー停止",
    "suspend",
    "stop"
  ];
  return includesAnyKeyword(normalized, suspendKeywords);
};

const buildSuspendLineSuccessText = () => "休止完了しました。";

const handlePausedLineWebhook = async ({ env, bodyBuffer, timeoutMs, signature, healthUrl, backgroundTask, recordDiag }) => {
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
      if (typeof recordDiag === "function") {
        recordDiag({
          stage: "signature_invalid",
          mode: "paused"
        });
      }
      return asJson(401, { ok: false, error: "invalid line signature" });
    }
  }

  let payload;
  try {
    payload = JSON.parse(textDecoder.decode(bodyBuffer));
  } catch {
    if (typeof recordDiag === "function") {
      recordDiag({
        stage: "parse_error",
        mode: "paused"
      });
    }
    return asJson(400, { ok: false, error: "invalid webhook payload" });
  }

  const pausedMessage = String(env.PAUSED_LINE_REPLY_TEXT || "").trim()
    || "ただいまの時間はサーバーが休止中です。";
  const pausedWithGuide = `${pausedMessage}\n再開する場合は「起動」と送信してください。`;
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const resumeCommandCount = events.filter(
    (event) =>
      String(event?.type || "") === "message"
      && String(event?.message?.type || "") === "text"
      && isResumeCommand(String(event?.message?.text || "").trim())
  ).length;
  const replyTargets = events
    .map((event) => ({
      replyToken: String(event?.replyToken || "").trim(),
      pushTo: resolvePushTarget(event),
      type: String(event?.type || ""),
      messageType: String(event?.message?.type || ""),
      messageText: String(event?.message?.text || "").trim()
    }))
    .filter((event) => hasUsableReplyToken(event.replyToken) || Boolean(event.pushTo));

  if (typeof recordDiag === "function") {
    recordDiag({
      stage: "parsed",
      mode: "paused",
      eventCount: events.length,
      replyTargetCount: replyTargets.length,
      resumeCommandCount,
      eventSamples: replyTargets.slice(0, 3).map((event) => ({
        type: event.type,
        messageType: event.messageType,
        text: event.messageText.slice(0, 24),
        hasReplyToken: hasUsableReplyToken(event.replyToken),
        hasPushTo: Boolean(event.pushTo)
      }))
    });
  }

  if (!replyTargets.length) {
    if (typeof recordDiag === "function") {
      recordDiag({
        stage: "no_reply_target",
        mode: "paused"
      });
    }
    return asJson(200, { ok: true, paused: true, replied: 0 });
  }

  let resumeJobQueued = false;

  const results = await Promise.all(
    replyTargets.map(async (event) => {
      try {
        let replyText = pausedWithGuide;
        if (event.type === "message" && event.messageType === "text" && isResumeCommand(event.messageText)) {
          replyText = buildResumeImmediateAckText();
          if (!resumeJobQueued) {
            resumeJobQueued = queueResumeBackgroundFlow({
              backgroundTask,
              env,
              accessToken: lineAccessToken,
              pushTo: event.pushTo,
              healthUrl,
              timeoutMs
            });
          }
        } else if (event.type === "message" && event.messageType === "text" && isSuspendCommand(event.messageText)) {
          replyText = "休止完了しています。再開する場合は「起動」と送信してください。";
        }
        const isCommand =
          event.type === "message" &&
          event.messageType === "text" &&
          (isResumeCommand(event.messageText) || isSuspendCommand(event.messageText));

        const sendFn = isCommand ? sendLineMessagePushPreferred : sendLineMessageWithFallback;
        return await sendFn({
          accessToken: lineAccessToken,
          replyToken: event.replyToken,
          pushTo: event.pushTo,
          message: replyText,
          timeoutMs: Math.max(5000, timeoutMs + 6000)
        });
      } catch (error) {
        return {
          ok: false,
          status: 0,
          detail: `paused handler exception: ${String(error?.message || "unknown").slice(0, 260)}`
        };
      }
    })
  );

  const failed = results.find((result) => !result.ok);
  if (failed) {
    if (typeof recordDiag === "function") {
      recordDiag({
        stage: "reply_failed",
        mode: "paused",
        failedStatus: failed.status || null,
        failedDetail: String(failed.detail || "").slice(0, 160),
        replyResults: results.map((x) => ({
          ok: Boolean(x?.ok),
          status: x?.status ?? null,
          via: String(x?.via || "")
        }))
      });
    }
    return asJson(502, {
      ok: false,
      error: `LINE reply failed (${failed.status})`,
      detail: failed.detail || ""
    });
  }

  if (typeof recordDiag === "function") {
    recordDiag({
      stage: "reply_sent",
      mode: "paused",
      replyResults: results.map((x) => ({
        ok: Boolean(x?.ok),
        status: x?.status ?? null,
        via: String(x?.via || "")
      }))
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
      if (response.status === 400 && /only services suspended by a user can be resumed/i.test(bodyText)) {
        const state = await fetchRenderState({ env, timeoutMs });
        if (state?.suspended === "not_suspended") {
          return asJson(200, {
            ok: true,
            message: "現在、再開処理中または稼働中です。30〜90秒待って再読み込みしてください。"
          });
        }
        if (state?.suspended === "suspended" && !state.suspenders.includes("user")) {
          return asJson(409, {
            ok: false,
            error: "現在の停止状態では再開できません。Render管理画面から再開してください。"
          });
        }
      }
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

const runScheduledRenderControl = async ({ env, healthUrl, timeoutMs, action }) => {
  const response =
    action === "suspend"
      ? await handleSuspendRequest({ env, timeoutMs })
      : await handleResumeRequest({ env, healthUrl, timeoutMs });
  const payload = await response.json().catch(() => ({}));
  const summary = String(payload?.message || payload?.error || payload?.detail || "").slice(0, 260);
  console.log(
    `[schedule:${action}] status=${response.status} ok=${Boolean(payload?.ok)} message="${summary}"`
  );
  return { status: response.status, payload };
};

const handleLiveLineWebhook = async ({ env, bodyBuffer, timeoutMs, signature, healthUrl, request, appUrl, backgroundTask, recordDiag }) => {
  const lineChannelSecret = String(env.LINE_CHANNEL_SECRET || "").trim();
  if (lineChannelSecret) {
    const valid = await verifyLineSignature({
      bodyBuffer,
      signature,
      channelSecret: lineChannelSecret
    });
    if (!valid) {
      if (typeof recordDiag === "function") {
        recordDiag({
          stage: "signature_invalid",
          mode: "live"
        });
      }
      return asJson(401, { ok: false, error: "invalid line signature" });
    }
  }

  let payload;
  try {
    payload = JSON.parse(textDecoder.decode(bodyBuffer));
  } catch {
    if (typeof recordDiag === "function") {
      recordDiag({
        stage: "parse_error",
        mode: "live"
      });
    }
    return asJson(400, { ok: false, error: "invalid webhook payload" });
  }

  const events = Array.isArray(payload?.events) ? payload.events : [];
  const parsedEvents = events.map((event) => ({
    replyToken: String(event?.replyToken || "").trim(),
    pushTo: resolvePushTarget(event),
    type: String(event?.type || ""),
    messageType: String(event?.message?.type || ""),
    messageText: String(event?.message?.text || "").trim()
  }));

  const commandEvents = parsedEvents.filter(
    (event) =>
      event.type === "message" &&
      event.messageType === "text" &&
      (hasUsableReplyToken(event.replyToken) || Boolean(event.pushTo)) &&
      (isSuspendCommand(event.messageText) || isResumeCommand(event.messageText))
  );

  if (typeof recordDiag === "function") {
    recordDiag({
      stage: "parsed",
      mode: "live",
      eventCount: events.length,
      commandCount: commandEvents.length,
      allEventsAreCommand: events.length > 0 && commandEvents.length === events.length,
      commandSamples: commandEvents.slice(0, 3).map((event) => ({
        text: event.messageText.slice(0, 24),
        hasReplyToken: hasUsableReplyToken(event.replyToken),
        hasPushTo: Boolean(event.pushTo)
      }))
    });
  }

  if (commandEvents.length === 0) {
    if (typeof recordDiag === "function") {
      recordDiag({
        stage: "forward_to_app",
        mode: "live"
      });
    }
    return forwardRequestToApp({ request, appUrl, bodyBuffer });
  }

  if (typeof recordDiag === "function" && commandEvents.length !== events.length) {
    recordDiag({
      stage: "mixed_events_command_only",
      mode: "live",
      ignoredEventCount: events.length - commandEvents.length
    });
  }

  const lineAccessToken = String(env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
  if (!lineAccessToken) {
    return asJson(500, { ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN が未設定です。" });
  }

  let suspendJobQueued = false;
  let resumeJobQueued = false;

  const results = await Promise.all(
    commandEvents.map(async (event) => {
      try {
        let replyText = "コマンドを受け付けました。";
        if (isSuspendCommand(event.messageText)) {
          replyText = "休止リクエストを受け付けました。完了まで30秒前後かかる場合があります。";
          if (!suspendJobQueued) {
            suspendJobQueued = queueSuspendBackgroundFlow({
              backgroundTask,
              env,
              accessToken: lineAccessToken,
              pushTo: event.pushTo,
              timeoutMs
            });
          }
        } else if (isResumeCommand(event.messageText)) {
          replyText = buildResumeImmediateAckText();
          if (!resumeJobQueued) {
            resumeJobQueued = queueResumeBackgroundFlow({
              backgroundTask,
              env,
              accessToken: lineAccessToken,
              pushTo: event.pushTo,
              healthUrl,
              timeoutMs
            });
          }
        }
        return await sendLineMessagePushPreferred({
          accessToken: lineAccessToken,
          replyToken: event.replyToken,
          pushTo: event.pushTo,
          message: replyText,
          timeoutMs: Math.max(5000, timeoutMs + 6000)
        });
      } catch (error) {
        return {
          ok: false,
          status: 0,
          detail: `live handler exception: ${String(error?.message || "unknown").slice(0, 260)}`
        };
      }
    })
  );

  const failed = results.find((result) => !result.ok);
  if (failed) {
    if (typeof recordDiag === "function") {
      recordDiag({
        stage: "reply_failed",
        mode: "live",
        failedStatus: failed.status || null,
        failedDetail: String(failed.detail || "").slice(0, 160),
        replyResults: results.map((x) => ({
          ok: Boolean(x?.ok),
          status: x?.status ?? null,
          via: String(x?.via || "")
        }))
      });
    }
    return asJson(502, {
      ok: false,
      error: `LINE reply failed (${failed.status})`,
      detail: failed.detail || ""
    });
  }

  if (typeof recordDiag === "function") {
    recordDiag({
      stage: "reply_sent",
      mode: "live",
      replyResults: results.map((x) => ({
        ok: Boolean(x?.ok),
        status: x?.status ?? null,
        via: String(x?.via || "")
      }))
    });
  }

  return asJson(200, { ok: true, live: true, handledCommands: commandEvents.length });
};

export default {
  async fetch(request, env, ctx) {
    const appUrl = trimSlash(env.APP_URL || "https://line-wine-api.onrender.com");
    const healthUrl = String(env.HEALTH_URL || `${appUrl}/api/health`).trim();
    const timeoutMs = Math.max(500, Number(env.HEALTH_TIMEOUT_MS || 2500) || 2500);
    const backgroundTask = (promise) => {
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(promise);
      }
    };
    const url = new URL(request.url);
    const path = url.pathname;
    const webhookDiagBase = {
      requestId: String(request.headers.get("cf-ray") || ""),
      path,
      method: request.method
    };
    const recordDiag = (partial) => {
      const snapshot = {
        ...webhookDiagBase,
        ...partial
      };
      setRuntimeWebhookDiag(snapshot);
      backgroundTask(persistRuntimeWebhookDiag(runtimeDiagnostics.lastWebhook));
    };

    if (path === "/webhooks/line" && request.method === "POST") {
      recordDiag({ stage: "received" });
      const bodyBuffer = await request.arrayBuffer();
      const healthy = await isHealthy(healthUrl, timeoutMs);
      recordDiag({ stage: "health_checked", healthy, mode: healthy ? "live" : "paused" });
      if (healthy) {
        try {
          return await handleLiveLineWebhook({
            env,
            bodyBuffer,
            timeoutMs,
            signature: request.headers.get("x-line-signature"),
            healthUrl,
            request,
            appUrl,
            backgroundTask,
            recordDiag
          });
        } catch (error) {
          recordDiag({
            stage: "handler_crash",
            mode: "live",
            error: String(error?.message || "unknown").slice(0, 220)
          });
          return asJson(500, { ok: false, error: "live webhook handler crashed" });
        }
      }
      try {
        return await handlePausedLineWebhook({
          env,
          bodyBuffer,
          timeoutMs,
          signature: request.headers.get("x-line-signature"),
          healthUrl,
          backgroundTask,
          recordDiag
        });
      } catch (error) {
        recordDiag({
          stage: "handler_crash",
          mode: "paused",
          error: String(error?.message || "unknown").slice(0, 220)
        });
        return asJson(500, { ok: false, error: "paused webhook handler crashed" });
      }
    }

    if (path === "/__health" && request.method === "GET") {
      const healthy = await isHealthy(healthUrl, timeoutMs);
      return asJson(200, { ok: true, healthy });
    }

    if (path === "/__diag/line" && request.method === "GET") {
      const lineAccessToken = String(env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
      const lineChannelSecret = String(env.LINE_CHANNEL_SECRET || "").trim();
      if (!lineAccessToken) {
        return asJson(200, {
          ok: true,
          hasAccessToken: false,
          hasChannelSecret: Boolean(lineChannelSecret),
          lineApiOk: false,
          lineApiStatus: null,
          lineApiBody: "LINE_CHANNEL_ACCESS_TOKEN が未設定です。"
        });
      }
      try {
        const lineApiTimeoutMs = Math.max(2000, timeoutMs + 2000);
        const [botInfoResponse, webhookResponse, quotaResponse] = await Promise.all([
          callLineBotInfo({
            accessToken: lineAccessToken,
            timeoutMs: lineApiTimeoutMs
          }),
          callLineWebhookEndpointInfo({
            accessToken: lineAccessToken,
            timeoutMs: lineApiTimeoutMs
          }),
          callLineMessageQuota({
            accessToken: lineAccessToken,
            timeoutMs: lineApiTimeoutMs
          })
        ]);
        const botInfoBodyText = await botInfoResponse.text().catch(() => "");
        const webhookBodyText = await webhookResponse.text().catch(() => "");
        const quotaBodyText = await quotaResponse.text().catch(() => "");
        let webhookInfo = {};
        try {
          webhookInfo = JSON.parse(webhookBodyText || "{}");
        } catch {
          webhookInfo = {};
        }
        return asJson(200, {
          ok: true,
          hasAccessToken: true,
          hasChannelSecret: Boolean(lineChannelSecret),
          lineApiOk: botInfoResponse.ok,
          lineApiStatus: botInfoResponse.status,
          lineApiBody: botInfoBodyText.slice(0, 300),
          webhookApiOk: webhookResponse.ok,
          webhookApiStatus: webhookResponse.status,
          webhookEndpoint: String(webhookInfo?.endpoint || ""),
          webhookActive: Boolean(webhookInfo?.active),
          webhookApiBody: webhookBodyText.slice(0, 300),
          quotaApiOk: quotaResponse.ok,
          quotaApiStatus: quotaResponse.status,
          quotaApiBody: quotaBodyText.slice(0, 300)
        });
      } catch (error) {
        return asJson(200, {
          ok: true,
          hasAccessToken: true,
          hasChannelSecret: Boolean(lineChannelSecret),
          lineApiOk: false,
          lineApiStatus: null,
          lineApiBody: String(error?.message || "LINE API check failed").slice(0, 300),
          webhookApiOk: false,
          webhookApiStatus: null,
          webhookEndpoint: "",
          webhookActive: false,
          webhookApiBody: String(error?.message || "LINE webhook API check failed").slice(0, 300),
          quotaApiOk: false,
          quotaApiStatus: null,
          quotaApiBody: String(error?.message || "LINE quota API check failed").slice(0, 300)
        });
      }
    }

    if (path === "/__diag/line-webhook-test" && request.method === "POST") {
      const lineAccessToken = String(env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
      if (!lineAccessToken) {
        return asJson(500, {
          ok: false,
          error: "LINE_CHANNEL_ACCESS_TOKEN が未設定です。"
        });
      }
      try {
        const response = await callLineWebhookTest({
          accessToken: lineAccessToken,
          timeoutMs: Math.max(2000, timeoutMs + 2000)
        });
        const bodyText = await response.text().catch(() => "");
        return asJson(200, {
          ok: response.ok,
          status: response.status,
          body: bodyText.slice(0, 500)
        });
      } catch (error) {
        return asJson(502, {
          ok: false,
          status: 0,
          error: String(error?.message || "LINE webhook test failed").slice(0, 300)
        });
      }
    }

    if (path === "/__diag/last-webhook" && request.method === "GET") {
      const persisted = await loadPersistedRuntimeWebhookDiag();
      return asJson(200, {
        ok: true,
        lastWebhook: runtimeDiagnostics.lastWebhook || persisted || null
      });
    }

    if (path === "/__diag/schedule" && request.method === "GET") {
      const scheduleConfig = getAutoScheduleConfig(env);
      return asJson(200, {
        ok: true,
        ...scheduleConfig,
        timezone: "Asia/Tokyo",
        pauseWindowJst: "02:00-12:00"
      });
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
  },

  async scheduled(controller, env, ctx) {
    const appUrl = trimSlash(env.APP_URL || "https://line-wine-api.onrender.com");
    const healthUrl = String(env.HEALTH_URL || `${appUrl}/api/health`).trim();
    const timeoutMs = Math.max(500, Number(env.HEALTH_TIMEOUT_MS || 2500) || 2500);
    const cron = String(controller?.cron || "").trim();
    const scheduleConfig = getAutoScheduleConfig(env);

    if (!scheduleConfig.enabled) {
      console.log(`[schedule] skipped: disabled (cron=${cron || "unknown"})`);
      return;
    }

    let action = "";
    if (cron === scheduleConfig.suspendCronUtc) {
      action = "suspend";
    } else if (cron === scheduleConfig.resumeCronUtc) {
      action = "resume";
    } else {
      console.log(
        `[schedule] ignored cron=${cron || "unknown"} expected suspend=${scheduleConfig.suspendCronUtc} resume=${scheduleConfig.resumeCronUtc}`
      );
      return;
    }

    const task = runScheduledRenderControl({
      env,
      healthUrl,
      timeoutMs,
      action
    }).catch((error) => {
      const message = String(error?.message || "unknown");
      console.log(`[schedule:${action}] unexpected error: ${message}`);
      throw error;
    });

    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
      return;
    }
    await task;
  }
};
