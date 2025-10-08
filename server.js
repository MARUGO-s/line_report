import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;
    if (!events || events.length === 0) {
      return res.status(200).send("No events");
    }

    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const replyToken = event.replyToken;
        const userMessage = event.message.text;

        const replyMessage = {
          replyToken: replyToken,
          messages: [
            {
              type: "text",
              text: `受け取りました: ${userMessage}`,
            },
          ],
        };

        console.log("Sending reply message:", JSON.stringify(replyMessage, null, 2));
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
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Error handling webhook:", error);
    res.status(500).send("Error");
  }
});

app.get("/", (req, res) => {
  res.send("✅ Server is running and ready for LINE webhook!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});