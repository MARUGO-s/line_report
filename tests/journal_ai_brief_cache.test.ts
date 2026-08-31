import {
  externalBriefCacheKey,
  gatherExternalBriefs,
} from "../supabase/functions/_shared/journal_ai_orchestrate.ts";
import { assertEquals } from "jsr:@std/assert@1";

Deno.test("cache key ignores spacing and case but not store/day/intent", () => {
  const base = { storeKey: "marugos", question: "2026年の戦略", intent: "strategy" as const, day: "2026-09-01" };
  assertEquals(
    externalBriefCacheKey(base),
    externalBriefCacheKey({ ...base, question: "  2026年の戦略  " }),
  );
  const diff = [
    externalBriefCacheKey({ ...base, storeKey: "bistrocavacava" }),
    externalBriefCacheKey({ ...base, day: "2026-09-02" }),
    externalBriefCacheKey({ ...base, intent: "mixed" as const }),
  ];
  for (const k of diff) assertEquals(k === externalBriefCacheKey(base), false);
});

Deno.test("cached briefs are reused and external providers are not called again", async () => {
  const store = new Map<string, unknown>();
  const cache = {
    get: (k: string) => Promise.resolve((store.get(k) ?? null) as never),
    set: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
  };
  const key = "k1";
  store.set(key, [{ provider: "grok", ok: true, text: "cached trend" }]);
  const briefs = await gatherExternalBriefs("q", "hint", "strategy", { store: cache as never, key });
  assertEquals(briefs.length, 1);
  assertEquals(briefs[0].text, "cached trend");
});

Deno.test("all-failed cache entries are not reused", async () => {
  const store = new Map<string, unknown>();
  store.set("k2", [{ provider: "grok", ok: false, text: "", error: "boom" }]);
  const cache = {
    get: (k: string) => Promise.resolve((store.get(k) ?? null) as never),
    set: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
  };
  // 失敗だけのキャッシュは無視して取得しなおす。
  // 再取得なら provider 2件(perplexity/grok)が返る。キャッシュを流用すると
  // 保存した1件だけが返るので、件数で両者を判別できる。
  const briefs = await gatherExternalBriefs("q", "hint", "strategy", { store: cache as never, key: "k2" });
  assertEquals(briefs.length, 2, "failed-only cache must be refetched, not reused");
  assertEquals(briefs.map((b) => b.provider).sort(), ["grok", "perplexity"]);
});

Deno.test("data intent never touches the cache", async () => {
  let touched = false;
  const cache = {
    get: () => { touched = true; return Promise.resolve(null); },
    set: () => { touched = true; return Promise.resolve(); },
  };
  const briefs = await gatherExternalBriefs("q", "hint", "data", { store: cache as never, key: "k3" });
  assertEquals(briefs, []);
  assertEquals(touched, false);
});
