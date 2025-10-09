import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
let cachedPdfParse = null;
let cachedDocxParser = null;
let cachedXlsxParser = null;
const conversationMemory = new Map();
const MAX_HISTORY_MESSAGES = 10; // store up to 10 prior turns (5 user/assistant pairs)

function getConversationKey(event) {
  if (event.source?.userId) {
    return `user:${event.source.userId}`;
  }
  if (event.source?.groupId) {
    return `group:${event.source.groupId}`;
  }
  if (event.source?.roomId) {
    return `room:${event.source.roomId}`;
  }
  return `reply:${event.replyToken}`;
}

function updateConversationHistory(key, userMessage, assistantMessage) {
  if (!key) return;
  const history = conversationMemory.get(key) ?? [];
  history.push({ role: "user", content: userMessage });
  history.push({ role: "assistant", content: assistantMessage });

  // Trim history to the maximum number of stored messages
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }

  conversationMemory.set(key, history);
}

function getConversationHistory(key) {
  if (!key) return [];
  return conversationMemory.get(key) ?? [];
}

async function getPdfParse() {
  if (!cachedPdfParse) {
    try {
      // Load the core parser directly to skip the package entry's debug routine
      const module = require("pdf-parse/lib/pdf-parse.js");
      cachedPdfParse = module.default ?? module;
    } catch (error) {
      console.error("Failed to load pdf-parse. PDF files will be skipped.", error);
      cachedPdfParse = null;
    }
  }

  return cachedPdfParse;
}

async function getDocxParser() {
  if (!cachedDocxParser) {
    cachedDocxParser = import("mammoth")
      .then((module) => module.default ?? module)
      .catch((error) => {
        console.error("Failed to load mammoth. DOCX files will be skipped.", error);
        return null;
      });
  }

  return cachedDocxParser;
}

async function getXlsxParser() {
  if (!cachedXlsxParser) {
    try {
      const module = require("xlsx");
      cachedXlsxParser = module.default ?? module;
    } catch (error) {
      console.error("Failed to load xlsx library. XLSX files will be skipped.", error);
      cachedXlsxParser = null;
    }
  }

  return cachedXlsxParser;
}

dotenv.config();

// Groq クライアントの初期化
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Supabase クライアントの初期化
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const app = express();

// Supabaseストレージから会社規約を取得する関数
async function getCompanyRules() {
  try {
    // ストレージからファイル一覧を取得
    const { data: files, error } = await supabase.storage
      .from('company-documents')
      .list('', {
        limit: 100,
        offset: 0,
        sortBy: { column: 'created_at', order: 'desc' }
      });

    if (error) {
      console.error('Error fetching files:', error);
      return null;
    }

    if (!files || files.length === 0) {
      console.log('No files found in storage');
      return null;
    }

    // 全てのファイルの内容を取得
    const fileContents = [];
    for (const file of files) {
      try {
        // .emptyファイルや隠しファイルをスキップ
        if (file.name === '.emptyFolderPlaceholder' || file.name.startsWith('.')) {
          continue;
        }

        console.log(`Processing file: ${file.name}`);
        
        // ファイルをダウンロード（download メソッドを使用）
        const { data: fileData, error: downloadError } = await supabase.storage
          .from('company-documents')
          .download(file.name);

        if (downloadError) {
          console.error(`Error downloading ${file.name}:`, downloadError);
          continue;
        }

        const extension = file.name.split('.').pop().toLowerCase();

        if (extension === 'txt') {
          const text = await fileData.text();
          const displayName = file.name.split('.')[0];
          fileContents.push(`【ファイル: ${displayName}】\n${text}\n`);
          console.log(`Loaded TXT file: ${file.name} (${text.length} chars)`);
        } else if (extension === 'pdf') {
          const pdfParse = await getPdfParse();
          const displayName = file.name.split('.')[0];

          if (!pdfParse) {
            fileContents.push(`【ファイル: ${displayName}】（PDFの解析モジュールを読み込めませんでした）\n`);
            continue;
          }

          try {
            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const parsed = await pdfParse(buffer);
            const text = (parsed.text || "").trim();

            if (!text) {
              fileContents.push(`【ファイル: ${displayName}】（PDFからテキストを抽出できませんでした）\n`);
              console.warn(`PDF parsing produced empty text for ${file.name}`);
            } else {
              fileContents.push(`【ファイル: ${displayName}】\n${text}\n`);
              console.log(`Parsed PDF file: ${file.name} (${text.length} chars)`);
            }
          } catch (parseError) {
            fileContents.push(`【ファイル: ${displayName}】（PDFの解析中にエラーが発生しました）\n`);
            console.error(`Error parsing PDF ${file.name}:`, parseError);
          }
        } else if (extension === 'docx') {
          const mammoth = await getDocxParser();
          const displayName = file.name.split('.')[0];

          if (!mammoth) {
            fileContents.push(`【ファイル: ${displayName}】（DOCXの解析モジュールを読み込めませんでした）\n`);
            continue;
          }

          try {
            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const result = await mammoth.extractRawText({ buffer });
            const text = (result.value || "").trim();

            if (!text) {
              fileContents.push(`【ファイル: ${displayName}】（DOCXからテキストを抽出できませんでした）\n`);
              console.warn(`DOCX parsing produced empty text for ${file.name}`);
            } else {
              fileContents.push(`【ファイル: ${displayName}】\n${text}\n`);
              console.log(`Parsed DOCX file: ${file.name} (${text.length} chars)`);
            }
          } catch (docxError) {
            fileContents.push(`【ファイル: ${displayName}】（DOCXの解析中にエラーが発生しました）\n`);
            console.error(`Error parsing DOCX ${file.name}:`, docxError);
          }
        } else if (extension === 'xlsx') {
          const xlsx = await getXlsxParser();
          const displayName = file.name.split('.')[0];

          if (!xlsx) {
            fileContents.push(`【ファイル: ${displayName}】（XLSXの解析モジュールを読み込めませんでした）\n`);
            continue;
          }

          try {
            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const workbook = xlsx.read(buffer, { type: "buffer" });
            const sheetTexts = workbook.SheetNames.map((sheetName) => {
              const worksheet = workbook.Sheets[sheetName];
              if (!worksheet) {
                return null;
              }
              const sheetText = xlsx.utils.sheet_to_csv(worksheet, {
                FS: '\t',
                RS: '\n',
                blankrows: false,
              }).trim();

              if (!sheetText) {
                return null;
              }

              return `【シート: ${sheetName}】\n${sheetText}`;
            }).filter(Boolean);

            if (sheetTexts.length === 0) {
              fileContents.push(`【ファイル: ${displayName}】（XLSXからテキストを抽出できませんでした）\n`);
              console.warn(`XLSX parsing produced empty text for ${file.name}`);
            } else {
              fileContents.push(`【ファイル: ${displayName}】\n${sheetTexts.join('\n\n')}\n`);
              console.log(`Parsed XLSX file: ${file.name} (${sheetTexts.join('\n').length} chars)`);
            }
          } catch (xlsxError) {
            fileContents.push(`【ファイル: ${displayName}】（XLSXの解析中にエラーが発生しました）\n`);
            console.error(`Error parsing XLSX ${file.name}:`, xlsxError);
          }
        }
      } catch (err) {
        console.error(`Error processing file ${file.name}:`, err);
      }
    }

    return fileContents.join('\n---\n\n');
  } catch (error) {
    console.error('Error in getCompanyRules:', error);
    return null;
  }
}

// CORS設定
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(bodyParser.json());
app.use(express.static('public'));

// LINE Webhook エンドポイント
app.post("/webhook", async (req, res) => {
  // 先に200レスポンスを返してタイムアウトを防ぐ
  res.status(200).send("OK");

  try {
    const events = req.body.events;
    if (!events || events.length === 0) {
      console.log("No events received");
      return;
    }

    // 非同期でメッセージ処理
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const replyToken = event.replyToken;
        const userMessage = event.message.text;
        const conversationKey = getConversationKey(event);

        try {
          // Supabaseから会社規約を取得
          console.log("User message:", userMessage);
          console.log("Fetching company rules from Supabase...");
          const companyRules = await getCompanyRules();
          
          // システムプロンプトを構築
          let systemPrompt = `あなたは会社規約に関する質問に答える専門AIアシスタントです。

【重要な指示】
1. 必ず提供された会社規約ファイルの内容のみに基づいて回答してください。
2. 規約ファイルに記載されていない内容について質問された場合は、以下のように対応してください：
   - まず「その内容は現在の規約資料には記載されていません」と明確に伝える
   - 次に「一般的な情報としてお答えしてもよろしいでしょうか？」と必ず確認を求める
   - 確認なしに規約外の情報を提供してはいけません
3. 回答する際は、どのファイルのどの部分に基づいているかを明示してください。
4. 不明確な場合は推測せず、「規約資料からは確認できません」と正直に答えてください。`;
          
          if (companyRules && companyRules.trim().length > 0) {
            systemPrompt += "\n\n【会社規約ファイルの内容】\n" + companyRules;
            console.log("Company rules loaded successfully");
          } else {
            systemPrompt += "\n\n【注意】現在、会社規約ファイルが読み込めていません。すべての質問に対して「申し訳ございません。現在、会社規約ファイルを読み込めていないため、正確な情報を提供できません。管理者にお問い合わせください。」と回答してください。";
            console.log("No company rules found - will inform user");
          }

          // Groq AIで応答を生成
          const historyMessages = getConversationHistory(conversationKey);
          const chatCompletion = await groq.chat.completions.create({
            messages: [
              {
                role: "system",
                content: systemPrompt,
              },
              ...historyMessages,
              {
                role: "user",
                content: userMessage,
              },
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.2, // より正確で一貫性のある回答のため低めに設定
            max_tokens: 1500,
          });

          const aiResponse = chatCompletion.choices[0]?.message?.content || "申し訳ございません、応答を生成できませんでした。";
          console.log("AI response:", aiResponse);

          // 会話履歴を更新
          updateConversationHistory(conversationKey, userMessage, aiResponse);

          // 返信メッセージ
          const replyMessage = {
            replyToken: replyToken,
            messages: [
              {
                type: "text",
                text: aiResponse,
              },
            ],
          };

          // LINE Messaging API に送信
          console.log("Sending reply message");
          const response = await fetch("https://api.line.me/v2/bot/message/reply", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
            },
            body: JSON.stringify(replyMessage),
          });
          
          console.log("LINE API response status:", response.status);
          if (!response.ok) {
            const errorText = await response.text();
            console.error("LINE API error:", errorText);
          } else {
            console.log("Reply sent successfully");
          }
        } catch (error) {
          console.error("Error processing message:", error);
        }
      }
    }
  } catch (error) {
    console.error("Error handling webhook:", error);
  }
});

// 設定APIエンドポイント
app.get("/api/config", (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_ANON_KEY,
  });
});

// 動作確認ルート（Render チェック用）
app.get("/", (req, res) => {
  res.send("✅ Server is running and ready for LINE webhook!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
