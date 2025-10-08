import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import Groq from "groq-sdk";

dotenv.config();

// Groq クライアントの初期化
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const app = express();
app.use(bodyParser.json());

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
          // Groq AIで応答を生成
          console.log("User message:", userMessage);
          const chatCompletion = await groq.chat.completions.create({
            messages: [
              {
                role: "system",
                content: "あなたは親切で役立つAIアシスタントです。日本語で簡潔に応答してください。",
              },
              {
                role: "user",
                content: userMessage,
              },
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.7,
            max_tokens: 1000,
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

// 動作確認ルート（Render チェック用）
app.get("/", (req, res) => {
  res.send("✅ Server is running and ready for LINE webhook!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
