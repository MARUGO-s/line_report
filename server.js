// server.js  （CommonJS 版）

const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

// LINE Webhook エンドポイント
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [];

    // イベントが無ければ 200 を即返す（LINE には 200 を返せばOK）
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(200).send("OK");
    }

    // 受信イベントを順に処理
    for (const event of events) {
      // テキストメッセージにだけ返信
      if (event.type === "message" && event.message && event.message.type === "text") {
        const replyToken = event.replyToken;
        const userMessage = event.message.text;

        const replyPayload = {
          replyToken,
          messages: [
            {
              type: "text",
              text: `受け取りました: ${userMessage}`,
            },
          ],
        };

        // LINE Messaging API: reply
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
          body: JSON.stringify(replyPayload),
        });
      }
    }

    // 処理が終わったら 200
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Error handling webhook:", error);
    return res.status(500).send("Error");
  }
});

// ヘルスチェック（Render/ブラウザ確認用）
app.get("/", (_req, res) => {
  res.send("✅ Server is running and ready for LINE webhook!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
