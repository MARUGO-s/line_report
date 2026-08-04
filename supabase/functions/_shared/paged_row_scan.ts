export type RowWithId = {
  id: unknown;
};

export type AscendingIdPageFetcher<T extends RowWithId> = (
  afterId: number,
  requestedPageSize: number,
) => Promise<readonly T[]>;

export type AscendingIdPageVisitor<T extends RowWithId> = (
  rows: readonly T[],
) => void | Promise<void>;

export type AscendingIdScanOptions = {
  pageSize?: number;
  maxRows?: number;
};

export type AscendingIdScanResult = {
  scannedRows: number;
  scannedPages: number;
  lastId: number;
};

export const ASCENDING_ID_SCAN_DEFAULT_PAGE_SIZE = 500;
export const ASCENDING_ID_SCAN_DEFAULT_MAX_ROWS = 100_000;

function positiveInteger(
  value: unknown,
  fallback: number,
  label: string,
): number {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return n;
}

function rowId(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error("Paged row scan received an invalid id.");
  }
  return n;
}

/**
 * Scan every row using an ascending numeric-id cursor.
 *
 * Important behavior:
 * - Stops only after the backend returns an empty page. A short page is not EOF,
 *   because PostgREST may silently cap rows below the requested page size.
 * - De-duplicates repeated boundary rows by id.
 * - Sorts each received page by id before visiting it.
 * - Fails closed if a non-empty page cannot advance the cursor.
 * - Enforces a configurable safety cap instead of returning partial data.
 */
export async function scanRowsByAscendingId<T extends RowWithId>(
  fetchPage: AscendingIdPageFetcher<T>,
  visitPage: AscendingIdPageVisitor<T>,
  options: AscendingIdScanOptions = {},
): Promise<AscendingIdScanResult> {
  const pageSize = positiveInteger(
    options.pageSize,
    ASCENDING_ID_SCAN_DEFAULT_PAGE_SIZE,
    "pageSize",
  );
  const maxRows = positiveInteger(
    options.maxRows,
    ASCENDING_ID_SCAN_DEFAULT_MAX_ROWS,
    "maxRows",
  );
  let cursor = 0;
  let scannedRows = 0;
  let scannedPages = 0;
  const seen = new Set<number>();

  while (true) {
    const fetched = await fetchPage(cursor, pageSize);
    const rawRows = Array.isArray(fetched) ? [...fetched] : [];
    if (rawRows.length === 0) {
      return {
        scannedRows,
        scannedPages,
        lastId: cursor,
      };
    }

    const ordered = rawRows
      .map((row) => ({ row, id: rowId(row?.id) }))
      .sort((a, b) => a.id - b.id);
    const fresh: T[] = [];
    let maxReceivedId = cursor;
    for (const entry of ordered) {
      if (entry.id > maxReceivedId) maxReceivedId = entry.id;
      if (entry.id <= cursor || seen.has(entry.id)) continue;
      seen.add(entry.id);
      fresh.push(entry.row);
    }
    if (maxReceivedId <= cursor) {
      throw new Error(
        `Paged row scan made no progress after id ${cursor}.`,
      );
    }

    cursor = maxReceivedId;
    if (fresh.length === 0) continue;
    if (scannedRows + fresh.length > maxRows) {
      throw new Error(
        `Paged row scan exceeded the safe row cap (${maxRows}).`,
      );
    }
    await visitPage(fresh);
    scannedRows += fresh.length;
    scannedPages += 1;
  }
}
