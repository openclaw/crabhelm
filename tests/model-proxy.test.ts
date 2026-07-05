import assert from "node:assert/strict";
import test from "node:test";
import { signClaims, verifyClaims } from "../worker/security.js";
import {
  handleModelProxy,
  modelCredentialEntries,
  type ModelProxyEnv,
  modelProxyEnabled,
  modelProxyReady,
} from "../worker/model-proxy.js";
import type { ModelClaims } from "../src/governance-types.js";

const SECRET = ["model-signing", "test-fixture", "long-enough-32b"].join("-");
const RAW_KEY = "sk-real-provider-key";

function baseEnv(overrides: Partial<ModelProxyEnv> = {}): ModelProxyEnv {
  return {
    CRABHELM_MODEL_PROXY: "on",
    MODEL_SIGNING_SECRET: SECRET,
    OPENAI_API_KEY: RAW_KEY,
    RUNTIME_URL: "https://crabhelm-runtime.openclaw.ai",
    ...overrides,
  };
}

function mintToken(clawId = "685b2bda-351e-450b-a91c-45938c54454f"): Promise<string> {
  return signClaims<ModelClaims>(SECRET, { typ: "model", aud: "crabhelm-model", clawId }, 3_600);
}

function request(path: string, init: RequestInit = {}): { req: Request; url: URL } {
  const url = new URL(`https://crabhelm-runtime.openclaw.ai${path}`);
  return { req: new Request(url, init), url };
}

async function withStubbedFetch<T>(
  stub: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
  run: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return stub(input, init);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("model proxy readiness gates on flag, secret, and provider key", () => {
  assert.equal(modelProxyEnabled(baseEnv()), true);
  assert.equal(modelProxyEnabled(baseEnv({ CRABHELM_MODEL_PROXY: "off" })), false);
  assert.equal(modelProxyReady(baseEnv()), true);
  assert.equal(modelProxyReady(baseEnv({ MODEL_SIGNING_SECRET: "short" })), false);
  assert.equal(modelProxyReady(baseEnv({ OPENAI_API_KEY: "" })), false);
  assert.equal(modelProxyReady(baseEnv({ CRABHELM_MODEL_PROXY: "off" })), false);
});

test("model proxy returns 503 until it is configured", async () => {
  const { req, url } = request("/model/v1/chat/completions", { method: "POST" });
  const response = await handleModelProxy(req, baseEnv({ MODEL_SIGNING_SECRET: undefined }), url);
  assert.equal(response.status, 503);
});

test("model proxy serves already-issued tokens while new issuance is off", async () => {
  const token = await mintToken();
  const { req, url } = request("/model/v1/models", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  const response = await withStubbedFetch(
    async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    async () => handleModelProxy(req, baseEnv({ CRABHELM_MODEL_PROXY: "off" }), url),
  );
  assert.equal(response.status, 200);
});

test("model proxy rejects a missing or invalid token", async () => {
  const missing = request("/model/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal((await handleModelProxy(missing.req, baseEnv(), missing.url)).status, 401);

  const bad = request("/model/v1/chat/completions", {
    method: "POST",
    body: "{}",
    headers: { authorization: "Bearer not-a-real-token" },
  });
  assert.equal((await handleModelProxy(bad.req, baseEnv(), bad.url)).status, 401);

  const wrongSecret = await signClaims<ModelClaims>(
    "another-signing-secret-also-long-enough-32b",
    { typ: "model", aud: "crabhelm-model", clawId: "c" }, 3_600,
  );
  const forged = request("/model/v1/chat/completions", {
    method: "POST",
    body: "{}",
    headers: { authorization: `Bearer ${wrongSecret}` },
  });
  assert.equal((await handleModelProxy(forged.req, baseEnv(), forged.url)).status, 401);
});

test("model proxy allowlists routes and methods", async () => {
  const token = await mintToken();
  const auth = { authorization: `Bearer ${token}` };

  const badPath = request("/model/v1/moderations", { method: "POST", body: "{}", headers: auth });
  assert.equal((await handleModelProxy(badPath.req, baseEnv(), badPath.url)).status, 404);

  const traversal = request("/model/v1/../../secret", { method: "POST", body: "{}", headers: auth });
  assert.equal((await handleModelProxy(traversal.req, baseEnv(), traversal.url)).status, 404);

  const wrongMethod = request("/model/v1/chat/completions", { method: "GET", headers: auth });
  assert.equal((await handleModelProxy(wrongMethod.req, baseEnv(), wrongMethod.url)).status, 405);

  const query = request("/model/v1/chat/completions?inject=1", { method: "POST", body: "{}", headers: auth });
  assert.equal((await handleModelProxy(query.req, baseEnv(), query.url)).status, 400);
});

test("model proxy injects the real key, forwards to the fixed upstream, and strips client auth", async () => {
  const token = await mintToken("claw-42");
  const { req, url } = request("/model/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.5", messages: [] }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
  });

  const response = await withStubbedFetch(
    async () => new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    async (calls) => {
      const result = await handleModelProxy(req, baseEnv(), url);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
      const sent = new Headers(calls[0]!.init!.headers as HeadersInit);
      assert.equal(sent.get("authorization"), `Bearer ${RAW_KEY}`);
      assert.equal(sent.get("content-type"), "application/json");
      assert.equal(sent.get("accept"), "text/event-stream");
      assert.equal(sent.get("x-crabhelm-claw"), "claw-42");
      return result;
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), "data: {}\n\n");
});

test("model proxy never lets the caller redirect the upstream host", async () => {
  const token = await mintToken();
  // Even with an attacker-style path the resolved upstream is api.openai.com.
  const { req, url } = request("/model/v1/models", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  await withStubbedFetch(
    async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    async (calls) => {
      await handleModelProxy(req, baseEnv(), url);
      assert.equal(calls[0]!.url, "https://api.openai.com/v1/models");
      assert.equal(new URL(calls[0]!.url).host, "api.openai.com");
    },
  );
});

test("model proxy surfaces an unreachable upstream as 502", async () => {
  const token = await mintToken();
  const { req, url } = request("/model/v1/chat/completions", {
    method: "POST",
    body: "{}",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const response = await withStubbedFetch(
    async () => { throw new Error("network down"); },
    async () => handleModelProxy(req, baseEnv(), url),
  );
  assert.equal(response.status, 502);
});

test("model proxy enforces the body limit without a content-length header", async () => {
  const token = await mintToken();
  const { req, url } = request("/model/v1/responses", {
    method: "POST",
    body: new Uint8Array(2 * 1024 * 1024 + 1),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  assert.equal(req.headers.get("content-length"), null);
  let called = false;
  const response = await withStubbedFetch(
    async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
    async () => handleModelProxy(req, baseEnv(), url),
  );
  assert.equal(response.status, 413);
  assert.equal(called, false);
});

test("credential delivery keeps the raw key when the proxy is off", async () => {
  const entries = await modelCredentialEntries(baseEnv({ CRABHELM_MODEL_PROXY: "off" }), "claw-1");
  assert.deepEqual(entries, [["OPENAI_API_KEY", RAW_KEY]]);
});

test("credential delivery swaps in a per-claw model token when the proxy is on", async () => {
  const env = baseEnv({ CRABBOX_TTL_SECONDS: "14400" });
  const entries = await modelCredentialEntries(env, "claw-77");
  const map = Object.fromEntries(entries);
  assert.notEqual(map.OPENAI_API_KEY, RAW_KEY);
  assert.equal(map.OPENAI_BASE_URL, "https://crabhelm-runtime.openclaw.ai/model/v1");
  assert.equal(map.CRABHELM_MODEL_BASE_URL, "https://crabhelm-runtime.openclaw.ai/model/v1");

  // The delivered token is a valid, claw-scoped model credential the proxy accepts.
  const claims = await verifyClaims<ModelClaims>(SECRET, map.OPENAI_API_KEY!, { typ: "model", aud: "crabhelm-model" });
  assert.equal(claims.clawId, "claw-77");
  assert.ok(claims.exp - claims.iat <= 14_400);
});

test("credential delivery fails closed when the proxy is enabled without a signing secret", async () => {
  await assert.rejects(
    modelCredentialEntries(baseEnv({ MODEL_SIGNING_SECRET: undefined }), "claw-9"),
    /MODEL_SIGNING_SECRET is not configured/u,
  );
});
