// Supabase Edge Function: AI Analyze / Chat
// 数値検証は Kimi。戦略・対策系は Perplexity / Grok を自動オーケストレーションしてから Kimi が統合。
// deploy retry marker: supabase API 502 recovery

import {
  formatExternalBriefsForPrompt,
  gatherExternalBriefs,
  normalizeJournalChatIntent,
  orchestrationNote,
  type JournalChatIntent,
} from "../_shared/journal_ai_orchestrate.ts";

const KIMI_MODEL_DEFAULT = "kimi-k3";
const KIMI_ENDPOINT = "https://api.moonshot.ai/v1/chat/completions";

/** マルゴグループ（株式会社ワルツ）専用の分析前提。一般飲食/Barの定石ではなく、ワイン推し企業として解釈する。 */
const MARUGO_COMPANY_CONTEXT = `【分析対象企業の前提（必須・常に適用）】
あなたは「マルゴグループ（MARUGO GROUP）」専用の店舗売上アナリスト兼ワインバー／ワインビストロ経営アドバイザーです。運営会社は株式会社ワルツ。
会社情報の正本: https://05-marugo-group.com
店舗・業態の詳細: https://marugo-s.com/

グループの立ち位置（根底に置くこと）:
- 単なる一般飲食店や普通のBarではない。「気軽にワインを楽しめる」ことを核にした、ワイン推し・ワイン充実が強みの会社である。
- 新宿三丁目を中心に、四谷・新橋・丸の内・愛知県刈谷市など約25店舗を展開（2026年1月時点）。
- グラスワインの品揃え、ワインと料理のペアリング、ワイン業者を中心とした約70社のパートナーシップ、近隣店舗間の情報・人材・食材・顧客共有が競争優位。
- 業態はワインバー、ワイン&イタリアン、ピッツェリア、ビストロ、スペインバル、フードホール、焼肉、鮨、蕎麦、たこ焼きなど多様だが、グループ横断の共通軸は「ワイン」。分析もこの軸で行う。
- 店舗ごとの個性（データ上の店舗名・商品構成・客単価帯）を読み取り、その店舗コンセプトに沿ったワイン活用を提案する。寿司・蕎麦・たこ焼き等でも「グループのワイン強みをどう活かすか」を視野に入れる（無理な一般論や他業種の定石の押し付けは禁止）。

分析・アドバイスの優先視点:
1. ドリンク（特にワイン）比率・グラス／ボトル構成・ワイン単品の売れ筋
2. フード×ワインのペアリング・クロスセルによる客単価向上
3. 閑散帯でもワイン提案で単価を守る／伸ばす施策
4. グループ内送客・エリア内回遊（新宿三丁目密集の利点）
5. 提供データに無い原価・在庫・利益は捏造しない`;

const SYSTEM_PROMPT_ANALYZE = `${MARUGO_COMPANY_CONTEXT}

与えられた売上データ・顧客データ・メニューデータに基づき、経営陣や店長がそのまま店舗の改善・売上倍増のための戦略資料として活用できる「マルゴグループ店舗経営・売上多角分析＆ワイン営業戦略レポート」を作成してください。

【レポート構成と必須フォーマット】
以下の章立てで、Markdown形式で詳細かつ論理的に記述してください。単なる数値の報告に留まらず、ワイン推し企業としての多角的視点、店舗の弱点・ボトルネックの厳密な抽出、現場で即実践できる具体策まで深掘りしてください。一般的な居酒屋・チェーン飲食のテンプレ施策ではなく、マルゴグループらしいワイン提案に落とし込んでください。

# 📊 マルゴグループ 店舗経営・売上多角分析＆ワイン営業戦略レポート

## 1. エグゼクティブ・サマリー（全体総括）
- 該当期間の売上成果の要約（総売上、客数、客単価）
- ワインバー／ワインビストロ企業としての現状評価（ワイン・ドリンク訴求の強みと課題）

## 2. 多角的なデータ分析（ワイン軸を含む）
- **客単価・客数構造分析**: ランチ／ディナーの単価差、客数依存度と単価依存度、ワイン提案余地
- **時間軸・曜日別傾向分析**: ピーク曜日と閑散曜日のギャップ、営業効率
- **商品・カテゴリ構造分析**: フード vs ドリンク（ワイン含む）比率、上位商品の集中度、ワイン／飲料の売れ筋

## 3. 店舗の「弱点」と「ボトルネック（取りこぼし）」の抽出 ⚠️
- **売上・客数のボトルネック**: 閑散日・時間帯の落込み
- **収益性の弱点**: ドリンク／ワイン注文率、フードに対する飲料比率、低単価偏り、グラス止まりでボトルへ繋がっていない可能性
- **リスク分析**: 特定曜日や一部主要商品への依存

## 4. 売上・利益最大化のための具体的営業アドバイス＆アクションプラン 💡
- **【即効・ワイン営業アドバイス（明日からできる施策）】**
  - 客単価＋300〜500円を狙うグラスワイン追加提案、ペアリング一言提案、ボトルアップセル
  - 食前／食中のワイン導線、日替わりグラスの推奨トーク
- **【メニュー・価格・ペアリング戦略】**
  - 高利益・売れ筋ワインの露出、フード主力との組み合わせ提案
  - ランチ客のディナー／ワイン再来店送客
- **【集客・グループ連携オペレーション】**
  - 閑散曜日のワイン企画・予約誘導
  - 新宿三丁目など近隣姉妹店への送客・回遊の活用

---
【執筆時の注意点】
- 丁寧で説得力のあるビジネス日本語を使用してください。
- 抽象的な表現を避け、提供されたデータ内の具体数値（売上金額、人数、単価、構成比％、点数）を豊富に引用し、数値的根拠を持って論述してください。
- 「一般的なBar／居酒屋なら…」ではなく、「マルゴグループのワイン強みを前提にすると…」という語り口で書いてください。`;

const SYSTEM_PROMPT_CHAT = `${MARUGO_COMPANY_CONTEXT}

あなたはマルゴグループ各店舗の売上データ分析アシスタントです。営業・売上に関するあらゆる種類の質問（実績照会、期間比較、トレンド、客単価、商品構成、ワイン／ドリンク比率、原因分析、改善提案、今後の見通しなど）に幅広く対応してください。
- 数値（金額・件数・客数・比率など）は、必ず提供された売上データのみから具体的に回答してください。数値についての推測・一般論での代用は禁止です。計算が必要な場合は計算過程も簡潔に示してください。
- 一方、原因分析・傾向の解釈・改善提案・今後の見通しなど、データから直接は読み取れない考察を求められた場合は、拒否せず、マルゴグループ（ワイン推し・ワイン充実）および各店舗業態の知見に基づいた見解を述べて構いません。一般飲食の汎用アドバイスに逃げず、ワイン提案・ペアリング・ドリンク構成・グループ連携を優先してください。ただしその部分は必ず「※これは推測です」等の文言を付け、データに基づく事実と明確に区別してください。
- 外部知見ブリーフが付与されている場合のみ、Web／トレンド知見を施策提案に使ってよい。その箇所は「※これは外部知見です」と明示し、店舗数値と混同しないこと。
- データにない情報は「このデータからは判断できません」と回答してください。
- 回答は丁寧な日本語で`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

type ChatContent = { role: string; parts: { text: string }[] };

function contentsToOpenAiMessages(contents: ChatContent[]) {
  return contents.map((c) => ({
    role: c.role === "model" ? "assistant" : "user",
    content: c.parts.map((p) => p.text).join("\n"),
  }));
}

function stripThinkingBlocks(text: string): string {
  let s = String(text ?? "");
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  const lastClose = s.toLowerCase().lastIndexOf("</think>");
  if (lastClose >= 0) s = s.slice(lastClose + "</think>".length);
  const openIdx = s.toLowerCase().indexOf("<think>");
  if (openIdx >= 0) {
    const after = s.slice(openIdx + "<think>".length);
    const markers = ["【総評】", "## ", "### ", "# ", "回答:", "結論:"];
    let cut = -1;
    for (const m of markers) {
      const i = after.indexOf(m);
      if (i >= 0 && (cut < 0 || i < cut)) cut = i;
    }
    s = cut >= 0 ? after.slice(cut) : s.slice(0, openIdx);
  }
  return s.trim();
}

async function callKimi(
  contents: ChatContent[],
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const apiKey = Deno.env.get("MOONSHOT_API_KEY") || Deno.env.get("KIMI_API_KEY");
  if (!apiKey) return { ok: false, error: "MOONSHOT_API_KEY not configured" };
  const model = Deno.env.get("KIMI_MODEL") || KIMI_MODEL_DEFAULT;

  try {
    const res = await fetch(KIMI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: contentsToOpenAiMessages(contents),
        temperature: 1,
        reasoning_effort: "low",
        max_tokens: 10192,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("Kimi API error:", res.status, errText);
      return { ok: false, error: errText };
    }
    const data = await res.json();
    const rawText = data?.choices?.[0]?.message?.content || "";
    const text = stripThinkingBlocks(rawText);
    if (!text) return { ok: false, error: "Kimi returned an empty response" };
    return { ok: true, text };
  } catch (e) {
    console.error("Kimi API fetch error:", e);
    return { ok: false, error: String(e) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!Deno.env.get("MOONSHOT_API_KEY") && !Deno.env.get("KIMI_API_KEY")) {
    return new Response(
      JSON.stringify({ error: "MOONSHOT_API_KEY が未設定です" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const body = await req.json();
    const {
      action,
      salesData,
      message,
      chatHistory,
      systemInstruction,
      orchestrationMode,
      intent: intentOverride,
    } = body;

    if (!action || !salesData) {
      return new Response(
        JSON.stringify({ error: "action and salesData are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const salesContext = typeof salesData === "string"
      ? salesData
      : JSON.stringify(salesData);

    if (salesContext.length > 100000) {
      return new Response(
        JSON.stringify({ error: "データが大きすぎます。期間を絞ってください。" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    let contents: ChatContent[];
    let intent: JournalChatIntent = "data";
    let briefs: Awaited<ReturnType<typeof gatherExternalBriefs>> = [];

    if (action === "analyze") {
      // 一括分析レポートは従来どおり Kimi のみ（コスト・レイテンシ優先）
      contents = [
        {
          role: "user",
          parts: [
            {
              text: `${systemInstruction || SYSTEM_PROMPT_ANALYZE}\n\n以下の売上データを分析してください：\n\n${salesContext}`,
            },
          ],
        },
      ];
    } else if (action === "chat") {
      if (!message) {
        return new Response(
          JSON.stringify({ error: "message is required for chat" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      intent = normalizeJournalChatIntent(
        intentOverride ?? orchestrationMode,
        String(message),
      );

      if (intent === "strategy" || intent === "mixed") {
        briefs = await gatherExternalBriefs(
          String(message),
          "MARUGO GROUP / https://05-marugo-group.com / wine-focused restaurants",
          intent,
        );
      }

      const externalBlock = formatExternalBriefsForPrompt(briefs);
      const history = chatHistory || [];
      contents = [
        {
          role: "user",
          parts: [
            {
              text:
                `${systemInstruction || SYSTEM_PROMPT_CHAT}\n\n参照する売上データ：\n${salesContext}${externalBlock}`,
            },
          ],
        },
        {
          role: "model",
          parts: [
            {
              text: "売上データを確認しました。ご質問をどうぞ。",
            },
          ],
        },
        ...history
          .map((h: { role: string; content?: string; text?: string }) => ({
            role: h.role === "user" ? "user" : "model",
            parts: [{ text: String(h.content ?? h.text ?? "").trim() }],
          }))
          .filter((h: { parts: { text: string }[] }) =>
            h.parts[0].text.length > 0
          ),
        {
          role: "user",
          parts: [{ text: message }],
        },
      ];
    } else {
      return new Response(
        JSON.stringify({ error: "action must be 'analyze' or 'chat'" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const kimiResult = await callKimi(contents);

    if (kimiResult.ok) {
      const note = action === "chat"
        ? orchestrationNote(intent, briefs)
        : "モード: 分析レポート（Kimi）";
      const providers = ["kimi", ...briefs.filter((b) => b.ok).map((b) => b.provider)];
      return new Response(
        JSON.stringify({
          text: kimiResult.text,
          provider: providers.length > 1 ? "orchestrated" : "kimi",
          providers,
          mode: action === "chat" ? intent : "analyze",
          note,
          orchestration: briefs.map((b) => ({
            provider: b.provider,
            ok: b.ok,
            error: b.error || null,
          })),
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    let friendlyError = "Kimi (Moonshot AI) の呼び出しに失敗しました。";
    if (
      kimiResult.error.includes("401") ||
      kimiResult.error.toLowerCase().includes("invalid")
    ) {
      friendlyError =
        "KimiのAPIキーが無効です。SupabaseのMOONSHOT_API_KEYをご確認ください。";
    } else if (kimiResult.error.includes("429")) {
      friendlyError = "Kimi APIの利用クォータ上限に達しました。";
    }
    return new Response(
      JSON.stringify({
        error: friendlyError,
        detail: kimiResult.error,
        mode: action === "chat" ? intent : "analyze",
        orchestration: briefs.map((b) => ({
          provider: b.provider,
          ok: b.ok,
          error: b.error || null,
        })),
      }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("Edge Function error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: String(e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

