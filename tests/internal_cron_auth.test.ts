import assert from "node:assert/strict"
import test from "node:test"
import {
  constantTimeEqualSecret,
  extractBearerToken,
  isInternalCronAuthorized,
  type CronAuthRpcClient,
} from "../supabase/functions/_shared/internal_cron_auth.ts"

function rpcClient(data: unknown, error: { message: string } | null = null): CronAuthRpcClient {
  return { rpc: async () => ({ data, error }) }
}

test("internal cron auth requires a correctly formatted Bearer secret", async () => {
  assert.equal(extractBearerToken(new Request("https://example.test")), "")
  assert.equal(extractBearerToken(new Request("https://example.test", {
    headers: { Authorization: "Basic abc" },
  })), "")
  assert.equal(await isInternalCronAuthorized(
    new Request("https://example.test"), rpcClient("vault-secret"), { edgeToken: "edge-secret" },
  ), false)
})

test("internal cron auth accepts only exact Edge or Vault secrets", async () => {
  const withBearer = (value: string) => new Request("https://example.test", {
    headers: { Authorization: `Bearer ${value}` },
  })
  assert.equal(await isInternalCronAuthorized(withBearer("edge-secret"), rpcClient(null), {
    edgeToken: "edge-secret",
  }), true)
  assert.equal(await isInternalCronAuthorized(withBearer("vault-secret"), rpcClient("vault-secret"), {
    edgeToken: "",
  }), true)
  assert.equal(await isInternalCronAuthorized(withBearer("vault-secret-extra"), rpcClient("vault-secret"), {
    edgeToken: "",
  }), false)
  assert.equal(constantTimeEqualSecret("same", "same"), true)
  assert.equal(constantTimeEqualSecret("same", "diff"), false)
})

test("internal cron auth fails closed on blank Vault values and RPC failures", async () => {
  const req = new Request("https://example.test", {
    headers: { Authorization: "Bearer public-anon-value" },
  })
  assert.equal(await isInternalCronAuthorized(req, rpcClient(null), { edgeToken: "" }), false)
  assert.equal(await isInternalCronAuthorized(req, rpcClient("", { message: "denied" }), { edgeToken: "" }), false)
  const throwing: CronAuthRpcClient = { rpc: async () => { throw new Error("offline") } }
  assert.equal(await isInternalCronAuthorized(req, throwing, { edgeToken: "" }), false)
})
