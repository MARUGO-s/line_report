import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// 動作確認用
app.get("/", (req, res) => {
  res.send("✅ Server is running!");
});

// Supabase から会社規約を取得するAPI
app.get("/rules", async (req, res) => {
  const { data, error } = await supabase.from("company_rules").select("*");
  if (error) {
    console.error("❌ Supabase Error:", error);
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});

