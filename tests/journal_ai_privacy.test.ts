import {
  journalReservationAlias,
  sanitizeJournalAiPayload,
} from "../supabase/functions/_shared/journal_ai_privacy.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("reservation aliases continue after Z without collisions", () => {
  assert(journalReservationAlias(0) === "予約客A", "A expected");
  assert(journalReservationAlias(25) === "予約客Z", "Z expected");
  assert(journalReservationAlias(26) === "予約客AA", "AA expected");
  assert(journalReservationAlias(27) === "予約客AB", "AB expected");
});

Deno.test("names stay linkable within one request while direct identifiers are removed", () => {
  const result = sanitizeJournalAiPayload({
    message: "山田太郎さんの前回来店と予約内容を教えて",
    systemInstruction: `- 【予約確定事実】:
  - 明細（氏名・来店日時・回数・内容）:
    - 2026-08-04 19:00 / 山田太郎 / リピート（3回） / 食べログ / 人数 4名 / アレルギー エビ・カニ
    - 2026-08-05 18:00 / 佐藤花子 / 新規（1回） / 一休 / アレルギー 小麦`,
    chatHistory: [
      { role: "user", content: "山田太郎様の電話は090-1234-5678です" },
    ],
    salesData: {
      items: [
        {
          customer_name: "山田太郎",
          customer_phone: "090-1234-5678",
          email: "guest@example.com",
          allergy_label: "エビ・カニ",
        },
      ],
    },
  });
  const serialized = JSON.stringify(result);
  assert(result.aliasCount === 2, `expected two aliases: ${result.aliasCount}`);
  assert(!serialized.includes("山田太郎"), "first real name leaked");
  assert(!serialized.includes("佐藤花子"), "second real name leaked");
  assert(!serialized.includes("090-1234-5678"), "phone leaked");
  assert(!serialized.includes("guest@example.com"), "email leaked");
  assert(!serialized.includes("エビ"), "allergen detail leaked");
  assert(!serialized.includes("小麦"), "second allergen detail leaked");
  assert(serialized.includes("予約客A"), "stable alias A missing");
  assert(serialized.includes("予約客B"), "stable alias B missing");
  assert(serialized.includes("アレルギーあり"), "allergy presence missing");
});

Deno.test("aggregate reservation facts remain unchanged", () => {
  const salesData = {
    reservation_count: 12,
    guest_total: 35,
    new_count: 5,
    repeat_count: 7,
    by_channel: { tabelog: 8, ikyu: 4 },
    allergy_noted_count: 3,
  };
  const result = sanitizeJournalAiPayload({ salesData });
  assert(
    JSON.stringify(result.salesData) === JSON.stringify(salesData),
    "non-personal aggregates must not change",
  );
});

Deno.test("unknown objects redact PII fields without mutating the input", () => {
  const original = {
    customer_name: "鈴木一郎",
    customer_phone: "03-1234-5678",
    allergy: "そば",
    nested: { email_address: "a@b.example" },
  };
  const result = sanitizeJournalAiPayload({ salesData: original });
  const sanitized = result.salesData as Record<string, unknown>;
  assert(original.customer_phone === "03-1234-5678", "input was mutated");
  assert(sanitized.customer_name === "予約客A", "name was not aliased");
  assert(sanitized.customer_phone === null, "phone was not removed");
  assert(sanitized.allergy === "アレルギーあり", "allergy was not minimized");
});
