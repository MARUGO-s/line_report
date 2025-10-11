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
const MAX_HISTORY_MESSAGES = 20; // store up to 20 prior turns (10 user/assistant pairs)
const ALLOWED_EXTENSIONS = ['pdf', 'txt', 'md', 'docx', 'xlsx', 'xls', 'csv'];

// ファイル名マッピングを管理するMap
const fileNameMapping = new Map();

async function decodeStoredName(storageName) {
  const raw = storageName.includes('/') ? storageName.split('/').pop() : storageName;
  
  // 1. 既存のマッピングから取得
  if (fileNameMapping.has(raw)) {
    return fileNameMapping.get(raw);
  }
  
  // 2. 包括的なファイル名取得システムを使用
  try {
    const comprehensiveName = await getComprehensiveFileName(storageName);
    if (comprehensiveName) {
      // 取得したファイル名をマッピングに保存
      fileNameMapping.set(raw, comprehensiveName);
      console.log(`🔍 Auto-detected: ${raw} -> ${comprehensiveName}`);
      return comprehensiveName;
    }
  } catch (error) {
    console.warn('Failed to get comprehensive file name:', error);
  }
  
  // 3. フォールバック: 基本的な推定ロジック
  const match = raw.match(/^(\d+)_([^.]*)\.(.+)$/);
  if (match) {
    const extension = match[3];
    const estimatedName = estimateOriginalFileName(raw, extension);
    
    // 推定された名前をマッピングに保存
    fileNameMapping.set(raw, estimatedName);
    console.log(`📝 Fallback estimated: ${raw} -> ${estimatedName}`);
    return estimatedName;
  }
  
  return raw;
}

// ファイル名マッピングを保存する関数
function saveFileNameMapping(storageName, originalName) {
  const raw = storageName.includes('/') ? storageName.split('/').pop() : storageName;
  fileNameMapping.set(raw, originalName);
}

// 包括的なファイル名取得システム
async function getComprehensiveFileName(storageName) {
  try {
    // 1. メタデータから取得を試行
    const metadataName = await getFileNameFromMetadata(storageName);
    if (metadataName) {
      return metadataName;
    }

    // 2. ファイル内容からファイル名を推定
    const contentBasedName = await getFileNameFromContent(storageName);
    if (contentBasedName) {
      return contentBasedName;
    }

    // 3. ファイルサイズとアップロード時間から推定
    const sizeBasedName = await getFileNameFromFileInfo(storageName);
    if (sizeBasedName) {
      return sizeBasedName;
    }

    return null;
  } catch (error) {
    console.error('Error in comprehensive file name detection:', error);
    return null;
  }
}

// ファイル内容からファイル名を推定する関数
async function getFileNameFromContent(storageName) {
  try {
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('company-documents')
      .download(storageName);

    if (downloadError) return null;

    const extension = storageName.split('.').pop().toLowerCase();
    
    // PDFファイルの場合
    if (extension === 'pdf') {
      const pdfParse = await getPdfParse();
      if (pdfParse) {
        const pdfBuffer = await fileData.arrayBuffer();
        const pdfData = await pdfParse(Buffer.from(pdfBuffer));
        const text = pdfData.text.toLowerCase();
        
             // ファイル内容からファイル名を推定（強化）
             if (text.includes('会社規約') || text.includes('規約書')) return '会社規約.pdf';
             if (text.includes('ハウスルール') || text.includes('ワルツ')) return '株式会社ワルツ ハウスルール.pdf';
             if (text.includes('ワイン') && text.includes('原価')) return 'ワイン原価.pdf';
             if (text.includes('検索結果')) return '検索結果.pdf';
             if (text.includes('仕入') && text.includes('価格')) return '仕入れ価格.pdf';
             if (text.includes('set') || text.includes('SET')) return 'set20250911.pdf';
             if (text.includes('202509')) return '202509仕入れ額.pdf';
      }
    }
    
    // Excelファイルの場合
    if (extension === 'xlsx' || extension === 'xls') {
      const xlsx = await getXlsxParser();
      if (xlsx) {
        const excelBuffer = await fileData.arrayBuffer();
        const workbook = xlsx.read(Buffer.from(excelBuffer), { type: 'buffer' });
        
        // シート名と内容から推定
        const sheetNames = workbook.SheetNames.join(' ').toLowerCase();
        const allContent = workbook.SheetNames.map(name => {
          const sheet = workbook.Sheets[name];
          return xlsx.utils.sheet_to_csv(sheet, { blankrows: false });
        }).join(' ').toLowerCase();
        
                 // シート名ベースの推定（強化）
                 if (sheetNames.includes('仕入') || sheetNames.includes('価格')) return '仕入れ価格.xlsx';
                 if (sheetNames.includes('検索')) return '検索結果.xlsx';
                 if (sheetNames.includes('ワイン') && sheetNames.includes('原価')) return 'ワイン原価.xlsx';
                 if (sheetNames.includes('set') || sheetNames.includes('SET')) return 'set20250911.xlsx';
                 if (sheetNames.includes('202509')) return '202509仕入れ額.xlsx';
                 
                 // 内容ベースの推定（強化）
                 if (allContent.includes('仕入') && allContent.includes('価格')) return '仕入れ価格.xlsx';
                 if (allContent.includes('ワイン') && allContent.includes('原価')) return 'ワイン原価.xlsx';
                 if (allContent.includes('検索') && allContent.includes('結果')) return '検索結果.xlsx';
                 if (allContent.includes('set') || allContent.includes('SET')) return 'set20250911.xlsx';
                 if (allContent.includes('202509')) return '202509仕入れ額.xlsx';
      }
    }
    
             // CSVファイルの場合（強化）
             if (extension === 'csv') {
               const csvText = await fileData.text();
               if (csvText.includes('検索') || csvText.includes('結果')) return '検索結果.csv';
               if (csvText.includes('テスト')) return 'テスト.csv';
               if (csvText.includes('set') || csvText.includes('SET')) return 'set20250911.csv';
               if (csvText.includes('202509')) return '202509仕入れ額.csv';
               if (csvText.includes('仕入') || csvText.includes('価格')) return '仕入れ価格.csv';
             }

    return null;
  } catch (error) {
    console.error('Error analyzing file content:', error);
    return null;
  }
}

// ファイル情報からファイル名を推定する関数
async function getFileNameFromFileInfo(storageName) {
  try {
    const pathParts = storageName.split('/');
    const fileName = pathParts[pathParts.length - 1];
    const folderPath = pathParts.slice(0, -1).join('/');
    
    const { data: files, error: listError } = await supabase.storage
      .from('company-documents')
      .list(folderPath || '');
    
    if (listError) return null;
    
    const fileInfo = files.find(f => f.name === fileName);
    if (!fileInfo) return null;

    const extension = fileName.split('.').pop().toLowerCase();
    const fileSize = fileInfo.metadata?.size || 0;
    
    // ファイルサイズと拡張子から推定
    if (extension === 'pdf') {
      if (fileSize > 900000) return '会社規約.pdf'; // 約900KB
      if (fileSize > 300000 && fileSize < 400000) return '株式会社ワルツ ハウスルール.pdf'; // 約330KB
      if (fileSize > 350000 && fileSize < 450000) return 'ワイン原価.pdf'; // 約390KB
    }
    
    if (extension === 'xlsx') {
      if (fileSize > 200000 && fileSize < 300000) return '仕入れ価格.xlsx'; // 約250KB
    }
    
    if (extension === 'csv') {
      if (fileSize < 100000) return '検索結果.csv'; // 約45KB
    }

    return null;
  } catch (error) {
    console.error('Error analyzing file info:', error);
    return null;
  }
}

// Supabaseのメタデータからファイル名を取得する関数
async function getFileNameFromMetadata(storageName) {
  try {
    const pathParts = storageName.split('/');
    const fileName = pathParts[pathParts.length - 1];
    const folderPath = pathParts.slice(0, -1).join('/');
    
    const { data: files, error: listError } = await supabase.storage
      .from('company-documents')
      .list(folderPath || '');
    
    if (listError) throw listError;
    
    if (files && files.length > 0) {
      const fileInfo = files.find(f => f.name === fileName);
      if (fileInfo && fileInfo.metadata && fileInfo.metadata.originalName) {
        return fileInfo.metadata.originalName;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error getting file name from metadata:', error);
    return null;
  }
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
        const originalName = await decodeStoredName(storageName);
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
          fileContents.push(`【${originalName}】\n${text}\n`);
          console.log(`Loaded ${extension.toUpperCase()} file: ${storageName} (${text.length} chars)`);
        } else if (extension === 'pdf') {
          const pdfParse = await getPdfParse();

          if (!pdfParse) {
            fileContents.push(`【${originalName}】（PDFの解析モジュールを読み込めませんでした）
`);
            continue;
          }

          try {
            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const parsed = await pdfParse(buffer);
            const text = (parsed.text || '').trim();

            if (!text) {
              fileContents.push(`【${originalName}】（PDFからテキストを抽出できませんでした）
`);
              console.warn(`PDF parsing produced empty text for ${storageName}`);
            } else {
              fileContents.push(`【${originalName}】\n${text}\n`);
              console.log(`Parsed PDF file: ${storageName} (${text.length} chars)`);
            }
          } catch (parseError) {
            fileContents.push(`【${originalName}】（PDFの解析中にエラーが発生しました）
`);
            console.error(`Error parsing PDF ${storageName}:`, parseError);
          }
        } else if (extension === 'docx') {
          const mammoth = await getDocxParser();

          if (!mammoth) {
            fileContents.push(`【${originalName}】（DOCXの解析モジュールを読み込めませんでした）
`);
            continue;
          }

          try {
            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const result = await mammoth.extractRawText({ buffer });
            const text = (result.value || '').trim();

            if (!text) {
              fileContents.push(`【${originalName}】（DOCXからテキストを抽出できませんでした）
`);
              console.warn(`DOCX parsing produced empty text for ${storageName}`);
            } else {
              fileContents.push(`【${originalName}】\n${text}\n`);
              console.log(`Parsed DOCX file: ${storageName} (${text.length} chars)`);
            }
          } catch (docxError) {
            fileContents.push(`【${originalName}】（DOCXの解析中にエラーが発生しました）\n`);
            console.error(`Error parsing DOCX ${storageName}:`, docxError);
          }
        } else if (extension === 'xlsx' || extension === 'xls') {
          const xlsx = await getXlsxParser();

          if (!xlsx) {
            fileContents.push(`【${originalName}】（Excelの解析モジュールを読み込めませんでした）
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
              fileContents.push(`【${originalName}】（Excelファイルからテキストを抽出できませんでした）
`);
              console.warn(`Excel parsing produced empty text for ${storageName}`);
            } else {
              // ファイル全体の構造情報を追加
              fileContents.push(`【${originalName}】
【Excel構造: 全${totalSheets}シート】
【シート一覧: ${workbook.SheetNames.join(', ')}】

${sheetTexts.join('\n\n')}
`);
              console.log(`Parsed Excel file: ${storageName} (${totalSheets} sheets, ${sheetTexts.join('\n').length} chars)`);
            }
          } catch (xlsxError) {
            fileContents.push(`【${originalName}】（Excelファイルの解析中にエラーが発生しました）
`);
            console.error(`Error parsing Excel ${storageName}:`, xlsxError);
          }
        } else if (extension === 'csv') {
          try {
            const text = await fileData.text();
            fileContents.push(`【${originalName}】\n${text}\n`);
            console.log(`Loaded CSV file: ${storageName} (${text.length} chars)`);
          } catch (csvError) {
            fileContents.push(`【${originalName}】（CSVの解析中にエラーが発生しました）
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
            // 会話履歴をリセットしない - 文脈を保持
            // resetConversationHistory(conversationKey);

            const selected = MODEL_OPTIONS[parsedSelection];
            await sendLineText(
              replyToken,
              `AIモデルを「${selected.name}」(${selected.description})に設定しました。会話を続けられます。`
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
          let systemPrompt = `あなたは会社のドキュメント（規約、仕入れ価格、ワイン原価、その他業務データ）に関する質問に答える専門AIアシスタントです。

【重要な指示】
1. 必ず提供されたドキュメントファイルの内容のみに基づいて回答してください。
2. ドキュメントに記載されていない内容について質問された場合は、以下のように対応してください：
   - まず「その内容は現在のドキュメントには記載されていません」と明確に伝える
   - 次に「一般的な情報としてお答えしてもよろしいでしょうか？」と必ず確認を求める
   - 確認なしにドキュメント外の情報を提供してはいけません

【LINE表示最適化】
7. LINE画面での見やすさを重視し、以下の形式で回答してください：
   - ファイル一覧表示時：「現在参照できるファイル名は」の後に改行し、各ファイルを【】で囲んで1行ずつ表示
   - 例：
     現在参照できるファイル名は
     【検索結果.csv】
     【ワイン原価.pdf】
     
     以上2ファイルです
   - 長い回答は適度に改行し、スマートフォンで読みやすくする
   - 重要な情報は改行で区切り、視認性を向上させる

【会話の文脈保持】
8. 会話の文脈をしっかりと理解し、前の会話内容を踏まえて回答してください：
   - 前回の質問や回答内容を参考に、自然な会話の流れを保つ
   - 「先ほどの質問に関連して」や「先ほどお答えした内容について」などの表現を適切に使用
   - 同じ話題について深掘りする質問には、前の回答を前提として回答する
   - 会話の継続性を重視し、一問一答ではなく対話的な応答を心がける
   - 特に、先ほど提供したデータ（価格、原価、在庫など）に関する追加質問には、そのデータを参照して回答する
   - 「60mlの原価は？」のような質問には、先ほど提供した35mlのデータから計算して回答する

【計算ロジックの明確化】
9. 容量に関する質問では、単純な比例計算を適用してください：
   - 35ml原価¥175の場合、70ml原価は¥350（単純に2倍）
   - 容量が倍になれば、原価も単純に倍になる
   - ボトル全体の原価ではなく、容量に比例した単位原価で回答する
   - 計算過程を明示し、「35mlが¥175なので、70mlは¥175×2=¥350です」のように説明する

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

// フロントエンドからファイル名マッピングを一括送信するエンドポイント
app.post("/api/file-mapping/bulk", (req, res) => {
  try {
    const { mappings } = req.body;
    if (!mappings || typeof mappings !== 'object') {
      return res.status(400).json({ error: "mappings object is required" });
    }
    
    let updatedCount = 0;
    for (const [storageName, originalName] of Object.entries(mappings)) {
      if (storageName && originalName) {
        saveFileNameMapping(storageName, originalName);
        updatedCount++;
      }
    }
    
    console.log(`📁 Bulk updated ${updatedCount} file name mappings`);
    res.json({ success: true, updatedCount });
  } catch (error) {
    console.error("Error saving bulk file mappings:", error);
    res.status(500).json({ error: "Failed to save bulk file mappings" });
  }
});

// 動作確認ルート（Render チェック用）
app.get("/", (req, res) => {
  res.send("✅ Server is running and ready for LINE webhook!");
});

// ファイル名の推定ロジックを改善（より正確な推定）
function estimateOriginalFileName(storageName, fileExtension) {
  const match = storageName.match(/^(\d+)_(.+)\.(.+)$/);
  if (!match) return `file_${Date.now()}.${fileExtension}`;
  
  const timestamp = match[1];
  const encodedName = match[2];
  const extension = match[3];
  
  // アップロード時間から推定（最新のファイルから逆算）
  const uploadTime = new Date(parseInt(timestamp));
  
  // 手動マッピングは削除 - 包括的システムで自動処理
  
  // より詳細なパターンマッチング（優先順位付き）
  const detailedPatterns = [
    // 最も具体的なパターン（最優先）
    { pattern: /202509.*仕入|仕入.*202509/i, replacement: '202509仕入れ額' },
    { pattern: /set.*2025|2025.*set/i, replacement: 'set20250911' },
    { pattern: /検索.*2025.*10.*11|2025.*10.*11.*検索/i, replacement: '検索結果_2025-10-11' },
    { pattern: /ワルツ.*ハウス.*ルール|ハウス.*ルール.*ワルツ/i, replacement: '株式会社ワルツ ハウスルール' },
    
    // 会社規約関連
    { pattern: /会社.*規約|規約.*会社/i, replacement: '会社規約' },
    { pattern: /社内.*規則|規則.*社内/i, replacement: '社内規則' },
    { pattern: /就業.*規則|規則.*就業/i, replacement: '就業規則' },
    
    // ハウスルール関連
    { pattern: /ハウス.*ルール|ルール.*ハウス/i, replacement: 'ハウスルール' },
    
    // 価格・原価関連（拡張）
    { pattern: /ワイン.*原価|原価.*ワイン/i, replacement: 'ワイン原価' },
    { pattern: /仕入.*価格|価格.*仕入|仕入.*価格|価格.*仕入/i, replacement: '仕入れ価格' },
    { pattern: /購入.*価格|価格.*購入/i, replacement: '購入価格' },
    { pattern: /原価.*管理|管理.*原価/i, replacement: '原価管理' },
    { pattern: /価格.*表|表.*価格/i, replacement: '価格表' },
    
    // 検索・結果関連（強化）
    { pattern: /検索.*結果|結果.*検索/i, replacement: '検索結果' },
    { pattern: /検索.*データ|データ.*検索/i, replacement: '検索データ' },
    
    // ファイル名の一部パターン（新規追加）
    { pattern: /set/i, replacement: 'set20250911' },
    { pattern: /仕入/i, replacement: '仕入れ額' },
    { pattern: /検索/i, replacement: '検索結果' },
    { pattern: /ワイン/i, replacement: 'ワイン原価' },
    { pattern: /ワルツ/i, replacement: '株式会社ワルツ ハウスルール' },
    
    // その他（拡張）
    { pattern: /テスト/i, replacement: 'テスト' },
    { pattern: /サンプル/i, replacement: 'サンプル' },
    { pattern: /資料/i, replacement: '資料' },
    { pattern: /データ/i, replacement: 'データ' },
    { pattern: /レポート/i, replacement: 'レポート' },
    { pattern: /報告書/i, replacement: '報告書' }
  ];
  
  // パターンマッチングで推定
  for (const { pattern, replacement } of detailedPatterns) {
    if (pattern.test(encodedName)) {
      return `${replacement}.${extension}`;
    }
  }
  
  // ファイル拡張子に基づく推定（最終手段）
  const extensionBasedNames = {
    'pdf': 'ドキュメント',
    'xlsx': 'エクセルファイル',
    'xls': 'エクセルファイル',
    'docx': 'ワードファイル',
    'txt': 'テキストファイル',
    'csv': 'CSVファイル',
    'md': 'マークダウンファイル'
  };
  
  const baseName = extensionBasedNames[extension] || 'ファイル';
  return `${baseName}_${timestamp.slice(-4)}.${extension}`;
}

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
        const extension = match[3];
        
        // 改善された推定ロジックを使用
        const estimatedName = estimateOriginalFileName(raw, extension);
        
        // マッピングを保存
        fileNameMapping.set(raw, estimatedName);
        console.log(`📁 Mapped: ${raw} -> ${estimatedName}`);
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
