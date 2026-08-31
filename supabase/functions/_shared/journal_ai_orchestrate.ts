/**
 * Journal Report AI チャット用の意図分類と外部AI（Perplexity / Grok）連携。
 * 数値正本は常に OpenAI gpt-5.6-luna + 保存済みレポート側。戦略・対策系だけ外部知見を足す。
 */

export type JournalChatIntent = "data" | "strategy" | "mixed";

/**
 * x_search 1回分の実測コスト材料。
 * xAI はトークンとは別に「ツール実行回数」で課金する（x_search: $5 / 1k calls）ため、
 * トークンだけでは実費が出ない。xSearchCalls を必ず一緒に持ち回る。
 */
export type GrokXSearchUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  xSearchCalls: number;
};

export type ExternalBrief = {
  provider: "perplexity" | "grok";
  ok: boolean;
  text: string;
  error?: string;
  searchedAt?: string;
  searchRange?: { from: string; to: string };
  citations?: string[];
  usage?: GrokXSearchUsage;
};

type JsonRecord = Record<string, unknown>;

export type GrokXSearchRequestOptions = {
  model: string;
  question: string;
  companyHint: string;
  fromDate: string;
  toDate: string;
  maxToolCalls: number;
  /**
   * grok-4.5 は reasoning トークンも output に算入される。小さすぎると推論で枠を使い切り、
   * 本文が出ないまま empty_content になる（2026-08-04 の実測は 1339/1400 でほぼ上限）。
   */
  maxOutputTokens: number;
};

export type ParsedGrokXSearchResponse = {
  text: string;
  citations: string[];
  usedXSearch: boolean;
  evidence: "tool_call" | "server_usage" | "structured_x_citation" | "none";
  /** 実際に走った x_search の回数（課金単位）。数えられない場合は検索実施なら 1、未実施なら 0。 */
  xSearchCalls: number;
};

const XAI_RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";
const GROK_X_SEARCH_MODEL_DEFAULT = "grok-4.5";
const GROK_X_SEARCH_LOOKBACK_DAYS_DEFAULT = 30;
const GROK_X_SEARCH_LOOKBACK_DAYS_MAX = 90;

const DATA_RE =
  /(売上|売り上げ|客数|客単価|比率|構成比|何円|いくら|合計|推移|比較|何が売|売れ筋|ランキング|点数|件数|フード|ドリンク|飲料|グラス|ボトル|月間|日別|\d{4}\s*年|\d{4}-?\d{2}|TOP\s*\d+)/i;

const STRATEGY_RE =
  /(対策|戦略|施策|改善|打開|どうすれば|どうしたら|アドバイス|提案|おすすめ|経営|トレンド|流行|他店|業界|事例|ペアリング|アップセル|クロスセル|集客|プロモ|SNS|X\b|ツイート|Twitter|検索|調べて|外部|市場)/i;

/** 質問文から data / strategy / mixed を判定する（オーバーライド未指定時） */
export function classifyJournalChatIntent(message: string): JournalChatIntent {
  const q = String(message || "").trim();
  if (!q) return "data";
  const hasData = DATA_RE.test(q);
  const hasStrategy = STRATEGY_RE.test(q);
  if (hasData && hasStrategy) return "mixed";
  if (hasStrategy) return "strategy";
  return "data";
}

export function normalizeJournalChatIntent(
  raw: unknown,
  message: string,
): JournalChatIntent {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "data" || v === "strategy" || v === "mixed") return v;
  if (v === "auto" || !v) return classifyJournalChatIntent(message);
  return classifyJournalChatIntent(message);
}

function truncate(s: string, max: number): string {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInteger(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function toJstDateString(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function shiftIsoDate(isoDate: string, deltaDays: number): string {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}

/** 「最新トレンド」のX検索対象期間。JST基準で当日を含む。 */
export function resolveGrokXSearchWindow(
  now: Date = new Date(),
  lookbackDaysRaw: unknown = GROK_X_SEARCH_LOOKBACK_DAYS_DEFAULT,
): { from: string; to: string; lookbackDays: number } {
  const lookbackDays = clampInteger(
    lookbackDaysRaw,
    GROK_X_SEARCH_LOOKBACK_DAYS_DEFAULT,
    1,
    GROK_X_SEARCH_LOOKBACK_DAYS_MAX,
  );
  const to = toJstDateString(now);
  return {
    from: shiftIsoDate(to, -(lookbackDays - 1)),
    to,
    lookbackDays,
  };
}

/**
 * xAI Responses API用のリクエストを構築する。
 * tool_choice=required かつ利用可能ツールを x_search のみにすることで、
 * 「学習済み知識だけでトレンドを回答する」経路を残さない。
 */
export function buildGrokXSearchRequest(
  options: GrokXSearchRequestOptions,
): JsonRecord {
  const {
    model,
    question,
    companyHint,
    fromDate,
    toDate,
    maxToolCalls,
    maxOutputTokens,
  } = options;
  const userPrompt =
    `マルゴグループ（ワイン推しの飲食店グループ）向けに、指定期間のX（旧Twitter）を実際に検索し、質問の対策に使える最新トレンドを日本語でまとめてください。

検索対象期間: ${fromDate}〜${toDate}（両端を含む）
前提: ${companyHint}
質問: ${question}

必須条件:
1. X検索を実行し、複数の検索語・観点で確認する。
2. 主要な示唆を3〜5件に絞り、各項目に「投稿日」「投稿アカウント」「何が話題か」「マルゴへの意味」を含める。
3. 単発投稿を市場全体の事実と断定せず、複数投稿で確認できた傾向と個別の話題を区別する。
4. 店舗固有の売上数値は作らない。人気度・反応数が確認できない場合は推測しない。
5. 引用したX投稿またはスレッドのURLを各示唆に付ける。
6. 最後に、ジャーナルの保存済み数値とは別の「外部知見」であることを明記する。

400〜700字程度で、日付と投稿文脈が分かる実務向けブリーフにしてください。`;

  return {
    model,
    input: [
      {
        role: "system",
        content:
          "You are an X trend researcher for a wine-focused restaurant group in Japan. You must use X Search before answering. Reply in Japanese, preserve source URLs, and never fabricate store metrics or social engagement.",
      },
      { role: "user", content: userPrompt },
    ],
    tools: [
      {
        type: "x_search",
        from_date: fromDate,
        to_date: toDate,
      },
    ],
    tool_choice: "required",
    max_tool_calls: maxToolCalls,
    max_output_tokens: maxOutputTokens,
    reasoning: { effort: "low" },
    store: false,
  };
}

function addCitationUrl(urls: string[], raw: unknown): void {
  const url = String(raw || "").trim();
  if (!/^https?:\/\//i.test(url)) return;
  if (!urls.includes(url)) urls.push(url);
}

function collectAnnotationUrls(
  content: JsonRecord,
  urls: string[],
  structuredUrls: string[],
): void {
  const annotations = Array.isArray(content.annotations)
    ? content.annotations
    : [];
  for (const annotation of annotations) {
    if (!isRecord(annotation)) continue;
    addCitationUrl(urls, annotation.url);
    addCitationUrl(structuredUrls, annotation.url);
  }
}

function containsXSearchUsage(value: unknown): boolean {
  if (typeof value === "string") {
    return /(^|[^a-z])(?:server_side_tool_)?x_search(?:[^a-z]|$)/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsXSearchUsage);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    containsXSearchUsage(key) || containsXSearchUsage(nested)
  );
}

/** xAI Responses APIの typed output と citations を安全に正規化する。 */
export function parseGrokXSearchResponse(
  json: unknown,
): ParsedGrokXSearchResponse {
  if (!isRecord(json)) {
    return {
      text: "",
      citations: [],
      usedXSearch: false,
      evidence: "none",
      xSearchCalls: 0,
    };
  }
  let text = "";
  const citations: string[] = [];
  const structuredUrls: string[] = [];
  let toolCallUsed = false;
  let xSearchCalls = 0;

  if (Array.isArray(json.citations)) {
    for (const citation of json.citations) {
      addCitationUrl(citations, citation);
      addCitationUrl(structuredUrls, citation);
    }
  }

  const output = Array.isArray(json.output) ? json.output : [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === "x_search_call") {
      toolCallUsed = true;
      xSearchCalls += 1;
    }
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== "output_text") continue;
      const outputText = String(content.text || "").trim();
      if (outputText) {
        text = outputText;
        for (const match of outputText.matchAll(/https?:\/\/[^\s)\]]+/gi)) {
          addCitationUrl(citations, match[0]);
        }
      }
      collectAnnotationUrls(content, citations, structuredUrls);
    }
  }

  const serverUsageUsed = containsXSearchUsage(json.server_side_tool_usage);
  const structuredXSourceUsed = structuredUrls.some(isXSourceUrl);
  const evidence = toolCallUsed
    ? "tool_call"
    : serverUsageUsed
    ? "server_usage"
    : structuredXSourceUsed
    ? "structured_x_citation"
    : "none";

  const usedXSearch = evidence !== "none";
  return {
    text: String(json.output_text || "").trim() || text,
    citations,
    usedXSearch,
    evidence,
    // x_search_call を数えられない応答形（server_usage / citation からの推定）でも、
    // 検索が走った以上は最低1回分は課金されているので 0 とは扱わない。
    xSearchCalls: xSearchCalls > 0 ? xSearchCalls : (usedXSearch ? 1 : 0),
  };
}

/** xAI Responses API の usage（input_tokens / output_tokens / total_tokens）を取り出す。 */
function extractGrokUsage(
  json: unknown,
  model: string,
  xSearchCalls: number,
): GrokXSearchUsage {
  const root = isRecord(json) ? json : {};
  const u = isRecord(root.usage) ? root.usage : {};
  const inputTokens = Number(u.input_tokens ?? 0) || 0;
  const outputTokens = Number(u.output_tokens ?? 0) || 0;
  const totalTokens = Number(u.total_tokens ?? 0) || (inputTokens + outputTokens);
  return { model, inputTokens, outputTokens, totalTokens, xSearchCalls };
}

function isXSourceUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "x.com" || host.endsWith(".x.com") ||
      host === "twitter.com" || host.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

function formatGrokXSearchBrief(
  text: string,
  searchedAt: string,
  searchRange: { from: string; to: string },
  citations: string[],
): string {
  const sourceUrls = citations.filter(isXSourceUrl).slice(0, 10);
  const sourceBlock = sourceUrls.length
    ? `\n\nX参照元:\n${sourceUrls.map((url) => `- ${url}`).join("\n")}`
    : "";
  return truncate(
    `X検索実施日（JST）: ${searchedAt}
X検索対象期間: ${searchRange.from}〜${searchRange.to}

${text}${sourceBlock}`,
    4200,
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Perplexity Sonar（Web検索）で飲食・ワイン施策の外部知見を取得 */
export async function callPerplexityBrief(
  question: string,
  companyHint: string,
): Promise<ExternalBrief> {
  const apiKey = String(
    Deno.env.get("PERPLEXITY_API_KEY") || Deno.env.get("PPLX_API_KEY") || "",
  ).trim();
  if (!apiKey) {
    return {
      provider: "perplexity",
      ok: false,
      text: "",
      error: "missing_key",
    };
  }
  const model = String(Deno.env.get("PERPLEXITY_MODEL") || "").trim() ||
    "sonar";
  const timeoutMs = Number(Deno.env.get("PERPLEXITY_TIMEOUT_MS") || 12000) ||
    12000;
  const userPrompt =
    `あなたは飲食店・ワインバー向けの調査アシスタントです。次の質問について、Web上の一般的な飲食店対策・事例を日本語で簡潔にまとめてください（400〜700字）。数値の捏造は禁止。出典の種類（業界記事・事例など）が分かれば触れてください。\n\n企業前提: ${companyHint}\n質問: ${question}`;
  try {
    const res = await fetchWithTimeout(
      "https://api.perplexity.ai/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "Search the web for restaurant and wine-bar business tactics. Reply in Japanese. Do not invent store-specific sales numbers.",
            },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 1200,
          temperature: 0.2,
        }),
      },
      timeoutMs,
    );
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error("Perplexity error:", res.status, err.slice(0, 300));
      return {
        provider: "perplexity",
        ok: false,
        text: "",
        error: `http_${res.status}`,
      };
    }
    const json = await res.json().catch(() => null) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const text = truncate(
      String(json?.choices?.[0]?.message?.content || ""),
      2400,
    );
    return {
      provider: "perplexity",
      ok: !!text,
      text,
      error: text ? undefined : "empty_content",
    };
  } catch (e) {
    console.error("Perplexity fetch failed:", e);
    return {
      provider: "perplexity",
      ok: false,
      text: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Grok (xAI Responses API + x_search) でXの最新トレンドを取得 */
export async function callGrokTrendBrief(
  question: string,
  companyHint: string,
): Promise<ExternalBrief> {
  const apiKey = String(
    Deno.env.get("XAI_API_KEY") || Deno.env.get("GROK_API_KEY") || "",
  ).trim();
  if (!apiKey) {
    return { provider: "grok", ok: false, text: "", error: "missing_key" };
  }
  // 旧 JOURNAL_GROK_MODEL / FOODCOURT_GROK_MODEL は Chat Completions 用だったため、
  // X Search経路では専用設定だけを採用し、未設定時は公式の現行ツール対応モデルにする。
  const model = String(Deno.env.get("JOURNAL_GROK_X_SEARCH_MODEL") || "")
    .trim() || GROK_X_SEARCH_MODEL_DEFAULT;
  const timeoutMs = clampInteger(
    Deno.env.get("GROK_X_SEARCH_TIMEOUT_MS") ||
      Deno.env.get("GROK_TIMEOUT_MS"),
    45000,
    5000,
    120000,
  );
  const maxToolCalls = clampInteger(
    Deno.env.get("GROK_X_SEARCH_MAX_TOOL_CALLS"),
    4,
    1,
    8,
  );
  const searchWindow = resolveGrokXSearchWindow(
    new Date(),
    Deno.env.get("GROK_X_SEARCH_LOOKBACK_DAYS"),
  );
  const maxOutputTokens = clampInteger(
    Deno.env.get("GROK_X_SEARCH_MAX_OUTPUT_TOKENS"),
    3000,
    600,
    8000,
  );
  const requestBody = buildGrokXSearchRequest({
    model,
    question,
    companyHint,
    fromDate: searchWindow.from,
    toDate: searchWindow.to,
    maxToolCalls,
    maxOutputTokens,
  });
  try {
    const res = await fetchWithTimeout(
      XAI_RESPONSES_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
      timeoutMs,
    );
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error("Grok error:", res.status, err.slice(0, 300));
      return {
        provider: "grok",
        ok: false,
        text: "",
        error: `http_${res.status}`,
      };
    }
    const json = await res.json().catch(() => null);
    const parsed = parseGrokXSearchResponse(json);
    if (!parsed.usedXSearch) {
      const responseRecord = isRecord(json) ? json : {};
      const outputTypes = Array.isArray(responseRecord.output)
        ? responseRecord.output
          .filter(isRecord)
          .map((item) => String(item.type || "unknown"))
        : [];
      console.error("Grok response did not prove x_search", {
        outputTypes,
        citationCount: Array.isArray(responseRecord.citations)
          ? responseRecord.citations.length
          : 0,
        hasServerSideToolUsage: "server_side_tool_usage" in responseRecord,
      });
      return {
        provider: "grok",
        ok: false,
        text: "",
        error: "x_search_not_used",
        searchedAt: searchWindow.to,
        searchRange: { from: searchWindow.from, to: searchWindow.to },
        // 破棄する応答でも xAI は課金済み。実費を取りこぼさないため usage は返す。
        usage: extractGrokUsage(json, model, parsed.xSearchCalls),
      };
    }
    const xCitations = parsed.citations.filter(isXSourceUrl);
    if (!xCitations.length) {
      console.error("Grok x_search returned no X citation URLs");
      return {
        provider: "grok",
        ok: false,
        text: "",
        error: "missing_x_citations",
        searchedAt: searchWindow.to,
        searchRange: { from: searchWindow.from, to: searchWindow.to },
        // 検索は走っている＝課金済みなので、破棄しても usage は返す。
        usage: extractGrokUsage(json, model, parsed.xSearchCalls),
      };
    }
    const text = formatGrokXSearchBrief(
      parsed.text,
      searchWindow.to,
      { from: searchWindow.from, to: searchWindow.to },
      xCitations,
    );
    return {
      provider: "grok",
      ok: !!text,
      text,
      error: text ? undefined : "empty_content",
      searchedAt: searchWindow.to,
      searchRange: { from: searchWindow.from, to: searchWindow.to },
      citations: xCitations.slice(0, 10),
      usage: extractGrokUsage(json, model, parsed.xSearchCalls),
    };
  } catch (e) {
    console.error("Grok fetch failed:", e);
    return {
      provider: "grok",
      ok: false,
      text: "",
      error: e instanceof Error ? e.message : String(e),
      searchedAt: searchWindow.to,
      searchRange: { from: searchWindow.from, to: searchWindow.to },
    };
  }
}

/**
 * 外部ブリーフの短期キャッシュ。呼び出し側が保管先を与える。
 * ここで Supabase を直接触ると共有モジュールが実行環境に依存するため、
 * 取得と保存だけを受け取る形にしている。
 */
export type ExternalBriefCache = {
  get: (key: string) => Promise<ExternalBrief[] | null>;
  set: (key: string, briefs: ExternalBrief[]) => Promise<void>;
};

/**
 * キャッシュキー。同じ店舗・同じ意図・同じ趣旨の質問・同じ日なら一致させる。
 * 質問文は表記ゆれで別物になりやすいので、空白と大小文字だけ正規化する。
 * 日付を含めるのは、外部知見は日をまたぐと鮮度が落ちるため。
 */
export function externalBriefCacheKey(params: {
  storeKey: string;
  question: string;
  intent: JournalChatIntent;
  day: string;
}): string {
  const question = String(params.question || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return [
    String(params.storeKey || "").toLowerCase(),
    params.intent,
    params.day,
    question,
  ].join("\u0000");
}

/** 戦略／混合モード用に外部ブリーフを並列取得（キーが無い provider はスキップ） */
export async function gatherExternalBriefs(
  question: string,
  companyHint: string,
  intent: JournalChatIntent,
  cache?: { store: ExternalBriefCache; key: string },
): Promise<ExternalBrief[]> {
  if (intent === "data") return [];
  if (cache) {
    try {
      const cached = await cache.store.get(cache.key);
      // 全滅した結果を配ると失敗が固定化するので、1件でも成功していれば使う。
      if (cached && cached.some((brief) => brief.ok)) return cached;
    } catch (error) {
      // キャッシュはあくまで高速化と再現性のため。壊れていても本処理は続ける。
      console.warn(
        "external brief cache read failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const tasks: Promise<ExternalBrief>[] = [
    callPerplexityBrief(question, companyHint),
  ];
  // 戦略・混合では Grok も試す（キー無ければ missing_key で終わる）
  tasks.push(callGrokTrendBrief(question, companyHint));
  const briefs = await Promise.all(tasks);
  if (cache && briefs.some((brief) => brief.ok)) {
    try {
      await cache.store.set(cache.key, briefs);
    } catch (error) {
      console.warn(
        "external brief cache write failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return briefs;
}

export function formatExternalBriefsForPrompt(briefs: ExternalBrief[]): string {
  const ok = briefs.filter((b) => b.ok && b.text);
  if (!ok.length) return "";
  const blocks = ok.map((b) => {
    const label = b.provider === "perplexity"
      ? "Perplexity（Web検索）"
      : "Grok（X検索・投稿文脈付き最新トレンド）";
    return `### ${label}\n${b.text}`;
  });
  return `
【外部知見ブリーフ（数値のではない。店舗売上の根拠にしてはいけない）】
以下は Web / X トレンドからの一般知見です。保存済み売上データの数値と混ぜて捏造しないこと。
施策提案に使う場合は必ず「※これは外部知見です」「※これは推測です」と明示すること。

${blocks.join("\n\n")}`;
}

export function orchestrationNote(
  intent: JournalChatIntent,
  briefs: ExternalBrief[],
): string {
  if (intent === "data") return "モード: 数値検証（gpt-5.6-luna）";
  const used = briefs.filter((b) => b.ok).map((b) => b.provider);
  if (!used.length) {
    return `モード: ${
      intent === "mixed" ? "数値+戦略" : "戦略"
    }（外部AIキー未設定または取得失敗のため gpt-5.6-luna のみ）`;
  }
  return `モード: ${
    intent === "mixed" ? "数値+戦略" : "戦略"
  }（gpt-5.6-luna + ${used.join(" + ")}）`;
}
