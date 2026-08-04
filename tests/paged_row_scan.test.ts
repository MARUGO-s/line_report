import {
  type RowWithId,
  scanRowsByAscendingId,
} from "../supabase/functions/_shared/paged_row_scan.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  }
}

Deno.test("ascending id scan reads every row beyond the backend 1000-row cap", async () => {
  const source = Array.from({ length: 2505 }, (_, index) => ({
    id: index + 1,
    value: `row-${index + 1}`,
  }));
  const visited: number[] = [];
  const requestedCursors: number[] = [];
  const result = await scanRowsByAscendingId(
    (afterId, requestedPageSize) => {
      requestedCursors.push(afterId);
      // Simulate a backend that silently returns at most 333 rows, even though
      // the client requests a larger page.
      return Promise.resolve(
        source
          .filter((row) => row.id > afterId)
          .slice(0, Math.min(requestedPageSize, 333)),
      );
    },
    (rows) => {
      visited.push(...rows.map((row) => Number(row.id)));
    },
    { pageSize: 500, maxRows: 3000 },
  );

  assertEquals(visited.length, 2505);
  assertEquals(visited[0], 1);
  assertEquals(visited.at(-1), 2505);
  assertEquals(new Set(visited).size, 2505);
  assertEquals(result.scannedRows, 2505);
  assertEquals(result.lastId, 2505);
  assert(requestedCursors.length > 6, "short pages must not be treated as EOF");
  assertEquals(
    requestedCursors.at(-1),
    2505,
    "the final empty-page request uses the last cursor",
  );
});

Deno.test("ascending id scan sorts pages and de-duplicates repeated boundary rows", async () => {
  const pages: Record<number, RowWithId[]> = {
    0: [{ id: 3 }, { id: 1 }, { id: 2 }],
    3: [{ id: 3 }, { id: 5 }, { id: 4 }],
    5: [],
  };
  const visited: number[] = [];
  const result = await scanRowsByAscendingId(
    (afterId) => Promise.resolve(pages[afterId] || []),
    (rows) => {
      visited.push(...rows.map((row) => Number(row.id)));
    },
  );
  assertEquals(visited, [1, 2, 3, 4, 5]);
  assertEquals(result.scannedRows, 5);
  assertEquals(result.scannedPages, 2);
});

Deno.test("ascending id scan requires an empty page after an exact page-size boundary", async () => {
  const calls: number[] = [];
  const result = await scanRowsByAscendingId(
    (afterId, pageSize) => {
      calls.push(afterId);
      const rows = Array.from({ length: pageSize }, (_, index) => ({
        id: afterId + index + 1,
      }));
      return Promise.resolve(afterId >= pageSize ? [] : rows);
    },
    () => {},
    { pageSize: 4, maxRows: 10 },
  );
  assertEquals(calls, [0, 4]);
  assertEquals(result.scannedRows, 4);
});

Deno.test("ascending id scan fails closed on invalid ids, no progress, and cap overflow", async () => {
  await assertRejects(
    () =>
      scanRowsByAscendingId(
        () => Promise.resolve([{ id: "not-an-id" }]),
        () => {},
      ),
    "invalid id",
  );
  await assertRejects(
    () =>
      scanRowsByAscendingId(
        () => Promise.resolve([{ id: 1 }]),
        () => {},
        { pageSize: 2, maxRows: 10 },
      ),
    "made no progress",
  );
  await assertRejects(
    () =>
      scanRowsByAscendingId(
        (afterId) =>
          Promise.resolve(
            afterId === 0
              ? [{ id: 1 }, { id: 2 }]
              : (afterId === 2 ? [{ id: 3 }, { id: 4 }] : []),
          ),
        () => {},
        { pageSize: 2, maxRows: 3 },
      ),
    "safe row cap",
  );
});

Deno.test("ascending id scan propagates fetch and visitor failures without returning partial success", async () => {
  await assertRejects(
    () =>
      scanRowsByAscendingId(
        () => Promise.reject(new Error("fetch failed")),
        () => {},
      ),
    "fetch failed",
  );
  await assertRejects(
    () =>
      scanRowsByAscendingId(
        (afterId) => Promise.resolve(afterId === 0 ? [{ id: 1 }] : []),
        () => {
          throw new Error("visitor failed");
        },
      ),
    "visitor failed",
  );
});

async function assertRejects(
  fn: () => Promise<unknown>,
  expectedMessage: string,
) {
  let thrown: unknown = null;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof Error,
    `expected rejection containing "${expectedMessage}"`,
  );
  assert(
    thrown.message.includes(expectedMessage),
    `expected "${thrown.message}" to contain "${expectedMessage}"`,
  );
}
