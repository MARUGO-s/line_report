import {
  actorFromAuth,
  classifyAdminAccess,
} from "../supabase/functions/_shared/admin_access_log.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertEquals failed\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}

Deno.test("classifies login, mutations, and noisy GETs", () => {
  assertEquals(classifyAdminAccess("POST", "/auth/session").action, "login");
  assertEquals(classifyAdminAccess("POST", "/auth/logout").action, "logout");
  assertEquals(classifyAdminAccess("POST", "/pos-journals/upload").action, "upload");
  assertEquals(classifyAdminAccess("DELETE", "/pos-journals/file").action, "delete");
  assertEquals(classifyAdminAccess("POST", "/pos-journals/ai-analysis").action, "ai");
  assertEquals(classifyAdminAccess("GET", "/pos-journals").action, "read");
  assertEquals(classifyAdminAccess("GET", "/pos-journals").skip, false);
  assertEquals(classifyAdminAccess("GET", "/state").skip, true);
  assertEquals(classifyAdminAccess("GET", "/access/events").skip, true);
  assertEquals(classifyAdminAccess("POST", "/access/events").skip, true);
  assertEquals(classifyAdminAccess("GET", "/weather/daily").skip, true);
});

Deno.test("actor labels distinguish HQ and store links", () => {
  assertEquals(actorFromAuth({}).actorLabel, "本部");
  assertEquals(actorFromAuth({ storeScope: "bistrocavacava" }).actorKind, "store_link");
  assertEquals(actorFromAuth({ lineUserId: "U123", actorLabel: "山田" }).actorKind, "line_session");
});
