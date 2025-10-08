import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// LINE Webhook エンドポイント
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;

    if (!events || events.length === 0) {
      return res.status(200).send("No events");
    }

    // メッセージを取得
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const replyToken = event.replyToken;
        const userMessage = event.message.text;

        // 返信メッセージを生成
        const replyMessage = {
          replyToken: replyToken,
          messages: [
            {
              type: "text",
              text: `受け取りました：「${userMessage}」`,
            },
          ],
        };

        // LINE Messaging APIに返信
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
          body: JSON.stringify(replyMessage),
        });
      }
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Error handling webhook:", error);
    return res.status(500).send("Error");
  }
});

// 動作確認用ルート
app.get("/", (req, res) => {
  res.send("✅ Server is running and ready for LINE webhook!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
