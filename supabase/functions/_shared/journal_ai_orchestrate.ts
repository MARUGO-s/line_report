/**
 * Journal Report AI チャット用の意図分類と外部AI（Perplexity / Grok）連携。
 * 数値正本は常に OpenAI gpt-5.6-luna + 保存済みレポート側。戦略・対策系だけ外部知見を足す。
 */

export type JournalChatIntent = "data" | "strategy" | "mixed";

export type ExternalBrief = {
  provider: "perplexity" | "grok";
  ok: boolean;
  text: string;
  error?: string;
};

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
    return { provider: "perplexity", ok: false, text: "", error: "missing_key" };
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
    const text = truncate(String(json?.choices?.[0]?.message?.content || ""), 2400);
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

/** Grok (xAI) で X / 外食トレンドの短い補助見解を取得 */
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
  const model = String(Deno.env.get("JOURNAL_GROK_MODEL") || Deno.env.get("FOODCOURT_GROK_MODEL") || "")
    .trim() || "grok-3-mini";
  const timeoutMs = Number(Deno.env.get("GROK_TIMEOUT_MS") || 12000) || 12000;
  const userPrompt =
    `マルゴグループ（ワイン推しの飲食店グループ）向けに、X（Twitter）や外食・ワイン周りの近時トレンドで、次の質問の対策に使えそうな示唆を日本語で200〜400字にまとめてください。店舗固有の売上数値は作らないでください。\n\n前提: ${companyHint}\n質問: ${question}`;
  try {
    const res = await fetchWithTimeout(
      "https://api.x.ai/v1/chat/completions",
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
                "You are a trend scout for a wine-focused restaurant group in Japan. Reply in Japanese. No fabricated store metrics.",
            },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 700,
          temperature: 0.4,
        }),
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
    const json = await res.json().catch(() => null) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const text = truncate(String(json?.choices?.[0]?.message?.content || ""), 1600);
    return {
      provider: "grok",
      ok: !!text,
      text,
      error: text ? undefined : "empty_content",
    };
  } catch (e) {
    console.error("Grok fetch failed:", e);
    return {
      provider: "grok",
      ok: false,
      text: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 戦略／混合モード用に外部ブリーフを並列取得（キーが無い provider はスキップ） */
export async function gatherExternalBriefs(
  question: string,
  companyHint: string,
  intent: JournalChatIntent,
): Promise<ExternalBrief[]> {
  if (intent === "data") return [];
  const tasks: Promise<ExternalBrief>[] = [callPerplexityBrief(question, companyHint)];
  // 戦略・混合では Grok も試す（キー無ければ missing_key で終わる）
  tasks.push(callGrokTrendBrief(question, companyHint));
  return await Promise.all(tasks);
}

export function formatExternalBriefsForPrompt(briefs: ExternalBrief[]): string {
  const ok = briefs.filter((b) => b.ok && b.text);
  if (!ok.length) return "";
  const blocks = ok.map((b) => {
    const label = b.provider === "perplexity"
      ? "Perplexity（Web検索）"
      : "Grok（トレンド補助）";
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
    return `モード: ${intent === "mixed" ? "数値+戦略" : "戦略"}（外部AIキー未設定または取得失敗のため gpt-5.6-luna のみ）`;
  }
  return `モード: ${intent === "mixed" ? "数値+戦略" : "戦略"}（gpt-5.6-luna + ${used.join(" + ")}）`;
}
