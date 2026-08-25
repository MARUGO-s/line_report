import assert from "node:assert/strict"
import test from "node:test"
import {
  isJournalTrigger,
  parseJournalQuestion,
} from "../supabase/functions/_shared/mtalk_search.ts"

test("ジャーナル検索の合図を拾う", () => {
  for (
    const t of [
      "srch=jnl",
      "ジャーナル検索",
      "電子ジャーナル検索",
      "ジャーナルに聞く",
      "電子ジャーナルに聞く",
      "売上分析",
      " ジャーナル検索 ",
    ]
  ) {
    assert.equal(isJournalTrigger(t), true, t)
  }
})

test("他の検索コマンドや雑談を合図にしない", () => {
  for (const t of ["売上検索", "予定検索", "メディア検索", "こんにちは", ""]) {
    assert.equal(isJournalTrigger(t), false, t)
  }
})

test("月6桁と質問に割る", () => {
  assert.deepEqual(parseJournalQuestion("202608 前年より伸びた商品は？"), {
    month: "2026-08",
    question: "前年より伸びた商品は？",
  })
  // 空白なしでも割れる
  assert.deepEqual(parseJournalQuestion("202601客単価は"), {
    month: "2026-01",
    question: "客単価は",
  })
  // 複数行の質問も落とさない
  assert.equal(parseJournalQuestion("202608 A\nB")?.question, "A\nB")
})

test("月が不正、または質問が無いものは弾く", () => {
  assert.equal(parseJournalQuestion("202608"), null, "質問なし")
  assert.equal(parseJournalQuestion("202608   "), null, "質問が空白のみ")
  assert.equal(parseJournalQuestion("20260 質問"), null, "5桁")
  assert.equal(parseJournalQuestion("202613 質問"), null, "13月")
  assert.equal(parseJournalQuestion("202600 質問"), null, "0月")
  assert.equal(parseJournalQuestion("前年より伸びた商品は？"), null, "月なし")
})
