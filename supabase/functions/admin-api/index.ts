import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-store-key, x-admin-token, x-admin-surface",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-2.5-flash"];

function normalizeStoreKey(rawKey: string | null): string {
  if (!rawKey) return "";
  return rawKey.trim();
}

function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** Uint8Array を Base64 文字列へ変換 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** テキストを RAG 用のチャンク配列に自動分割する (約 1,500 文字単位・文脈保持に最適化) */
function splitTextIntoChunks(fullText: string, chunkSize = 1500, overlap = 200): string[] {
  const text = fullText.trim();
  if (!text) return [];
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + chunkSize;
    if (end < text.length) {
      const paragraphBreak = text.lastIndexOf("\n\n", end);
      const lineBreak = text.lastIndexOf("\n", end);
      const sentenceBreak = text.lastIndexOf("。", end);
      
      const bestBreak = Math.max(
        paragraphBreak > start + 500 ? paragraphBreak : -1,
        lineBreak > start + 500 ? lineBreak : -1,
        sentenceBreak > start + 500 ? sentenceBreak : -1
      );

      if (bestBreak > start + 300) {
        end = bestBreak + 1;
      }
    } else {
      end = text.length;
    }
    const chunk = text.substring(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end - overlap;
    if (start >= text.length - overlap) break;
  }
  return chunks;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY") || "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    function isMonthlyReportTitle(title?: string): boolean {
      if (!title) return false;
      return /月次|月別|月間|全体売上|\d{4}年\d{1,2}月/.test(title);
    }

    // ==========================================
    // 1. Saved POS Reports (/pos-journals/saved-reports)
    // ==========================================
    if (path.includes("/pos-journals/saved-reports")) {
      const isItem = path.endsWith("/saved-reports/item");

      // A. GET /pos-journals/saved-reports (一覧取得: サマリー軽量化で高速・完結化)
      if (req.method === "GET" && !isItem) {
        const storeKey = normalizeStoreKey(url.searchParams.get("store_key") || req.headers.get("x-store-key"));
        const kind = url.searchParams.get("kind");
        const limitParam = parseInt(url.searchParams.get("limit") || "500", 10);

        let query = supabase.from("saved_reports").select("id, title, period, created_at, updated_at").order("created_at", { ascending: false }).limit(limitParam);

        const { data, error } = await query;
        if (error) throw error;

        let reports = (data || []).map((row: any) => {
          return {
            id: row.id,
            title: row.title || "売上レポート",
            period: row.period || "",
            created_at: row.created_at,
            store_partition_key: storeKey
          };
        });

        if (storeKey) {
          reports = reports.filter((r: any) => !r.store_partition_key || r.store_partition_key === storeKey);
        }

        if (kind === "monthly") {
          reports = reports.filter((r: any) => isMonthlyReportTitle(r.title));
        } else if (kind === "daily") {
          reports = reports.filter((r: any) => !isMonthlyReportTitle(r.title));
        }

        return new Response(JSON.stringify({ reports, items: reports }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // B. GET /pos-journals/saved-reports/item (単一詳細取得)
      if (req.method === "GET" && isItem) {
        const id = url.searchParams.get("id");
        if (!id) {
          return new Response(JSON.stringify({ error: "Missing id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const { data, error } = await supabase.from("saved_reports").select("*").eq("id", id).single();
        if (error) throw error;

        let report = data;
        if (data?.data && typeof data.data === "object") {
          report = { id: data.id, title: data.title, period: data.period, created_at: data.created_at, ...data.data };
        }

        return new Response(JSON.stringify({ report, item: report }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // C. POST /pos-journals/saved-reports (保存・更新)
      if (req.method === "POST" && !isItem) {
        const body = await req.json();
        const records = Array.isArray(body) ? body : (body.reports || body.items || [body]);
        const storeKey = normalizeStoreKey(body.store_key || body.store_partition_key || req.headers.get("x-store-key"));

        const upsertRows = records.map((rec: any) => {
          const recId = String(rec.id || rec.report_id || `rep_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
          const title = rec.title || rec.report_title || "売上レポート";
          const period = rec.period || rec.period_label || "";
          const payload = { ...rec, store_partition_key: rec.store_partition_key || storeKey };
          return {
            id: recId,
            title: title,
            period: period,
            data: payload,
            updated_at: new Date().toISOString()
          };
        });

        const { data, error } = await supabase.from("saved_reports").upsert(upsertRows).select();
        if (error) throw error;

        return new Response(JSON.stringify({ success: true, count: data?.length || 0 }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // D. DELETE /pos-journals/saved-reports/item (削除)
      if (req.method === "DELETE" && isItem) {
        const id = url.searchParams.get("id");
        if (!id) {
          return new Response(JSON.stringify({ error: "Missing id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const { error } = await supabase.from("saved_reports").delete().eq("id", id);
        if (error) throw error;
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ==========================================
    // 2. AI Chat PDF History (/pos-journals/chat-pdf-history)
    // ==========================================
    if (path.includes("/pos-journals/chat-pdf-history")) {
      const isItem = path.endsWith("/chat-pdf-history/item");

      // A. POST /pos-journals/chat-pdf-history (PDF保存)
      if (req.method === "POST" && !isItem) {
        const body = await req.json();
        const storeKey = normalizeStoreKey(body.store_key || req.headers.get("x-store-key"));
        const id = String(body.id || `pdf_${Date.now()}`);
        const question = String(body.question || "").trim();
        const answer = String(body.answer || "").trim();

        if (!storeKey || !answer) {
          return new Response(JSON.stringify({ error: "Missing store_key or answer" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const reportId = `pdf_hist_${id}`;
        const payload = {
          id,
          type: "chat_pdf_history",
          store_partition_key: storeKey,
          question,
          answer,
          mode: body.mode || "",
          provider: body.provider || "",
          created_at: new Date().toISOString()
        };

        const { error } = await supabase.from("saved_reports").upsert({
          id: reportId,
          title: question ? `[PDF履歴] ${question.substring(0, 50)}` : "AIチャットPDF履歴",
          period: "AIチャット",
          data: payload,
          updated_at: new Date().toISOString()
        });

        if (error) throw error;

        return new Response(JSON.stringify({ success: true, id }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // B. GET /pos-journals/chat-pdf-history (一覧取得)
      if (req.method === "GET" && !isItem) {
        const storeKey = normalizeStoreKey(url.searchParams.get("store_key") || req.headers.get("x-store-key"));
        const limitParam = parseInt(url.searchParams.get("limit") || "100", 10);

        const { data, error } = await supabase.from("saved_reports").select("*").order("created_at", { ascending: false }).limit(limitParam);
        if (error) throw error;

        const items = (data || []).filter((row: any) => {
          const rowData = row.data && typeof row.data === "object" ? row.data : {};
          return rowData.type === "chat_pdf_history" && (!storeKey || rowData.store_partition_key === storeKey || !rowData.store_partition_key);
        }).map((row: any) => {
          return {
            id: row.data?.id || row.id,
            question: row.data?.question || row.title,
            answer: row.data?.answer || "",
            createdAt: row.created_at,
            mode: row.data?.mode || "",
            provider: row.data?.provider || ""
          };
        });

        return new Response(JSON.stringify({ items }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // C. DELETE /pos-journals/chat-pdf-history/item (削除)
      if (req.method === "DELETE" && isItem) {
        let storeKey = normalizeStoreKey(url.searchParams.get("store_key") || req.headers.get("x-store-key"));
        let id = url.searchParams.get("id");
        if (!id) {
          try {
            const body = await req.json();
            if (body.id) id = String(body.id);
          } catch (_) {}
        }
        if (id) {
          await supabase.from("saved_reports").delete().eq("id", `pdf_hist_${id}`);
          await supabase.from("saved_reports").delete().eq("id", id);
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (path.includes("/pos-journals/knowledge")) {
      const isItem = path.endsWith("/knowledge/item");
      const isUpload = path.endsWith("/knowledge/upload");
      const isDownload = path.endsWith("/knowledge/download");
      const isProcess = path.endsWith("/knowledge/process");
      const isInsight = path.endsWith("/knowledge/generate-insight");
      const isAnalyzeImage = path.endsWith("/knowledge/analyze-image");
      const isProcessLinePost = path.endsWith("/knowledge/process-line-post");

      // 1. Process LINE #メモ Post (POST /pos-journals/knowledge/process-line-post) - NEW
      if (req.method === "POST" && isProcessLinePost) {
        const body = await req.json();
        const rawText = String(body.text || "").trim();
        const storeKey = normalizeStoreKey(body.store_key || body.store_partition_key || req.headers.get("x-store-key"));
        const senderName = body.sender_name || "LINEスタッフ";

        if (!storeKey || !rawText) {
          return new Response(JSON.stringify({ error: "Missing store_key or text" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // ① 100% プログラム判定: #メモ / #日報 / #note が含まれているかチェック
        const tagMatch = rawText.match(/#(?:メモ|日報|note)/i);
        if (!tagMatch) {
          // タグが含まれていない場合は即時スルー（AIコスト0円）
          return new Response(JSON.stringify({ processed: false, reason: "No #メモ tag found. Skipped." }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // #メモ タグを取り除いた本文
        const cleanText = rawText.replace(/#(?:メモ|日報|note)/gi, "").trim();
        if (!cleanText) {
          return new Response(JSON.stringify({ processed: false, reason: "Empty text after tag removal" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // ② Gemini 2.0 Flash によるカテゴリ・タイトル・タグの自動識別
        let categorizedResult = {
          title: cleanText.substring(0, 15),
          category: "その他",
          summary: cleanText.substring(0, 150),
          body_text: cleanText,
          tags: ["LINE投稿", "現場メモ"],
        };

        if (geminiApiKey) {
          const promptText = `あなたは飲食店の現場LINE投稿を解読・整理するプロアナリストAIです。
以下のLINE投稿（投稿者: ${senderName}）を解析し、カテゴリー分類・タイトル生成・要約・タグ付けを行ってください。

【投稿文】
${cleanText}

【分類ルール】
- category: 以下から最も適切なものを1つだけ選択してください。
  ('施策', 'メニュー', '価格改定', 'イベント', 'マニュアル', 'その他')
  ※「天候」「売れ筋」「客足」「本日の出来事」「所感」に関する内容は 'その他'（タグに '現場日報' が付きます）
  ※「近隣他店」「競合」「周辺フェア」に関する内容は 'イベント' または 'その他'（タグに '周辺情報' が付きます）
  ※「新メニュー」「ワイン」「料理」「価格」に関する内容は 'メニュー' または '価格改定'

【出力フォーマット】
以下のJSONフォーマット**のみ**を出力してください（Markdownのコードブロック \`\`\`json ... \`\`\` で囲んでください）：

{
  "title": "15文字前後のわかりやすいタイトル（例: 大雨時の赤ワイン煮込み出足好調、近隣店ワインフェア開始など）",
  "category": "選択したカテゴリー",
  "summary": "1〜3行の簡潔な要約",
  "body_text": "原文テキスト",
  "tags": ["タグ1", "タグ2", "タグ3"]
}`;

          const payload = {
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            generationConfig: { temperature: 0.2 },
          };

          for (const model of GEMINI_MODELS) {
            try {
              const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
              const res = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });

              if (res.ok) {
                const resJson = await res.json();
                const aiText = resJson.candidates?.[0]?.content?.parts?.[0]?.text || "";
                if (aiText) {
                  const jsonMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, aiText];
                  const parsed = JSON.parse((jsonMatch[1] || aiText).trim());
                  categorizedResult = {
                    title: parsed.title || categorizedResult.title,
                    category: parsed.category || categorizedResult.category,
                    summary: parsed.summary || categorizedResult.summary,
                    body_text: cleanText,
                    tags: Array.isArray(parsed.tags) ? ["LINE投稿", ...parsed.tags] : categorizedResult.tags,
                  };
                  break;
                }
              }
            } catch (e) {
              console.warn(`Model ${model} failed for LINE post categorization:`, e);
            }
          }
        }

        const validCategories = ["施策", "メニュー", "価格改定", "イベント", "マニュアル", "その他"];
        const rawCategory = String(categorizedResult.category || "その他").trim();
        const safeCategory = validCategories.includes(rawCategory) ? rawCategory : "その他";
        const extraTag = validCategories.includes(rawCategory) ? "" : rawCategory;

        const finalTags = ["LINE投稿"];
        if (extraTag && extraTag !== "その他") finalTags.push(extraTag);
        if (Array.isArray(categorizedResult.tags)) {
          categorizedResult.tags.forEach((t: string) => { if (!finalTags.includes(t)) finalTags.push(t); });
        }

        const searchText = normalizeSearchText(
          `${categorizedResult.title} ${categorizedResult.summary} ${cleanText} ${finalTags.join(" ")}`
        );

        let record: Record<string, any> = {
          store_partition_key: storeKey,
          category: safeCategory,
          title: String(categorizedResult.title || "LINEメモ").trim(),
          summary: String(categorizedResult.summary || cleanText).trim(),
          body_text: cleanText,
          search_text: searchText,
          tags: finalTags,
          source_type: "manual",
          created_by: senderName,
          is_active: true,
        };

        let docData, docError;
        ({ data: docData, error: docError } = await supabase
          .from("store_knowledge_documents")
          .insert(record)
          .select()
          .single());

        if (docError && docError.message?.includes("source_type")) {
          record.source_type = "manual";
          ({ data: docData, error: docError } = await supabase
            .from("store_knowledge_documents")
            .insert(record)
            .select()
            .single());
        }

        if (docError) throw docError;

        // ④ 1,500文字の RAG チャンクへ全自動変換
        const chunkTexts = splitTextIntoChunks(`${categorizedResult.summary}\n\n${cleanText}`);
        if (chunkTexts.length > 0) {
          const chunkRecords = chunkTexts.map((text, idx) => ({
            document_id: docData.id,
            store_partition_key: storeKey,
            chunk_index: idx,
            chunk_text: text,
            search_text: normalizeSearchText(text),
            token_count: text.length,
          }));
          await supabase.from("store_knowledge_chunks").insert(chunkRecords);
        }

        return new Response(
          JSON.stringify({
            processed: true,
            item: docData,
            chunks_created: chunkTexts.length,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 2. Analyze Image with Gemini 2.0 Flash (POST /pos-journals/knowledge/analyze-image)
      if (req.method === "POST" && isAnalyzeImage) {
        if (!geminiApiKey) {
          return new Response(JSON.stringify({ error: "GEMINI_API_KEY is not configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const formData = await req.formData();
        const file = formData.get("file") as File;

        if (!file) {
          return new Response(JSON.stringify({ error: "Missing image file" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const arrayBuffer = await file.arrayBuffer();
        const base64Data = uint8ArrayToBase64(new Uint8Array(arrayBuffer));
        const mimeType = file.type || "image/jpeg";

        const promptText = `あなたは飲食店の店舗資料・メニュー分析プロAIです。
提供された画像（メニュー表、チラシ、イベント案内、価格改定、マニュアル等）を解析し、以下の項目を正確に抽出・構造化してください。

【出力フォーマット】
以下のJSONフォーマット**のみ**を出力してください（Markdownのコードブロック \`\`\`json ... \`\`\` で囲んでください）：

{
  "title": "ドキュメント・メニューのタイトル（例: 7月夏限定メニュー、価格改定のお知らせなど）",
  "category": "施策 / メニュー / 価格改定 / イベント / マニュアル / その他 から最も適切なものを1つ選択",
  "summary": "AIが最初に参照するための1〜3行の簡潔な要約",
  "body_text": "画像から読み取った詳細テキスト（メニュー名、価格、説明、注意事項などを構造化して文字起こし）",
  "tags": ["関連タグ1", "関連タグ2", "関連タグ3"]
}`;

        const payload = {
          contents: [
            {
              role: "user",
              parts: [
                { text: promptText },
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: base64Data,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
          },
        };

        let geminiResponseText = "";
        let lastError = "";

        for (const model of GEMINI_MODELS) {
          try {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
            const res = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });

            if (res.ok) {
              const resJson = await res.json();
              geminiResponseText = resJson.candidates?.[0]?.content?.parts?.[0]?.text || "";
              if (geminiResponseText) break;
            } else {
              const errBody = await res.text();
              lastError = `Model ${model} failed (${res.status}): ${errBody}`;
              console.warn(lastError);
            }
          } catch (e: any) {
            lastError = `Model ${model} error: ${e.message}`;
            console.warn(lastError);
          }
        }

        if (!geminiResponseText) {
          throw new Error(lastError || "Failed to analyze image with Gemini models");
        }

        let extractedData = {
          title: file.name.replace(/\.[^/.]+$/, ""),
          category: "メニュー",
          summary: "画像からテキストを抽出しました。",
          body_text: geminiResponseText,
          tags: ["画像解析", "メニュー"],
        };

        try {
          const jsonMatch = geminiResponseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, geminiResponseText];
          const parsed = JSON.parse((jsonMatch[1] || geminiResponseText).trim());
          extractedData = {
            title: parsed.title || extractedData.title,
            category: parsed.category || extractedData.category,
            summary: parsed.summary || extractedData.summary,
            body_text: parsed.body_text || extractedData.body_text,
            tags: Array.isArray(parsed.tags) ? parsed.tags : extractedData.tags,
          };
        } catch (_) {}

        return new Response(JSON.stringify({ success: true, result: extractedData }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 3. Upload Attachment (POST /pos-journals/knowledge/upload)
      if (req.method === "POST" && isUpload) {
        const formData = await req.formData();
        const file = formData.get("file") as File;
        const storeKey = normalizeStoreKey(formData.get("store_key") as string || req.headers.get("x-store-key"));

        if (!file || !storeKey) {
          return new Response(JSON.stringify({ error: "Missing file or store_key" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256Hex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

        const fileExt = file.name.split(".").pop();
        const filePath = `${storeKey}/${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExt}`;

        const { data: storageData, error: storageError } = await supabase.storage
          .from("store-knowledge")
          .upload(filePath, uint8Array, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
          });

        if (storageError) throw storageError;

        return new Response(
          JSON.stringify({
            storage_bucket: "store-knowledge",
            storage_path: storageData.path,
            original_file_name: file.name,
            mime_type: file.type,
            file_size_bytes: file.size,
            sha256_hex: sha256Hex,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 4. Process & Chunk Document (POST /pos-journals/knowledge/process)
      if (req.method === "POST" && isProcess) {
        const body = await req.json();
        const documentId = body.document_id;
        const storeKey = normalizeStoreKey(body.store_key || req.headers.get("x-store-key"));

        if (!documentId || !storeKey) {
          return new Response(JSON.stringify({ error: "Missing document_id or store_key" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data: doc, error: docErr } = await supabase
          .from("store_knowledge_documents")
          .select("*")
          .eq("id", documentId)
          .eq("store_partition_key", storeKey)
          .single();

        if (docErr || !doc) {
          return new Response(JSON.stringify({ error: "Document not found" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const fullText = [doc.summary, doc.body_text].filter(Boolean).join("\n\n");
        const chunkTexts = splitTextIntoChunks(fullText);

        await supabase
          .from("store_knowledge_chunks")
          .delete()
          .eq("document_id", documentId)
          .eq("store_partition_key", storeKey);

        const chunkRecords = chunkTexts.map((text, idx) => ({
          document_id: documentId,
          store_partition_key: storeKey,
          chunk_index: idx,
          chunk_text: text,
          search_text: normalizeSearchText(text),
          token_count: text.length,
        }));

        if (chunkRecords.length > 0) {
          const { error: chunkErr } = await supabase
            .from("store_knowledge_chunks")
            .insert(chunkRecords);
          if (chunkErr) console.error("Chunk insert error:", chunkErr);
        }

        return new Response(
          JSON.stringify({
            success: true,
            document_id: documentId,
            chunks_created: chunkRecords.length,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 5. Generate Effectiveness Insight (POST /pos-journals/knowledge/generate-insight)
      if (req.method === "POST" && isInsight) {
        const body = await req.json();
        const storeKey = normalizeStoreKey(body.store_key || req.headers.get("x-store-key"));
        const title = body.title || "施策効果測定レポート";
        const insightText = body.insight_text || "";
        const periodStart = body.period_start || null;
        const periodEnd = body.period_end || null;

        if (!storeKey || !insightText) {
          return new Response(JSON.stringify({ error: "Missing store_key or insight_text" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const searchText = normalizeSearchText(`${title} ${insightText} 効果測定 AIインサイト`);
        const record = {
          store_partition_key: storeKey,
          category: "施策",
          title: `【AI効果測定】${title}`,
          summary: insightText.substring(0, 150) + "…",
          body_text: insightText,
          search_text: searchText,
          period_start: periodStart,
          period_end: periodEnd,
          tags: ["効果測定", "AI分析", "自動追記"],
          source_type: "ai_insight",
          is_active: true,
        };

        const { data, error } = await supabase
          .from("store_knowledge_documents")
          .insert(record)
          .select()
          .single();

        if (error) throw error;

        return new Response(JSON.stringify({ success: true, item: data }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 6. Download Signed URL (GET /pos-journals/knowledge/download)
      if (req.method === "GET" && isDownload) {
        const storeKey = normalizeStoreKey(url.searchParams.get("store_key") || req.headers.get("x-store-key"));
        const storagePath = url.searchParams.get("path") || "";
        const id = url.searchParams.get("id");

        let targetPath = storagePath;
        if (!targetPath && id) {
          const { data: doc } = await supabase
            .from("store_knowledge_documents")
            .select("storage_path, store_partition_key")
            .eq("id", id)
            .single();
          if (doc) {
            if (storeKey && doc.store_partition_key !== storeKey) {
              return new Response(JSON.stringify({ error: "Forbidden: store mismatch" }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            targetPath = doc.storage_path || "";
          }
        }

        if (!targetPath) {
          return new Response(JSON.stringify({ error: "Target path not found" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data: signedData, error: signedError } = await supabase.storage
          .from("store-knowledge")
          .createSignedUrl(targetPath, 3600);

        if (signedError) throw signedError;

        return new Response(JSON.stringify({ url: signedData.signedUrl, signedUrl: signedData.signedUrl }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 7. Create or Update Knowledge (POST /pos-journals/knowledge)
      const isExactKnowledgePost = path.endsWith("/knowledge") || path.endsWith("/knowledge/");
      if (req.method === "POST" && isExactKnowledgePost) {
        const body = await req.json();
        const storeKey = normalizeStoreKey(body.store_partition_key || body.store_key || req.headers.get("x-store-key"));

        if (!storeKey || !body.title) {
          return new Response(JSON.stringify({ error: "Missing required fields (store_key, title)" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const tags = Array.isArray(body.tags) ? body.tags : [];
        const searchText = normalizeSearchText(
          `${body.title} ${body.summary || ""} ${body.body_text || ""} ${tags.join(" ")}`
        );

        const record: Record<string, any> = {
          store_partition_key: storeKey,
          category: body.category || "その他",
          title: body.title,
          summary: body.summary || "",
          body_text: body.body_text || "",
          search_text: searchText,
          period_start: body.period_start || null,
          period_end: body.period_end || null,
          tags: tags,
          storage_bucket: body.storage_bucket || "store-knowledge",
          storage_path: body.storage_path || null,
          original_file_name: body.original_file_name || null,
          mime_type: body.mime_type || null,
          file_size_bytes: body.file_size_bytes || null,
          sha256_hex: body.sha256_hex || null,
          source_type: body.source_type || "manual",
          is_active: body.is_active !== undefined ? body.is_active : true,
          updated_at: new Date().toISOString(),
        };

        let resultData, resultError;
        if (body.id) {
          const { data, error } = await supabase
            .from("store_knowledge_documents")
            .update(record)
            .eq("id", body.id)
            .select()
            .single();
          resultData = data;
          resultError = error;
        } else {
          const { data, error } = await supabase
            .from("store_knowledge_documents")
            .insert(record)
            .select()
            .single();
          resultData = data;
          resultError = error;
        }

        if (resultError) throw resultError;

        const fullText = [resultData.summary, resultData.body_text].filter(Boolean).join("\n\n");
        const chunkTexts = splitTextIntoChunks(fullText);
        if (chunkTexts.length > 0) {
          await supabase
            .from("store_knowledge_chunks")
            .delete()
            .eq("document_id", resultData.id)
            .eq("store_partition_key", storeKey);

          const chunkRecords = chunkTexts.map((text, idx) => ({
            document_id: resultData.id,
            store_partition_key: storeKey,
            chunk_index: idx,
            chunk_text: text,
            search_text: normalizeSearchText(text),
            token_count: text.length,
          }));
          await supabase.from("store_knowledge_chunks").insert(chunkRecords);
        }

        const item = {
          ...resultData,
          has_attachment: !!resultData.storage_path,
          chunk_count: chunkTexts.length,
        };

        return new Response(JSON.stringify({ item }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 8. Delete or Deactivate Knowledge (DELETE /pos-journals/knowledge/item)
      if (req.method === "DELETE" && isItem) {
        let storeKey = normalizeStoreKey(url.searchParams.get("store_key") || req.headers.get("x-store-key"));
        let id = url.searchParams.get("id");
        let purge = url.searchParams.get("purge") === "true";
        let confirmation = url.searchParams.get("confirmation");

        if (!id || !storeKey) {
          try {
            const body = await req.json();
            if (body.store_key || body.store_partition_key) storeKey = normalizeStoreKey(body.store_key || body.store_partition_key);
            if (body.id) id = String(body.id);
            if (body.purge !== undefined) purge = Boolean(body.purge);
            if (body.confirmation) confirmation = body.confirmation;
          } catch (_) {}
        }

        if (!id || !storeKey) {
          return new Response(JSON.stringify({ error: "Missing id or store_key" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (purge && confirmation === "delete") {
          const { data: doc } = await supabase
            .from("store_knowledge_documents")
            .select("storage_path")
            .eq("id", id)
            .eq("store_partition_key", storeKey)
            .single();

          if (doc?.storage_path) {
            await supabase.storage.from("store-knowledge").remove([doc.storage_path]);
          }

          const { error } = await supabase
            .from("store_knowledge_documents")
            .delete()
            .eq("id", id)
            .eq("store_partition_key", storeKey);

          if (error) throw error;
          return new Response(JSON.stringify({ success: true, purged: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } else {
          const { data, error } = await supabase
            .from("store_knowledge_documents")
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq("id", id)
            .eq("store_partition_key", storeKey)
            .select()
            .single();

          if (error) throw error;
          return new Response(JSON.stringify({ success: true, item: data }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // 9. Single Item Full Detail (GET /pos-journals/knowledge/item?id=...)
      if (req.method === "GET" && isItem) {
        const storeKey = normalizeStoreKey(url.searchParams.get("store_key") || req.headers.get("x-store-key"));
        const id = url.searchParams.get("id");

        if (!id || !storeKey) {
          return new Response(JSON.stringify({ error: "Missing id or store_key" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data: doc, error } = await supabase
          .from("store_knowledge_documents")
          .select("*")
          .eq("id", id)
          .eq("store_partition_key", storeKey)
          .single();

        if (error) throw error;

        const { data: chunks } = await supabase
          .from("store_knowledge_chunks")
          .select("id, chunk_index, chunk_text, token_count")
          .eq("document_id", id)
          .eq("store_partition_key", storeKey)
          .order("chunk_index", { ascending: true });

        const item = {
          ...doc,
          has_attachment: !!doc?.storage_path,
          chunks: chunks || [],
        };

        return new Response(JSON.stringify({ item }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 10. List Knowledge (GET /pos-journals/knowledge?store_key=...)
      if (req.method === "GET") {
        const storeKey = normalizeStoreKey(url.searchParams.get("store_key") || req.headers.get("x-store-key"));
        const category = url.searchParams.get("category");
        const active = url.searchParams.get("active");
        const q = url.searchParams.get("q");
        const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);

        if (!storeKey) {
          return new Response(JSON.stringify({ error: "Missing store_key" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        let query = supabase
          .from("store_knowledge_documents")
          .select("id, store_partition_key, category, title, summary, body_text, period_start, period_end, tags, storage_path, original_file_name, mime_type, file_size_bytes, source_type, is_active, created_at, updated_at")
          .eq("store_partition_key", storeKey)
          .order("created_at", { ascending: false })
          .limit(limitParam);

        if (category) {
          query = query.eq("category", category);
        }

        if (active === "true") {
          query = query.eq("is_active", true);
        } else if (active === "false") {
          query = query.eq("is_active", false);
        }

        if (q) {
          const normQ = normalizeSearchText(q);
          query = query.ilike("search_text", `%${normQ}%`);
        }

        const { data, error } = await query;
        if (error) throw error;

        let matchingChunksMap: Record<number, any[]> = {};
        if (q) {
          const normQ = normalizeSearchText(q);
          const { data: chunks } = await supabase
            .from("store_knowledge_chunks")
            .select("document_id, chunk_text, chunk_index")
            .eq("store_partition_key", storeKey)
            .ilike("search_text", `%${normQ}%`)
            .limit(100);

          if (chunks) {
            for (const c of chunks) {
              if (!matchingChunksMap[c.document_id]) matchingChunksMap[c.document_id] = [];
              matchingChunksMap[c.document_id].push(c);
            }
          }
        }

        const items = (data || []).map((doc: any) => {
          const bodyText = doc.body_text || "";
          return {
            ...doc,
            body_text: bodyText.substring(0, 200),
            body_truncated: bodyText.length > 200,
            has_attachment: !!doc.storage_path,
            matching_chunks: matchingChunksMap[doc.id] || [],
          };
        });

        return new Response(JSON.stringify({ items }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
