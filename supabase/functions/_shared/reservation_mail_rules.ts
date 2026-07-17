const RESERVATION_TRANSACTION_SUBJECT_RE =
  /(?:新規[^\n]{0,12}予約|予約[^\n]{0,18}(?:受付|成立|確定|変更|キャンセル|取消|取り消し)|(?:変更|キャンセル|取消|取り消し)[^\n]{0,12}予約|new\s+reservation|reservation[^\n]{0,18}(?:confirmed|updated|cancelled|canceled))/i;

const NON_RESERVATION_SUBJECT_RE =
  /(?:(?:クチコミ|口コミ|レビュー)[^\n]{0,24}(?:返信|回答|投稿|お知らせ)|(?:返信|回答)[^\n]{0,24}(?:クチコミ|口コミ|レビュー)|タイムセール|キャンペーン|メルマガ|販促|広告|アンケート)/i;

const RESERVATION_DIGEST_RE =
  /(本日のご来店一覧|ネット予約一覧|時点の予約一覧|ご来店予定の|食べログネット予約一覧|まとめ情報|Vポイント利用予約まとめ|本日のVポイント利用|お値引きをお願い)/i;

function normalizeInlineText(raw: string): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

export function isLikelyReservationNotificationMail(
  subject: string,
  snippet: string,
  bodyText: string,
): boolean {
  const normalizedSubject = normalizeInlineText(subject);
  const compact = normalizeInlineText(`${subject} ${snippet} ${bodyText}`)
    .toLowerCase();
  if (!compact) return false;

  const hasTransactionSubject = RESERVATION_TRANSACTION_SUBJECT_RE.test(
    normalizedSubject,
  );
  if (
    NON_RESERVATION_SUBJECT_RE.test(normalizedSubject) &&
    !hasTransactionSubject
  ) {
    return false;
  }

  // Daily lists and point-use digests describe multiple reservations and must
  // never become a single calendar event.
  if (RESERVATION_DIGEST_RE.test(compact)) return false;

  const hasReservationCue =
    /(予約|来店|人数|コース|予約番号|ご予約|reservation|booking)/i.test(
      compact,
    );
  if (!hasReservationCue) return false;

  const hasNonReservationCue =
    /(セキュリティ|security|ログイン|signin|パスワード|password|認証|verification|本人確認|地図に表示|google\s*マップ|口コミ|クチコミ|レビュー|お知らせ|ニュース|メルマガ|広告|プロモーション)/i
      .test(compact);
  if (
    hasNonReservationCue &&
    !hasTransactionSubject &&
    !/(予約番号|来店日時|ご予約内容|予約内容|人数)/i.test(compact)
  ) return false;

  return true;
}

// Resolve a reservation year from the email receipt date. A year found
// elsewhere in the email body is deliberately ignored because footers and
// reservation history can contain unrelated years.
export function resolveReservationYear(
  rawYear: number | null,
  month: number,
  day: number,
  receivedIso: string | null,
  now = new Date(),
): number {
  const base = receivedIso ? new Date(receivedIso) : now;
  const safeBase = Number.isNaN(base.getTime()) ? now : base;
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(safeBase);
  const pick = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "");
  const baseYear = pick("year");
  const baseMd = pick("month") * 100 + pick("day");

  if (
    rawYear != null && Number.isInteger(rawYear) &&
    rawYear >= baseYear - 1 && rawYear <= baseYear + 2
  ) {
    return rawYear;
  }

  return month * 100 + day >= baseMd ? baseYear : baseYear + 1;
}
