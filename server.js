import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";

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

        // TXTファイルの場合はテキストとして読み込み
        if (file.name.endsWith('.txt')) {
          const text = await fileData.text();
          const displayName = file.name.split('.')[0];
          fileContents.push(`【ファイル: ${displayName}】\n${text}\n`);
          console.log(`Loaded TXT file: ${file.name} (${text.length} chars)`);
        } else if (file.name.endsWith('.pdf')) {
          // PDFは現時点ではテキスト抽出できないため、ファイル名のみ記録
          const displayName = file.name.split('.')[0];
          fileContents.push(`【ファイル: ${displayName}】（PDFファイル - テキスト抽出未対応）\n`);
          console.log(`Found PDF file: ${file.name}`);
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

        try {
          // Supabaseから会社規約を取得
          console.log("User message:", userMessage);
          console.log("Fetching company rules from Supabase...");
          const companyRules = await getCompanyRules();
          
          // システムプロンプトを構築
          let systemPrompt = "あなたは会社の規約について答えるAIアシスタントです。日本語で簡潔かつ正確に応答してください。";
          
          if (companyRules) {
            systemPrompt += "\n\n以下は会社規約のファイル内容です。この情報を参考にして質問に答えてください：\n\n" + companyRules;
            console.log("Company rules loaded successfully");
          } else {
            systemPrompt += "\n\n注意：現在、会社規約ファイルが読み込めていません。一般的な回答を提供してください。";
            console.log("No company rules found");
          }

          // Groq AIで応答を生成
          const chatCompletion = await groq.chat.completions.create({
            messages: [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content: userMessage,
              },
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.5,
            max_tokens: 1500,
          });

          const aiResponse = chatCompletion.choices[0]?.message?.content || "申し訳ございません、応答を生成できませんでした。";
          console.log("AI response:", aiResponse);

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
