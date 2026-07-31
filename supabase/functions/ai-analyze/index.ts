// Supabase Edge Function: AI Analyze / Chat
// Kimi (Moonshot AI, K3) を使用して売上データの分析・チャットを行うプロキシ

const KIMI_MODEL_DEFAULT = "kimi-k3";
const KIMI_ENDPOINT = "https://api.moonshot.ai/v1/chat/completions";

const SYSTEM_PROMPT_ANALYZE = `あなたは飲食店・レストランの売上分析と店舗経営コンサルティングの最高責任者（プロアナリスト）です。
与えられた売上データ・顧客データ・メニューデータに基づき、経営陣や店長がそのまま店舗の改善・売上倍増のための戦略資料として活用できる「店舗経営・売上多角分析＆営業戦略レポート」を作成してください。

【レポート構成と必須フォーマット】
以下の章立てで、Markdown形式で詳細かつ論理的に記述してください。単なる数値の報告に留まらず、多角的な視点、店舗の弱点・ボトルネックの厳密な抽出、そして現場で即実践できる具体策まで深掘りしてください。

# 📊 店舗経営・売上多角分析＆営業戦略レポート

## 1. エグゼクティブ・サマリー（全体総括）
- 該当期間の売上成果の要約（総売上、客数、客単価）
- 店舗の現状に対する総合評価（店舗の強みと課題の全体像）

## 2. 多角的なデータ分析（多面的アプローチ）
- **客単価・客数構造分析**: ランチ客単価とディナー客単価の比較、客数依存度と単価依存度のバランス
- **時間軸・曜日別傾向分析**: ピーク曜日と閑散曜日のギャップ、営業効率の評価
- **商品・カテゴリ構造分析**: フード比率 vs 飲料比率の収益性バランス、上位商品の集中度

## 3. 店舗の「弱点」と「ボトルネック（取りこぼし）」の抽出 ⚠️
- **売上・客数のボトルネック**: 営業機会の損失が発生している曜日・時間帯（閑散日の落込みなど）
- **収益性の弱点**: 飲料の注文率、フードに対するドリンク比率の課題、低単価への偏り
- **リスク分析**: 特定曜日や一部の主要商品への依存リスク

## 4. 売上・利益最大化のための具体的一営業アドバイス＆アクションプラン 💡
- **【即効営業アドバイス（明日からできる施策）】**
  - 客単価を＋300円〜500円引き上げるための接客・クロスセル（ドリンクのおかわり・セット提案）
  - チャージやスピードメニューの活用による初期単価の向上
- **【メニュー・価格戦略アドバイス】**
  - 高利益率メニューの露出強化、メニューブックのレイアウト最適化
  - ランチ客のディナー送客・ペアリング提案
- **【集客・営業オペレーションアドバイス】**
  - 閑散曜日の集客テコ入れ策（曜日限定の特別提案や予約誘導）
  - 団体・グループ客の獲得とリピート率向上策

---
【執筆時の注意点】
- 丁寧で説得力のあるビジネス日本語（「〜が店舗の課題として顕著です」「〜の施策を推奨します」など）を使用してください。
- 抽象的な表現を避け、提供されたデータ内の具体数値（売上金額、人数、単価、構成比％、点数）を豊富に引用し、数値的根拠を持って論述してください。`;

const SYSTEM_PROMPT_CHAT = `あなたは飲食店の売上データ分析アシスタントです。
ユーザーから提供された売上データをもとに、質問に正確に回答してください。
- 数値は具体的に回答
- 計算が必要な場合は計算過程も簡潔に示す
- データにない情報は「このデータからは判断できません」と回答
- 回答は丁寧な日本語で`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

type ChatContent = { role: string; parts: { text: string }[] };

/** role/parts形式をOpenAI互換のmessages（role/content）へ変換 */
function contentsToOpenAiMessages(contents: ChatContent[]) {
  return contents.map((c) => ({
    role: c.role === "model" ? "assistant" : "user",
    content: c.parts.map((p) => p.text).join("\n"),
  }));
}

/** Kimi K3等の推論モデルが出力に含める<think>...</think>ブロックを除去する（foodcourt_loop_utils.tsの実装を移植） */
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
  contents: ChatContent[]
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
        // Kimi K3 は temperature=1 のみ許可
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
  // CORS preflight
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
      }
    );
  }

  try {
    const body = await req.json();
    const { action, salesData, message, chatHistory, systemInstruction } = body;

    if (!action || !salesData) {
      return new Response(
        JSON.stringify({ error: "action and salesData are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 売上データをテキスト化（トークン節約のため要約形式）
    const salesContext = typeof salesData === "string"
      ? salesData
      : JSON.stringify(salesData);

    // トークン上限チェック（約100KB = 概算25Kトークンに制限）
    if (salesContext.length > 100000) {
      return new Response(
        JSON.stringify({ error: "データが大きすぎます。期間を絞ってください。" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let contents: ChatContent[];

    if (action === "analyze") {
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
          }
        );
      }
      // チャット履歴を構築（クライアントは各項目を {role, content} で送る。
      // 後方互換のため text も見る）
      const history = chatHistory || [];
      contents = [
        {
          role: "user",
          parts: [
            {
              text: `${systemInstruction || SYSTEM_PROMPT_CHAT}\n\n参照する売上データ：\n${salesContext}`,
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
          .filter((h: { parts: { text: string }[] }) => h.parts[0].text.length > 0),
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
        }
      );
    }

    const kimiResult = await callKimi(contents);

    if (kimiResult.ok) {
      return new Response(
        JSON.stringify({ text: kimiResult.text, provider: "kimi" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let friendlyError = "Kimi (Moonshot AI) の呼び出しに失敗しました。";
    if (kimiResult.error.includes("401") || kimiResult.error.toLowerCase().includes("invalid")) {
      friendlyError = "KimiのAPIキーが無効です。SupabaseのMOONSHOT_API_KEYをご確認ください。";
    } else if (kimiResult.error.includes("429")) {
      friendlyError = "Kimi APIの利用クォータ上限に達しました。";
    }
    return new Response(
      JSON.stringify({
        error: friendlyError,
        detail: kimiResult.error,
      }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("Edge Function error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: String(e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
