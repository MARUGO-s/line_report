import {
  buildGrokXSearchRequest,
  parseGrokXSearchResponse,
  resolveGrokXSearchWindow,
} from "../supabase/functions/_shared/journal_ai_orchestrate.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("X search window uses JST and includes the requested number of days", () => {
  // 2026-08-04 15:30 UTC = 2026-08-05 00:30 JST
  const window = resolveGrokXSearchWindow(
    new Date("2026-08-04T15:30:00.000Z"),
    30,
  );
  assert(window.to === "2026-08-05", `unexpected to date: ${window.to}`);
  assert(window.from === "2026-07-07", `unexpected from date: ${window.from}`);
  assert(window.lookbackDays === 30, "lookback should be 30");
});

Deno.test("X search lookback is clamped to a safe range", () => {
  const tooLarge = resolveGrokXSearchWindow(
    new Date("2026-08-04T12:00:00.000Z"),
    1000,
  );
  assert(tooLarge.lookbackDays === 90, "lookback should be capped at 90");
  assert(tooLarge.from === "2026-05-07", `unexpected from: ${tooLarge.from}`);

  const invalid = resolveGrokXSearchWindow(
    new Date("2026-08-04T12:00:00.000Z"),
    "invalid",
  );
  assert(invalid.lookbackDays === 30, "invalid lookback should use default");
});

Deno.test("Grok request requires x_search with an explicit date range", () => {
  const request = buildGrokXSearchRequest({
    model: "grok-4.5",
    question: "最新のワイントレンドは？",
    companyHint: "東京のワインバー",
    fromDate: "2026-07-06",
    toDate: "2026-08-04",
    maxToolCalls: 4,
  });
  assert(request.model === "grok-4.5", "model mismatch");
  assert(request.tool_choice === "required", "x_search must be required");
  assert(request.store === false, "search prompt should not be stored");
  assert(request.max_tool_calls === 4, "max tool calls mismatch");
  const tools = request.tools as Array<Record<string, unknown>>;
  assert(tools.length === 1, "only x_search should be available");
  assert(tools[0].type === "x_search", "tool should be x_search");
  assert(tools[0].from_date === "2026-07-06", "from_date mismatch");
  assert(tools[0].to_date === "2026-08-04", "to_date mismatch");
});

Deno.test("Grok response parser keeps text, X-search proof, and deduplicated sources", () => {
  const parsed = parseGrokXSearchResponse({
    citations: [
      "https://x.com/example/status/1",
      "https://x.com/example/status/1",
    ],
    output: [
      { type: "x_search_call", status: "completed" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "投稿文脈付きのトレンド要約",
            annotations: [
              {
                type: "url_citation",
                url: "https://x.com/another/status/2",
              },
            ],
          },
        ],
      },
    ],
  });
  assert(parsed.usedXSearch, "x_search execution should be detected");
  assert(parsed.text === "投稿文脈付きのトレンド要約", "text mismatch");
  assert(parsed.citations.length === 2, "citations should be deduplicated");
  assert(
    parsed.citations.includes("https://x.com/another/status/2"),
    "annotation source should be preserved",
  );
});

Deno.test("Grok response parser prefers the SDK-style top-level output_text", () => {
  const parsed = parseGrokXSearchResponse({
    output_text: "正規化済みの最終回答",
    citations: ["https://x.com/example/status/3"],
    output: [
      { type: "x_search_call", status: "completed" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "低レベル出力",
          },
        ],
      },
    ],
  });
  assert(parsed.usedXSearch, "x_search execution should be detected");
  assert(parsed.text === "正規化済みの最終回答", "output_text should win");
});

Deno.test("Grok response parser rejects legacy chat-completions-shaped data", () => {
  const parsed = parseGrokXSearchResponse({
    choices: [{ message: { content: "検索したふりの回答" } }],
  });
  assert(!parsed.usedXSearch, "legacy response must not prove X search");
  assert(parsed.text === "", "legacy text must not be accepted");
});
