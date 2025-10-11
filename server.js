import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
let cachedPdfParse = null;
let cachedDocxParser = null;
let cachedXlsxParser = null;
let cachedOpenAIClient = null;
const conversationMemory = new Map();
const userStates = new Map();
const MAX_HISTORY_MESSAGES = 10; // store up to 10 prior turns (5 user/assistant pairs)
const ALLOWED_EXTENSIONS = ['pdf', 'txt', 'md', 'docx', 'xlsx', 'xls', 'csv'];

// ファイル名マッピングを管理するMap
const fileNameMapping = new Map();

function decodeStoredName(storageName) {
  const raw = storageName.includes('/') ? storageName.split('/').pop() : storageName;
  
  // マッピングから元のファイル名を取得
  if (fileNameMapping.has(raw)) {
    return fileNameMapping.get(raw);
  }
  
  const match = raw.match(/^(\d+)_([^.]*)\.(.+)$/);
  if (match) {
    // マッピングがない場合は、タイムスタンプと拡張子から推測可能な名前を生成
    const timestamp = match[1];
    const extension = match[3];
    const result = `file_${timestamp}.${extension}`;
    return result;
  }
  
  return raw;
}

// ファイル名マッピングを保存する関数
function saveFileNameMapping(storageName, originalName) {
  const raw = storageName.includes('/') ? storageName.split('/').pop() : storageName;
  fileNameMapping.set(raw, originalName);
}

// ファイル名マッピングを取得する関数
function getOriginalFileName(storageName) {
  const raw = storageName.includes('/') ? storageName.split('/').pop() : storageName;
  return fileNameMapping.get(raw) || raw;
}

async function listAllStorageFiles(prefix = 'uploads') {
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

    for (const item of data) {
      const isFolder = !item.metadata && !item.name.includes('.');
      const fullPath = prefix ? `${prefix}/${item.name}` : item.name;

      if (isFolder) {
        const nested = await listAllStorageFiles(fullPath);
        collected.push(...nested);
      } else {
        collected.push({ ...item, fullPath });
      }
    }

    if (data.length < 100) {
      break;
    }

    page += 1;
  }

  return collected;
}

const MODEL_OPTIONS = {
  "8b": {
    key: "8b",
    displayNumber: "1",
    name: "コスト重視",
    description: "Groq Llama-3.1 8B (高速・低コスト)",
    provider: "groq",
    model: "llama-3.1-8b-instant",
  },
  "70b": {
    key: "70b",
    displayNumber: "2",
    name: "精度重視",
    description: "Groq Llama-3.3 70B (高精度)",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
  },
  "gpt": {
    key: "gpt",
    displayNumber: "3",
    name: "ChatGPT",
    description: "OpenAI GPT-4o-mini (高速・コスト効率)",
    provider: "openai",
    model: "gpt-4o-mini",
  },
};

const MODEL_SELECTION_MESSAGE = `利用するAIモデルを選択してください:\n` +
  Object.values(MODEL_OPTIONS)
    .map((option) => `${option.displayNumber}. ${option.name}: ${option.description}`)
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

function parseModelSelection(text) {
  if (!text) return null;
  const normalized = text.trim().toLowerCase();

  // 極めて厳密な判定：モデル選択の明示的な指示のみ
  // 数字のみのメッセージや、数字を含む通常の質問では反応しない
  if (normalized === MODEL_OPTIONS["8b"].displayNumber || 
      normalized === "8b" || 
      normalized === "コスト重視" ||
      normalized === "1番" ||
      normalized === "モデル1") {
    return "8b";
  }
  if (normalized === MODEL_OPTIONS["70b"].displayNumber || 
      normalized === "70b" || 
      normalized === "精度重視" ||
      normalized === "2番" ||
      normalized === "モデル2") {
    return "70b";
  }
  if (normalized === MODEL_OPTIONS["gpt"].displayNumber || 
      normalized === "gpt" || 
      normalized === "chatgpt" ||
      normalized === "3番" ||
      normalized === "モデル3") {
    return "gpt";
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

dotenv.config();

// Groq クライアントの初期化
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// OpenAI クライアントの初期化
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
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
    const files = await listAllStorageFiles('uploads');

    if (!files || files.length === 0) {
      console.log('No files found in storage');
      return null;
    }

    const fileContents = [];
    for (const file of files) {
      try {
        const storageName = file.fullPath || `uploads/${file.name}`;
        const originalName = decodeStoredName(storageName);
        // console.log(`Processing file: ${storageName} (original: ${originalName})`);

        const { data: fileData, error: downloadError } = await supabase.storage
          .from('company-documents')
          .download(storageName);

        if (downloadError) {
          console.error(`Error downloading ${storageName}:`, downloadError);
          continue;
        }

        const extension = storageName.split('.').pop().toLowerCase();

        if (!ALLOWED_EXTENSIONS.includes(extension)) {
          console.log(`Skipping unsupported file type: ${storageName}`);
          continue;
        }

        if (extension === 'txt' || extension === 'md') {
          const text = await fileData.text();
          fileContents.push(`【ファイル: ${originalName}】\n${text}\n`);
          console.log(`Loaded ${extension.toUpperCase()} file: ${storageName} (${text.length} chars)`);
        } else if (extension === 'pdf') {
          const pdfParse = await getPdfParse();

          if (!pdfParse) {
            fileContents.push(`【ファイル: ${originalName}】（PDFの解析モジュールを読み込めませんでした）
`);
            continue;
          }

          try {
            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const parsed = await pdfParse(buffer);
            const text = (parsed.text || '').trim();

            if (!text) {
              fileContents.push(`【ファイル: ${originalName}】（PDFからテキストを抽出できませんでした）
`);
              console.warn(`PDF parsing produced empty text for ${storageName}`);
            } else {
              fileContents.push(`【ファイル: ${originalName}】\n${text}\n`);
              console.log(`Parsed PDF file: ${storageName} (${text.length} chars)`);
            }
          } catch (parseError) {
            fileContents.push(`【ファイル: ${originalName}】（PDFの解析中にエラーが発生しました）
`);
            console.error(`Error parsing PDF ${storageName}:`, parseError);
          }
        } else if (extension === 'docx') {
          const mammoth = await getDocxParser();

          if (!mammoth) {
            fileContents.push(`【ファイル: ${originalName}】（DOCXの解析モジュールを読み込めませんでした）
`);
            continue;
          }

          try {
            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const result = await mammoth.extractRawText({ buffer });
            const text = (result.value || '').trim();

            if (!text) {
              fileContents.push(`【ファイル: ${originalName}】（DOCXからテキストを抽出できませんでした）
`);
              console.warn(`DOCX parsing produced empty text for ${storageName}`);
            } else {
              fileContents.push(`【ファイル: ${originalName}】\n${text}\n`);
              console.log(`Parsed DOCX file: ${storageName} (${text.length} chars)`);
            }
          } catch (docxError) {
            fileContents.push(`【ファイル: ${originalName}】（DOCXの解析中にエラーが発生しました）\n`);
            console.error(`Error parsing DOCX ${storageName}:`, docxError);
          }
        } else if (extension === 'xlsx' || extension === 'xls') {
          const xlsx = await getXlsxParser();

          if (!xlsx) {
            fileContents.push(`【ファイル: ${originalName}】（Excelの解析モジュールを読み込めませんでした）
`);
            continue;
          }

          try {
            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const workbook = xlsx.read(buffer, { type: 'buffer' });
            
            // ワークブック全体の情報を取得
            const totalSheets = workbook.SheetNames.length;
            
            const sheetTexts = workbook.SheetNames.map((sheetName, index) => {
              const worksheet = workbook.Sheets[sheetName];
              if (!worksheet) {
                return null;
              }
              
              // シートの範囲を取得
              const range = xlsx.utils.decode_range(worksheet['!ref'] || 'A1:A1');
              const rowCount = range.e.r + 1;
              const colCount = range.e.c + 1;
              
              // より構造化されたテキスト形式で出力
              const sheetText = xlsx.utils.sheet_to_csv(worksheet, {
                FS: '	',
                RS: '\n',
                blankrows: false,
              }).trim();

              if (!sheetText) {
                return null;
              }

              // シートの詳細情報を含めて出力
              return `【シート${index + 1}/${totalSheets}: ${sheetName}】
【構造情報: ${rowCount}行 × ${colCount}列】
【データ内容】
${sheetText}`;
            }).filter(Boolean);

            if (sheetTexts.length === 0) {
              fileContents.push(`【ファイル: ${originalName}】（Excelファイルからテキストを抽出できませんでした）
`);
              console.warn(`Excel parsing produced empty text for ${storageName}`);
            } else {
              // ファイル全体の構造情報を追加
              fileContents.push(`【ファイル: ${originalName}】
【Excel構造: 全${totalSheets}シート】
【シート一覧: ${workbook.SheetNames.join(', ')}】

${sheetTexts.join('\n\n')}
`);
              console.log(`Parsed Excel file: ${storageName} (${totalSheets} sheets, ${sheetTexts.join('\n').length} chars)`);
            }
          } catch (xlsxError) {
            fileContents.push(`【ファイル: ${originalName}】（Excelファイルの解析中にエラーが発生しました）
`);
            console.error(`Error parsing Excel ${storageName}:`, xlsxError);
          }
        } else if (extension === 'csv') {
          try {
            const text = await fileData.text();
            fileContents.push(`【ファイル: ${originalName}】\n${text}\n`);
            console.log(`Loaded CSV file: ${storageName} (${text.length} chars)`);
          } catch (csvError) {
            fileContents.push(`【ファイル: ${originalName}】（CSVの解析中にエラーが発生しました）
`);
            console.error(`Error processing CSV ${storageName}:`, csvError);
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
          // モデル選択の判定をより厳密にする
          const isExplicitModelSelection = parsedSelection && 
            MODEL_OPTIONS[parsedSelection] && 
            (userState.awaitingSelection || userMessage.trim().length <= 10); // 短いメッセージのみ

          if (isExplicitModelSelection) {
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
          let systemPrompt = `あなたは会社規約に関する質問に答える専門AIアシスタントです。

【重要な指示】
1. 必ず提供された会社規約ファイルの内容のみに基づいて回答してください。
2. 規約ファイルに記載されていない内容について質問された場合は、以下のように対応してください：
   - まず「その内容は現在の規約資料には記載されていません」と明確に伝える
   - 次に「一般的な情報としてお答えしてもよろしいでしょうか？」と必ず確認を求める
   - 確認なしに規約外の情報を提供してはいけません

【Excelファイルの構造認識について】
Excelファイルが含まれている場合、以下の構造情報を正確に理解してください：
- 【Excel構造: 全Xシート】: ファイル内の総シート数
- 【シート一覧: A, B, C】: 全てのシート名
- 【シートX/Y: シート名】: 各シートの番号と名前
- 【構造情報: X行 × Y列】: 各シートの行数と列数
- 【データ内容】: 実際のデータ（タブ区切り形式）

【回答時の情報源明示】
3. 回答する際は、以下の形式で正確に情報源を明示してください：
   - 「【ファイル: 正確なファイル名】」の形式で必ず記載
   - ファイル名は推測せず、提供された情報から正確に引用
   - Excelファイルの場合：「【シート: 正確なシート名】」も併記
   - シートの構造情報（行数×列数）も参考にしてください

【Excelデータの解釈】
4. Excelデータは以下のように解釈してください：
   - タブ区切り（\t）で列が分離されています
   - 改行（\n）で行が分離されています
   - 最初の行はヘッダー（項目名）の可能性が高いです
   - 空のセルや行は省略されています

5. 不明確な場合は推測せず、「規約資料からは確認できません」と正直に答えてください。
6. ファイル名やシート名を間違えて表示することは絶対に避けてください。`;
          
          if (companyRules && companyRules.trim().length > 0) {
            systemPrompt += "\n\n【会社規約ファイルの内容】\n" + companyRules;
            console.log("Company rules loaded successfully");
            // console.log(`First 500 chars of company rules: ${companyRules.substring(0, 500)}...`);
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
            const chatCompletion = await openai.chat.completions.create({
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
              temperature: 0.2,
              max_tokens: 1500,
            });

            aiResponse = chatCompletion.choices[0]?.message?.content || aiResponse;
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

// ファイル名マッピングを保存するエンドポイント
app.post("/api/file-mapping", (req, res) => {
  try {
    const { storageName, originalName } = req.body;
    if (!storageName || !originalName) {
      return res.status(400).json({ error: "storageName and originalName are required" });
    }
    
    saveFileNameMapping(storageName, originalName);
    console.log(`File mapping saved: ${storageName} -> ${originalName}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Error saving file mapping:", error);
    res.status(500).json({ error: "Failed to save file mapping" });
  }
});

// ファイル名マッピングを取得するエンドポイント
app.get("/api/file-mapping/:storageName", (req, res) => {
  try {
    const { storageName } = req.params;
    const originalName = getOriginalFileName(storageName);
    res.json({ originalName });
  } catch (error) {
    console.error("Error getting file mapping:", error);
    res.status(500).json({ error: "Failed to get file mapping" });
  }
});

// 手動でファイル名マッピングを設定するエンドポイント（デバッグ用）
app.post("/api/file-mapping/manual", (req, res) => {
  try {
    const { storageName, originalName } = req.body;
    if (!storageName || !originalName) {
      return res.status(400).json({ error: "storageName and originalName are required" });
    }
    
    saveFileNameMapping(storageName, originalName);
    console.log(`Manual file mapping saved: ${storageName} -> ${originalName}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Error saving manual file mapping:", error);
    res.status(500).json({ error: "Failed to save manual file mapping" });
  }
});

// 現在のファイル名マッピング一覧を取得するエンドポイント（デバッグ用）
app.get("/api/file-mapping-debug", (req, res) => {
  try {
    const mappings = {};
    for (const [key, value] of fileNameMapping.entries()) {
      mappings[key] = value;
    }
    res.json({ mappings, count: fileNameMapping.size });
  } catch (error) {
    console.error("Error getting file mappings:", error);
    res.status(500).json({ error: "Failed to get file mappings" });
  }
});

// 動作確認ルート（Render チェック用）
app.get("/", (req, res) => {
  res.send("✅ Server is running and ready for LINE webhook!");
});

// サーバー起動時に既存ファイルのマッピングを復元
async function restoreFileMappings() {
  try {
    console.log('🔄 Restoring file name mappings...');
    const files = await listAllStorageFiles('uploads');
    
    for (const file of files) {
      const storageName = file.fullPath || `uploads/${file.name}`;
      const raw = storageName.includes('/') ? storageName.split('/').pop() : storageName;
      
      // 既存のファイル名パターンを解析
      const match = raw.match(/^(\d+)_(.+)\.(.+)$/);
      if (match) {
        const timestamp = match[1];
        const encodedName = match[2];
        const extension = match[3];
        
        // エンコードされた名前をデコードして元のファイル名を推定
        let originalName;
        try {
          // URLデコードを試行
          const decoded = decodeURIComponent(encodedName);
          originalName = `${decoded}.${extension}`;
        } catch (e) {
          // デコードに失敗した場合は、_を元に戻して推定
          const estimatedName = encodedName.replace(/_/g, '');
          originalName = estimatedName ? `${estimatedName}.${extension}` : `file_${timestamp}.${extension}`;
        }
        
        // マッピングを保存
        fileNameMapping.set(raw, originalName);
        console.log(`📁 Mapped: ${raw} -> ${originalName}`);
      }
    }
    
    console.log(`✅ Restored ${fileNameMapping.size} file name mappings`);
  } catch (error) {
    console.error('❌ Error restoring file mappings:', error);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  await restoreFileMappings();
});
