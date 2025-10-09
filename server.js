import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
import OpenAI from "openai";

const require = createRequire(import.meta.url);
let cachedPdfParse = null;
let cachedDocxParser = null;
let cachedXlsxParser = null;
let cachedOpenAIClient = null;
const conversationMemory = new Map();
const userStates = new Map();
const MAX_HISTORY_MESSAGES = 10; // store up to 10 prior turns (5 user/assistant pairs)

const MODEL_OPTIONS = {
  "8b": {
    key: "8b",
    displayNumber: "1",
    name: "コスト重視",
    description: "Groq Llama-3.1 8B（高速・低コスト）",
    provider: "groq",
    model: "llama-3.1-8b-instant",
  },
  "70b": {
    key: "70b",
    displayNumber: "2",
    name: "精度重視",
    description: "Groq Llama-3.3 70B（高精度）",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
  },
  "gpt4oMini": {
    key: "gpt4oMini",
    displayNumber: "3",
    name: "高品質",
    description: "OpenAI GPT-4o mini（ChatGPT）",
    provider: "openai",
    model: "gpt-4o-mini",
  },
};

const MODEL_SELECTION_SEQUENCE = ["8b", "70b", "gpt4oMini"];

const MODEL_SELECTION_MESSAGE = `利用するAIモデルを選択してください:\n` +
  MODEL_SELECTION_SEQUENCE
    .map((key) => {
      const option = MODEL_OPTIONS[key];
      return `${option.displayNumber}. ${option.name}: ${option.description}`;
    })
    .join("\n") +
  `\n\n番号を送信してください。\n「モデル変更」と送るといつでも再選択できます。`;

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

function resetConversationHistory(key) {
  if (!key) return;
  conversationMemory.delete(key);
}

function getOrCreateUserState(key) {
  if (!key) return null;
  if (!userStates.has(key)) {
    userStates.set(key, { modelKey: null, awaitingSelection: true });
  }
  return userStates.get(key);
}

function normalizeDigits(value) {
  if (!value) return value;
  return value.replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xFEE0)
  );
}

function parseModelSelection(text) {
  if (!text) return null;
  const normalized = normalizeDigits(text.trim().toLowerCase());

  if (
    normalized === MODEL_OPTIONS["8b"].displayNumber ||
    normalized.includes("8b") ||
    normalized.includes("8") ||
    normalized.includes("コスト")
  ) {
    return "8b";
  }

  if (
    normalized === MODEL_OPTIONS["70b"].displayNumber ||
    normalized.includes("70") ||
    normalized.includes("精度")
  ) {
    return "70b";
  }

  if (
    normalized === MODEL_OPTIONS["gpt4oMini"].displayNumber ||
    normalized.includes("3") ||
    normalized.includes("gpt") ||
    normalized.includes("chatgpi") ||
    normalized.includes("chatgpt") ||
    normalized.includes("openai") ||
    normalized.includes("高品質")
  ) {
    return "gpt4oMini";
  }

  return null;
}

function isModelChangeRequest(text) {
  if (!text) return false;
  return /(モデル変更|ai変更|model\s*change)/i.test(text.trim());
}

function getConversationHistory(key) {
  if (!key) return [];
  return conversationMemory.get(key) ?? [];
}

async function sendLineMessage(replyToken, messages) {
  if (!replyToken) return;

  const payload = {
    replyToken,
    messages,
  };

  console.log("Sending reply message");
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  console.log("LINE API response status:", response.status);
  if (!response.ok) {
    const errorText = await response.text();
    console.error("LINE API error:", errorText);
  } else {
    console.log("Reply sent successfully");
  }
}

async function sendLineText(replyToken, text) {
  return sendLineMessage(replyToken, [{ type: "text", text }]);
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

function getOpenAIClient() {
  if (cachedOpenAIClient) {
    return cachedOpenAIClient;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set. ChatGPTモデルは利用できません。");
    return null;
  }

  try {
    cachedOpenAIClient = new OpenAI({ apiKey });
    return cachedOpenAIClient;
  } catch (error) {
    console.error("Failed to initialize OpenAI client:", error);
    return null;
  }
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

async function listAllFiles(prefix = '') {
  const collected = [];
  let page = 0;

  while (true) {
    const { data, error } = await supabase.storage
      .from('company-documents')
      .list(prefix, {
        limit: 100,
        offset: page * 100,
        sortBy: { column: 'created_at', order: 'desc' }
      });

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      break;
    }

    for (const entry of data) {
      const isFolder = !entry.id && !entry.name.includes('.');
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (isFolder) {
        const nestedFiles = await listAllFiles(entryPath);
        collected.push(...nestedFiles);
      } else {
        collected.push({ ...entry, fullPath: entryPath });
      }
    }

    if (data.length < 100) {
      break;
    }

    page += 1;
  }

  return collected;
}

// Supabaseストレージから会社規約を取得する関数
async function getCompanyRules() {
  try {
    const files = await listAllFiles('');

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

        const filePath = file.fullPath || file.name;
        console.log(`Processing file: ${filePath}`);
        const originalName = file.metadata?.originalName || file.name;
        
        // ファイルをダウンロード（download メソッドを使用）
        const { data: fileData, error: downloadError } = await supabase.storage
          .from('company-documents')
          .download(filePath);

        if (downloadError) {
          console.error(`Error downloading ${filePath}:`, downloadError);
          continue;
        }

        const extension = file.name.split('.').pop().toLowerCase();

        if (extension === 'txt') {
          const text = await fileData.text();
          fileContents.push(`【ファイル: ${originalName}】\n${text}\n`);
          console.log(`Loaded TXT file: ${filePath} (${text.length} chars)`);
        } else if (extension === 'pdf') {
          const pdfParse = await getPdfParse();

          if (!pdfParse) {
            fileContents.push(`【ファイル: ${originalName}】（PDFの解析モジュールを読み込めませんでした）\n`);
            continue;
          }

          try {
            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const parsed = await pdfParse(buffer);
            const text = (parsed.text || "").trim();

            if (!text) {
              fileContents.push(`【ファイル: ${originalName}】（PDFからテキストを抽出できませんでした）\n`);
              console.warn(`PDF parsing produced empty text for ${filePath}`);
            } else {
              fileContents.push(`【ファイル: ${originalName}】\n${text}\n`);
              console.log(`Parsed PDF file: ${filePath} (${text.length} chars)`);
            }
          } catch (parseError) {
            fileContents.push(`【ファイル: ${originalName}】（PDFの解析中にエラーが発生しました）\n`);
            console.error(`Error parsing PDF ${filePath}:`, parseError);
          }
        } else if (extension === 'docx') {
          const mammoth = await getDocxParser();

          if (!mammoth) {
            fileContents.push(`【ファイル: ${originalName}】（DOCXの解析モジュールを読み込めませんでした）\n`);
            continue;
          }

          try {
            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const result = await mammoth.extractRawText({ buffer });
            const text = (result.value || "").trim();

            if (!text) {
              fileContents.push(`【ファイル: ${originalName}】（DOCXからテキストを抽出できませんでした）\n`);
              console.warn(`DOCX parsing produced empty text for ${filePath}`);
            } else {
              fileContents.push(`【ファイル: ${originalName}】\n${text}\n`);
              console.log(`Parsed DOCX file: ${filePath} (${text.length} chars)`);
            }
          } catch (docxError) {
            fileContents.push(`【ファイル: ${originalName}】（DOCXの解析中にエラーが発生しました）\n`);
            console.error(`Error parsing DOCX ${filePath}:`, docxError);
          }
        } else if (extension === 'xlsx') {
          const xlsx = await getXlsxParser();

          if (!xlsx) {
            fileContents.push(`【ファイル: ${originalName}】（XLSXの解析モジュールを読み込めませんでした）\n`);
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
              fileContents.push(`【ファイル: ${originalName}】（XLSXからテキストを抽出できませんでした）\n`);
              console.warn(`XLSX parsing produced empty text for ${filePath}`);
            } else {
              fileContents.push(`【ファイル: ${originalName}】\n${sheetTexts.join('\n\n')}\n`);
              console.log(`Parsed XLSX file: ${filePath} (${sheetTexts.join('\n').length} chars)`);
            }
          } catch (xlsxError) {
            fileContents.push(`【ファイル: ${originalName}】（XLSXの解析中にエラーが発生しました）\n`);
            console.error(`Error parsing XLSX ${filePath}:`, xlsxError);
          }
        }
      } catch (err) {
        console.error(`Error processing file ${file.fullPath || file.name}:`, err);
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
        const userState = getOrCreateUserState(conversationKey);

        const parsedSelection = parseModelSelection(userMessage);

        try {
          if (parsedSelection && MODEL_OPTIONS[parsedSelection]) {
            userState.modelKey = parsedSelection;
            userState.awaitingSelection = false;
            resetConversationHistory(conversationKey);

            const selected = MODEL_OPTIONS[parsedSelection];
            await sendLineText(
              replyToken,
              `AIモデルを「${selected.name}」(${selected.description})に設定しました。ご質問をどうぞ。`
            );
            continue;
          }

          if (isModelChangeRequest(userMessage)) {
            userState.awaitingSelection = true;
            await sendLineText(replyToken, MODEL_SELECTION_MESSAGE);
            continue;
          }

          if (userState.awaitingSelection || !userState.modelKey) {
            userState.awaitingSelection = true;
            await sendLineText(replyToken, MODEL_SELECTION_MESSAGE);
            continue;
          }

          const selectedModel = MODEL_OPTIONS[userState.modelKey];

          if (!selectedModel) {
            userState.awaitingSelection = true;
            await sendLineText(replyToken, MODEL_SELECTION_MESSAGE);
            continue;
          }

          // Supabaseから会社規約を取得
          console.log("User message:", userMessage);
          console.log("Fetching company rules from Supabase...");
          const companyRules = await getCompanyRules();
          
          // システムプロンプトを構築
          let systemPrompt = `あなたは会社規約およびワインリストに関する情報を扱う専門AIアシスタントです。ワインの仕入れ値・販売価格・原価率・粗利といった数値分析にも長けており、提供された資料だけを用いて正確かつ透明な説明を行います。

【重要な指示】
1. 必ず提供されたファイル（会社規約・ワインリストなど）の内容のみに基づいて回答してください。外部のWebサイトや一般常識を勝手に参照してはいけません。
2. 規約やワインリストに記載されていない内容について質問された場合は、以下のように対応してください：
   - まず「その内容は現在の資料には記載されていません」と明確に伝える
   - 次に「一般的な情報としてお答えしてもよろしいでしょうか？」と必ず確認を求める
   - 確認なしに資料外の情報を提供してはいけません。許可があっても推測や一般的知識を述べる際は必ず「【推測】」などのラベルを付けて明示してください。
3. ワインの仕入れ値・販売価格・原価率などを尋ねられた場合は、提供されているデータを丁寧に参照し、計算過程や根拠ファイルを明示してください。計算ができない場合は理由を添えて回答してください。
4. Web検索や外部データの取得が必要な場合は、必ず事前に「外部情報を参照してもよろしいですか？」とユーザーに確認し、許可が得られない限り実行しないでください（現在の環境では実行できないことがある旨も伝えてください）。
5. 回答する際は、どのファイル（元のファイル名）・どの内容に基づいているかを明示してください。
6. 不明確な場合や断定できない場合は推測せず、「資料からは確認できません」などの一言を添えて不確かさを明示してください。
7. 資料に根拠がある回答でも、自信が持てない場合は簡潔な注意書きを添え、勝手な想像で補完しないでください。
8. 推測を述べる必要があるときは必ず文中で「【推測】」と明記し、回答末尾に「（不確実）」を付記してください。`;
          
          if (companyRules && companyRules.trim().length > 0) {
            systemPrompt += "\n\n【会社規約ファイルの内容】\n" + companyRules;
            console.log("Company rules loaded successfully");
          } else {
            systemPrompt += "\n\n【注意】現在、会社規約ファイルが読み込めていません。すべての質問に対して「申し訳ございません。現在、会社規約ファイルを読み込めていないため、正確な情報を提供できません。管理者にお問い合わせください。」と回答してください。";
            console.log("No company rules found - will inform user");
          }

          // Groq AIで応答を生成
          const historyMessages = getConversationHistory(conversationKey);
          let aiResponse = "申し訳ございません、応答を生成できませんでした。";

          if (selectedModel.provider === "groq") {
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
              model: selectedModel.model,
              temperature: 0.2, // より正確で一貫性のある回答のため低めに設定
              max_tokens: 1500,
            });

            aiResponse = chatCompletion.choices[0]?.message?.content || aiResponse;
          } else if (selectedModel.provider === "openai") {
            const openaiClient = getOpenAIClient();

            if (!openaiClient) {
              aiResponse = "申し訳ございません。OpenAIのAPIキーが設定されていないため、このモデルは利用できません。別のモデルを選択してください。";
            } else {
              try {
                const chatCompletion = await openaiClient.chat.completions.create({
                  model: selectedModel.model,
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
                  temperature: 0.2,
                  max_tokens: 1500,
                });

                aiResponse = chatCompletion.choices[0]?.message?.content || aiResponse;
              } catch (openAiError) {
                console.error("OpenAI API error:", openAiError);
                aiResponse = "申し訳ございません。ChatGPTでの応答生成に失敗しました。少し時間を置いてから再度お試しください。";
              }
            }
          } else {
            console.error(`Unsupported provider: ${selectedModel.provider}`);
            aiResponse = "申し訳ございません。現在選択されたAIモデルには対応していません。別のモデルを選択してください。";
          }
          console.log("AI response:", aiResponse);

          // 会話履歴を更新
          updateConversationHistory(conversationKey, userMessage, aiResponse);

          await sendLineText(replyToken, aiResponse);
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
