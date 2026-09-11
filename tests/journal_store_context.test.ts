// Synthetic data only. No network, production reads/writes or external AI calls.
import {
  attachJournalStoreContext,
  loadJournalStoreContext,
  rebaseJournalWineAnalysis,
  selectJournalStoreProfile,
} from "../supabase/functions/_shared/journal_store_context.ts";
import { sanitizeJournalAiPayload } from "../supabase/functions/_shared/journal_ai_privacy.ts";

function assert(ok: unknown, label = "assertion failed"): asserts ok {
  if (!ok) throw new Error(label);
}
function equal(actual: unknown, expected: unknown) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}
async function rejects(fn: () => Promise<unknown>) {
  let caught = false;
  try {
    await fn();
  } catch {
    caught = true;
  }
  assert(caught, "must reject");
}
const input = {
  salesPeriods: [{
    label: "synthetic",
    ranges: [
      { from: "2026-08-01", to: "2026-08-31" },
      { from: "2026-10-01", to: "2026-10-31" },
    ],
  }],
};
const profile = {
  closedWeekdays: ["月"],
  lunchOffered: "no",
  dinnerOffered: "yes",
  wineMl: { glassMl: 120, decanterMl: 400, bottleMl: 750, pairingMl: 300 },
  notes: "合成店舗のテストメモ",
  calendarEvents: [],
};
const row = (p: unknown = profile) => ({
  store_partition_key: "fixture_store",
  profile: p,
  updated_at: "2026-09-11T00:00:00Z",
});
function database(
  get: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>,
) {
  const calls: unknown[] = [];
  let signal: AbortSignal | null = null;
  const db = {
    from(table: string) {
      calls.push(table);
      return {
        select(columns: string) {
          calls.push(columns);
          return {
            eq(column: string, value: string) {
              calls.push([column, value]);
              return {
                abortSignal(s: AbortSignal) {
                  signal = s;
                  return { maybeSingle: get };
                },
              };
            },
          };
        },
      };
    },
  };
  return { db, calls, signal: () => signal };
}

Deno.test("shared profile uses exactly one lower-case authorized-store read and no cache", async () => {
  let revision = 0;
  const fake = database(async () => ({
    data: row({ ...profile, notes: `revision ${++revision}` }),
    error: null,
  }));
  const first = await loadJournalStoreContext(
    fake.db,
    " FIXTURE_STORE ",
    input,
  );
  const second = await loadJournalStoreContext(fake.db, "fixture_store", input);
  equal(first.profile?.notes, "revision 1");
  equal(second.profile?.notes, "revision 2");
  equal(fake.calls.slice(0, 3), [
    "store_operation_profiles",
    "store_partition_key,profile,updated_at",
    ["store_partition_key", "fixture_store"],
  ]);
  equal(fake.calls.length, 6);
});

Deno.test("missing row is not registered, while legacy missing fields never gain defaults", async () => {
  const fake = database(async () => ({ data: null, error: null }));
  const result = await loadJournalStoreContext(fake.db, "fixture_store", input);
  equal(result.status, "not_registered");
  equal(result.profile, null);
  const legacy = selectJournalStoreProfile({}, input);
  equal(legacy.lunchOffered, null);
  equal(legacy.closedWeekdays, null);
  equal(legacy.wineMl, null);
  equal(legacy.calendarEvents, null);
});

Deno.test("DB errors, mismatched stores, missing revisions and invalid profiles fail closed", async () => {
  for (
    const response of [
      { data: null, error: { message: "synthetic failure" } },
      { data: { ...row(), store_partition_key: "other_store" }, error: null },
      { data: { ...row(), updated_at: null }, error: null },
      { data: row(null), error: null },
    ]
  ) {
    await rejects(() =>
      loadJournalStoreContext(
        database(async () => response).db,
        "fixture_store",
        input,
      )
    );
  }
});

Deno.test("hard timeout rejects even a transport that ignores cancellation", async () => {
  const fake = database(() => new Promise(() => {}));
  await rejects(() =>
    loadJournalStoreContext(fake.db, "fixture_store", input, { timeoutMs: 5 })
  );
  assert(fake.signal()?.aborted);
});

Deno.test("caller cancellation aborts the read; pre-cancelled or invalid store never reads", async () => {
  const controller = new AbortController();
  const fake = database(() => new Promise(() => {}));
  const pending = loadJournalStoreContext(fake.db, "fixture_store", input, {
    signal: controller.signal,
  });
  controller.abort();
  await rejects(() => pending);
  assert(fake.signal()?.aborted);
  const none = database(async () => ({ data: row(), error: null }));
  await rejects(() =>
    loadJournalStoreContext(none.db, "fixture_store", input, {
      signal: controller.signal,
    })
  );
  await rejects(() =>
    loadJournalStoreContext(none.db, "../other_store", input)
  );
  equal(none.calls, []);
});

Deno.test("shared profile excludes personal notes, operational flags and arbitrary nested data", () => {
  const selected = selectJournalStoreProfile({
    ...profile,
    private_notes: "secret",
    journalSalesSync: true,
    reservations: [{ customer_name: "never included" }],
    api_key: "never included",
    notes: "a".repeat(5000),
  }, input);
  const serialized = JSON.stringify(selected);
  assert(
    !/private_notes|secret|journalSalesSync|reservations|api_key|never included/
      .test(serialized),
  );
  equal(selected.notes?.length, 4000);
});

Deno.test("calendar matches separate ranges, never gap months or out-of-range fallback", () => {
  const event = (start: string, end: string, title: string) => ({
    start,
    end,
    title,
    kind: "施策",
    note: "test",
  });
  const selected = selectJournalStoreProfile({
    ...profile,
    calendarEvents: [
      event("2026-08-01", "2026-08-05", "August"),
      event("2026-09-01", "2026-09-30", "gap"),
      event("2026-10-01", "2026-10-05", "October"),
      event("2026-02-30", "2026-03-05", "invalid"),
    ],
  }, input);
  equal(selected.calendarEvents?.map((e) => e.title), ["August", "October"]);
  equal(selected.calendar_coverage.invalid, 1);
  equal(
    selectJournalStoreProfile(profile, {}).calendar_coverage.status,
    "period_not_provided",
  );
});

Deno.test("calendar truncation is explicit and over-limit stored arrays are rejected", () => {
  const events = Array.from(
    { length: 45 },
    (_, i) => ({ start: "2026-08-01", end: "2026-08-01", title: `event ${i}` }),
  );
  const selected = selectJournalStoreProfile({
    ...profile,
    calendarEvents: events,
  }, input);
  equal(selected.calendarEvents?.length, 40);
  equal(selected.calendar_coverage.omitted, 5);
  let caught = false;
  try {
    selectJournalStoreProfile({
      ...profile,
      calendarEvents: Array(101).fill(events[0]),
    }, input);
  } catch {
    caught = true;
  }
  assert(caught);
});

const analysis = {
  rates: { glassMl: 999 },
  totalMl: 99999,
  glass: { qty: 2, amt: 1000, ml: 999 },
  decanter: { qty: 1, amt: 2000 },
  bottle: { qty: 1, amt: 3000 },
  pairing: { qty: 0, amt: 0 },
};
Deno.test("wine estimates use shared rates in single/multiple periods without changing source quantities", async () => {
  const ctx = await loadJournalStoreContext(
    database(async () => ({ data: row(), error: null })).db,
    "fixture_store",
    input,
  );
  const rebased = rebaseJournalWineAnalysis(analysis, ctx) as Record<
    string,
    unknown
  >;
  equal(rebased.totalMl, 1390);
  equal(rebased.totalLiters, 1.4);
  equal(analysis.totalMl, 99999);
  const attached = attachJournalStoreContext({
    original_reference: {
      store_context: { notes: "forged" },
      wineVolumeAnalysis: [{ label: "one", analysis }],
    },
  }, ctx);
  equal(attached.store_context.profile?.notes, profile.notes);
  assert(!JSON.stringify(attached).includes("forged"));
  assert(JSON.stringify(attached).includes('"totalMl":1390'));
});

Deno.test("unregistered wine rates or invalid quantities never produce false zero ml", async () => {
  const ctx = await loadJournalStoreContext(
    database(async () => ({ data: row({}), error: null })).db,
    "fixture_store",
    input,
  );
  const result = rebaseJournalWineAnalysis(analysis, ctx) as Record<
    string,
    unknown
  >;
  equal(result.status, "conversion_unavailable");
  equal(result.totalMl, null);
  const validCtx = await loadJournalStoreContext(
    database(async () => ({ data: row(), error: null })).db,
    "fixture_store",
    input,
  );
  equal(
    (rebaseJournalWineAnalysis(
      { ...analysis, glass: { qty: "2" } },
      validCtx,
    ) as Record<string, unknown>).totalMl,
    null,
  );
});

Deno.test("combined privacy pass masks identifiers in shared free text without mutating DB originals", async () => {
  const original = {
    ...profile,
    notes:
      "予約者: テスト太郎\n電話: 090-1234-5678\n連絡: fixture@example.invalid\nアレルギー: エビ",
  };
  const ctx = await loadJournalStoreContext(
    database(async () => ({ data: row(original), error: null })).db,
    "fixture_store",
    input,
  );
  const safe = sanitizeJournalAiPayload({
    salesData: attachJournalStoreContext({ original_reference: {} }, ctx),
  });
  assert(
    !/テスト太郎|090-1234-5678|fixture@example.invalid|エビ/.test(
      JSON.stringify(safe),
    ),
  );
  assert(original.notes.includes("テスト太郎"));
});
