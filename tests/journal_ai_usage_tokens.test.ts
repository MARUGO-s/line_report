// ai-analyze/index.ts は読み込むと Deno.serve が走ってしまうため、必要な関数だけ
// ソースから切り出して評価する。実際の実装をそのまま動かして検証する。
import { assertEquals } from "jsr:@std/assert@1";

const SOURCE = new URL(
  "../supabase/functions/ai-analyze/index.ts",
  import.meta.url,
);

/** `function name(` から対応する閉じ括弧までを取り出す。 */
function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  const open = source.indexOf("{", start);
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced`);
}

const source = await Deno.readTextFile(SOURCE);
const moduleText = [
  sliceFunction(source, "isRecord"),
  sliceFunction(source, "extractOpenAiUsage"),
  sliceFunction(source, "extractClaudeUsage"),
  "export { extractOpenAiUsage, extractClaudeUsage };",
]
  // 切り出した断片は型名を参照するので、注釈だけ any へ寄せて評価可能にする。
  .join("\n")
  .replace(/: JournalAiUsage \| null/g, ": any");

const mod = await import(
  `data:text/typescript,${encodeURIComponent(moduleText)}`
);

// xAI(OpenAI互換)の実応答から採取した形。OpenAI も同じ項目名を返す。
const OPENAI_USAGE = {
  usage: {
    prompt_tokens: 496,
    completion_tokens: 1,
    total_tokens: 518,
    prompt_tokens_details: { text_tokens: 496, cached_tokens: 384 },
    completion_tokens_details: { reasoning_tokens: 21 },
  },
};

Deno.test("OpenAI usage keeps cached and reasoning tokens", () => {
  const usage = mod.extractOpenAiUsage(OPENAI_USAGE, "gpt-5.6-luna");
  assertEquals(usage.inputTokens, 496);
  assertEquals(usage.outputTokens, 1);
  assertEquals(usage.totalTokens, 518);
  // prefill がどれだけ短縮されたかの指標。落とすと速度改善の判断ができない。
  assertEquals(usage.cachedTokens, 384);
  // 推論モデルの実時間を説明する値。completion_tokens とは別枠で返る。
  assertEquals(usage.thinkingTokens, 21);
});

Deno.test("missing detail blocks stay null instead of becoming zero", () => {
  // 0 と「取れなかった」を混同すると、キャッシュ未使用と計測不能を区別できない。
  const usage = mod.extractOpenAiUsage({
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }, "gpt-4.1-mini");
  assertEquals(usage.cachedTokens, null);
  assertEquals(usage.thinkingTokens, null);
});

Deno.test("Claude usage keeps its cache read counter", () => {
  const usage = mod.extractClaudeUsage({
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: 900,
    },
  }, "claude-haiku-4-5");
  assertEquals(usage.inputTokens, 1200);
  assertEquals(usage.outputTokens, 300);
  assertEquals(usage.cachedTokens, 900);
});

Deno.test("empty usage is still rejected", () => {
  assertEquals(mod.extractOpenAiUsage({}, "m"), null);
  assertEquals(mod.extractClaudeUsage({ usage: {} }, "m"), null);
});
