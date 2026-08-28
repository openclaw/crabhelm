import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

// OpenClaw is an optional peer; only its result formatter is stubbed here.
const sdk = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "openclaw/plugin-sdk/core") return nextResolve(specifier, context);
    const source = "export function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; }";
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
const { createGovernedGithubTool } = await import("../src/governed-tool.js");
sdk.deregister();

const params = { capability: "github.issue.comment", repository: "example/repo", issueNumber: 1, body: "A comment" };
const controlUrl = "https://runtime.example.test";
const grant = { grant: "test-grant", invocation: { id: "invocation-1" }, executeUrl: `${controlUrl}/api/tools/github/execute` };
const confirmation = { confirmationRequired: true, confirmation: { id: "confirmation-1" } };

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "crabhelm-governed-"));
  const previousUrl = process.env.CRABHELM_CONTROL_URL;
  process.env.CRABHELM_CONTROL_URL = controlUrl;
  t.after(async () => {
    if (previousUrl === undefined) delete process.env.CRABHELM_CONTROL_URL;
    else process.env.CRABHELM_CONTROL_URL = previousUrl;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(path.join(dir, "crabhelm-current-turn.json"), JSON.stringify({ jobId: "job-1", turnToken: "test-turn" }), { mode: 0o600 });
  return createGovernedGithubTool(dir);
}

test("governed tool cancels the confirmation sleep without polling or executing again", async (t) => {
  const tool = await fixture(t);
  const controller = new AbortController();
  const requests: string[] = [];
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => clearTimeout(cancelTimer));
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    requests.push(input.pathname);
    if (input.pathname.endsWith("/issue")) return Response.json(confirmation, { status: 202 });
    // Allow the response body to be consumed and the two-second delay to begin.
    cancelTimer = setTimeout(() => controller.abort(), 50);
    return Response.json({ status: controller.signal.aborted ? "denied" : "pending" });
  });
  const started = performance.now();
  await assert.rejects(tool.execute("call-1", params, controller.signal), { name: "AbortError" });
  assert.ok(performance.now() - started < 1000, "cancellation must not wait for the two-second delay");
  assert.deepEqual(requests, ["/api/runtime/invocations/issue", "/api/runtime/confirmations/confirmation-1"]);
});

for (const stage of ["issue", "poll", "reissue", "execute"]) {
  test(`governed tool cancels an in-flight ${stage} request`, async (t) => {
    const tool = await fixture(t);
    const controller = new AbortController();
    let issues = 0;
    let reached = false;
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
      requests.push(input.pathname);
      assert.equal(reached, false, "no request may follow the cancelled request");
      const current = input.pathname.endsWith("/issue") ? (++issues === 1 ? "issue" : "reissue")
        : input.pathname.endsWith("/execute") ? "execute" : "poll";
      if (current === stage) {
        reached = true;
        const signal = init.signal!;
        assert.ok(signal instanceof AbortSignal);
        const pending = new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("request did not observe cancellation")), 1000);
          t.after(() => clearTimeout(timer));
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        controller.abort();
        return pending;
      }
      if (current === "issue") return Response.json(confirmation, { status: 202 });
      if (current === "poll") return Response.json({ status: "approved" });
      return Response.json(grant, { status: 201 });
    });
    await assert.rejects(tool.execute("call-1", params, controller.signal), { name: "AbortError" });
    assert.equal(reached, true);
    assert.equal(requests.length, ["issue", "poll", "reissue", "execute"].indexOf(stage) + 1);
  });
}

test("already cancelled governed tools do not issue requests", async (t) => {
  const tool = await fixture(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected request"); });
  await assert.rejects(tool.execute("call-1", params, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("cancellation after approval prevents issuing the approved grant", async (t) => {
  const tool = await fixture(t);
  const controller = new AbortController();
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: URL) => {
    if (input.pathname.endsWith("/issue")) return Response.json(confirmation, { status: 202 });
    const response = Response.json({ status: "approved" });
    const bytes = await response.arrayBuffer();
    t.mock.method(response, "arrayBuffer", async () => { controller.abort(); return bytes; });
    return response;
  });
  await assert.rejects(tool.execute("call-1", params, controller.signal), { name: "AbortError" });
  assert.equal(fetchMock.mock.callCount(), 2);
});

for (const outcome of ["approved", "denied", "expired"]) {
  test(`governed confirmation still handles ${outcome} without a cancellation signal`, async (t) => {
    const tool = await fixture(t);
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
      requests.push(input.pathname);
      assert.ok(init.signal instanceof AbortSignal, "request timeout remains enabled");
      if (input.pathname.endsWith("/issue")) {
        if (requests.length === 1) return Response.json(confirmation, { status: 202 });
        assert.equal(JSON.parse(String(init.body)).confirmationId, "confirmation-1");
        return Response.json(grant, { status: 201 });
      }
      if (input.pathname.endsWith("/execute")) return Response.json({ ok: true });
      return Response.json({ status: outcome });
    });
    const result = await tool.execute("call-1", params);
    assert.deepEqual(result.details, outcome === "approved" ? { ok: true } : {
      ok: false, confirmation: outcome, message: `Requester ${outcome} the GitHub action.`,
    });
    assert.equal(requests.length, outcome === "approved" ? 4 : 2);
  });
}
