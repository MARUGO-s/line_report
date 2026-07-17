import assert from "node:assert/strict";
import test from "node:test";
import {
  isLikelyReservationNotificationMail,
  resolveReservationYear,
} from "../supabase/functions/_shared/reservation_mail_rules.ts";

test("accepts new, modified, and cancelled reservation subjects", () => {
  assert.equal(
    isLikelyReservationNotificationMail(
      "【新規予約】新しい予約が入りました。",
      "7月18日 2名",
      "予約番号: 12345",
    ),
    true,
  );
  assert.equal(
    isLikelyReservationNotificationMail(
      "【変更_現地決済】予約変更受付のお知らせ [予約NO：IR0544995091]",
      "",
      "来店日時: 2026年7月23日 18:30",
    ),
    true,
  );
  assert.equal(
    isLikelyReservationNotificationMail(
      "【予約キャンセル】予約がキャンセルされました。",
      "",
      "予約番号: 65486673",
    ),
    true,
  );
});

test("rejects review replies, promotions, and reservation digests", () => {
  assert.equal(
    isLikelyReservationNotificationMail(
      "【一休.comレストラン】「クチコミ」に対する返信",
      "予約したお客様のクチコミです",
      "ご予約内容と来店日時が引用されています",
    ),
    false,
  );
  assert.equal(
    isLikelyReservationNotificationMail(
      "【一休レストラン】7月開催 一休の日タイムセールのご案内",
      "予約を増やすキャンペーン",
      "コースと来店情報のお知らせ",
    ),
    false,
  );
  assert.equal(
    isLikelyReservationNotificationMail(
      "【Vポイント利用予約まとめ情報】本日、Vポイントのご利用が1件あります。",
      "",
      "予約番号: 12345",
    ),
    false,
  );
});

test("yearless dates use the received date instead of unrelated body years", () => {
  assert.equal(
    resolveReservationYear(null, 7, 10, "2026-07-07T22:18:00.000Z"),
    2026,
  );
  assert.equal(
    resolveReservationYear(null, 1, 5, "2026-12-20T03:00:00.000Z"),
    2027,
  );
  assert.equal(
    resolveReservationYear(2028, 7, 10, "2026-07-07T22:18:00.000Z"),
    2028,
  );
});
