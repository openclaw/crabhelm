/// <reference path="../worker-configuration.d.ts" />
/// <reference path="../worker/env.d.ts" />

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { invocationArgumentsDigest } from "../src/governance.js";
import { GovernanceRegistry } from "../src/governance-registry.js";
import type { ConfirmationRecord, GovernanceAuditEvent, InvocationGrantClaims, InvocationRecord, OAuthConnectionRecord, OAuthStateRecord, PersonaRecord, PrincipalRecord, SkillRecord } from "../src/governance-types.js";
import { CrabhelmRegistry } from "../src/registry.js";
import { createMemoryStateStore } from "../src/state.js";
import type { AuditEvent, ClawRecord } from "../src/types.js";
import { GovernanceController } from "../worker/governance-controller.js";
import { signClaims, verifyClaims } from "../worker/security.js";
import { OAuthVault } from "../worker/vault.js";

const secret = "invocation-fixture-signing-secret-at-least-32-bytes";
const invocationId = "invocation-fixture";
const args = { issueNumber: 1, body: "Synthetic comment" };

async function fixture(t: TestContext, providerStatus = 201) {
  const invocations = createMemoryStateStore<InvocationRecord>();
  const events = createMemoryStateStore<GovernanceAuditEvent>();
  const registry = new GovernanceRegistry({
    principals: createMemoryStateStore<PrincipalRecord>(),
    personas: createMemoryStateStore<PersonaRecord>(),
    skills: createMemoryStateStore<SkillRecord>(),
    connections: createMemoryStateStore<OAuthConnectionRecord>(),
    oauthStates: createMemoryStateStore<OAuthStateRecord>(),
    confirmations: createMemoryStateStore<ConfirmationRecord>(),
    invocations, events,
  });
  const principal = await registry.createPrincipal({ subject: "fixture:operator", label: "Fixture operator" }, "fixture");
  const objects = new Map<string, string>();
  const bucket = {
    async put(key: string, value: string) { objects.set(key, value); },
    async get(key: string) {
      const value = objects.get(key);
      return value === undefined ? null : { size: Buffer.byteLength(value), async text() { return value; } };
    },
    async delete(key: string) { objects.delete(key); },
  };
  const vaultKey = Buffer.alloc(32, 7).toString("base64url");
  const vault = new OAuthVault(bucket, vaultKey);
  const connectionId = "connection-fixture";
  const objectKey = await vault.put(connectionId, principal.id, "github", "synthetic-credential");
  await registry.registerConnection({ principalId: principal.id, provider: "github", label: "Fixture", scopes: ["repo:write"], secret: "fixture" }, objectKey, principal.id, connectionId);
  const argumentsDigest = invocationArgumentsDigest({ capabilityId: "github.issue.comment", target: "example/repo", arguments: args });
  const token = await signClaims<InvocationGrantClaims>(secret, {
    typ: "invocation", aud: "crabhelm-tool-wrapper", clawId: "claw-fixture", requesterId: principal.id,
    personaId: "persona-fixture", actorId: principal.id, actorMode: "invoker", fallbackUsed: false,
    capabilityId: "github.issue.comment", target: "example/repo", argumentsDigest, policyRevision: 1, connectionId,
  }, 300);
  const claims = await verifyClaims<InvocationGrantClaims>(secret, token, { typ: "invocation", aud: "crabhelm-tool-wrapper" });
  await registry.saveInvocation({
    id: invocationId, clawId: claims.clawId, requesterId: claims.requesterId, personaId: claims.personaId,
    actorId: claims.actorId, actorMode: claims.actorMode, fallbackUsed: false,
    capabilityId: claims.capabilityId, target: claims.target, argumentsDigest, policyRevision: 1,
    status: "issued", issuedAt: new Date().toISOString(), expiresAt: new Date(claims.exp * 1000).toISOString(),
  });
  let consumed = false;
  let runStatus = "";
  const coordinator = {
    async consumeGrant(input: { invocationId: string; jti: string; argumentsDigest: string; expiresAt: number }) {
      if (consumed || input.invocationId !== invocationId || input.jti !== claims.jti || input.argumentsDigest !== argumentsDigest || input.expiresAt <= Date.now()) return false;
      consumed = true;
      return true;
    },
    async startRun() { runStatus = "running"; },
    async finishRun(_id: string, ok: boolean) {
      // Both real coordinator backends only complete a running record.
      if (runStatus === "running") runStatus = ok ? "succeeded" : "failed";
    },
  };
  const queued: GovernanceAuditEvent[] = [];
  const queue = { async send(event: GovernanceAuditEvent) { queued.push(event); } };
  const env = { INVOCATION_SIGNING_SECRET: secret, VAULT_MASTER_KEY: vaultKey, OAUTH_VAULT: bucket, AUDIT_QUEUE: queue, CLAW_COORDINATOR: { getByName() { return coordinator; } } } as unknown as Env;
  const controller = new GovernanceController(registry, new CrabhelmRegistry(createMemoryStateStore<ClawRecord>(), createMemoryStateStore<AuditEvent>()), env);
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(String(url), "https://api.github.com/repos/example/repo/issues/1/comments");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { body: args.body });
    posts += 1;
    return Response.json(providerStatus === 201 ? { id: 123, html_url: "https://github.com/example/repo/issues/1#issuecomment-123" } : { message: "fixture provider failure" }, { status: providerStatus });
  });
  const logs: string[] = [];
  t.mock.method(console, "error", (line: string) => { logs.push(line); });
  return {
    registry, invocations, events, coordinator, queue, queued, logs,
    get posts() { return posts; },
    get runStatus() { return runStatus; },
    async execute() {
      const response = await controller.route(new Request("https://runtime.example.test/api/tools/github/execute", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ invocationId, arguments: args }),
      }));
      assert.ok(response);
      return response;
    },
  };
}

test("successful GitHub execution keeps the original response when bookkeeping succeeds", async (t) => {
  const f = await fixture(t);
  const response = await f.execute();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { invocationId, ok: true, result: { id: 123, html_url: "https://github.com/example/repo/issues/1#issuecomment-123" } });
  assert.equal(f.runStatus, "succeeded");
  assert.equal((await f.invocations.lookup(invocationId))?.status, "succeeded");
  assert.equal(f.queued[0]?.outcome, "succeeded");
  assert.deepEqual(f.logs, []);
});

test("failed GitHub execution keeps the original error when bookkeeping succeeds", async (t) => {
  const f = await fixture(t, 502);
  const response = await f.execute();
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "GitHub request failed (502): fixture provider failure" });
  assert.equal(f.runStatus, "failed");
  assert.equal((await f.invocations.lookup(invocationId))?.status, "failed");
  assert.deepEqual(f.queued.map((event) => event.outcome), ["failed"]);
  assert.deepEqual(f.logs, []);
});

for (const providerStatus of [201, 502]) {
  test(`queue failure preserves the ${providerStatus === 201 ? "successful" : "failed"} GitHub outcome and one-use grant`, async (t) => {
    const f = await fixture(t, providerStatus);
    t.mock.method(f.queue, "send", async () => { throw new Error("private queue diagnostic"); });
    const response = await f.execute();
    const body = await response.json() as { ok?: boolean; error?: string; warnings: Array<{ code: string; message: string; invocationId: string; eventId: string }> };
    const outcome = providerStatus === 201 ? "succeeded" : "failed";
    assert.equal(response.status, providerStatus === 201 ? 200 : 422);
    if (providerStatus === 201) assert.equal(body.ok, true);
    else assert.equal(body.error, "GitHub request failed (502): fixture provider failure");
    assert.equal(f.runStatus, outcome);
    assert.equal((await f.invocations.lookup(invocationId))?.status, outcome);
    const audits = (await f.events.entries()).map((entry) => entry.value).filter((event) => event.action === "tool.github.execute");
    assert.deepEqual(audits.map((event) => event.outcome), [outcome]);
    assert.equal(body.warnings.length, 1);
    assert.equal(body.warnings[0]?.code, "audit_not_queued");
    assert.equal(body.warnings[0]?.invocationId, invocationId);
    assert.equal(body.warnings[0]?.eventId, audits[0]?.id);
    if (providerStatus === 201) assert.match(body.warnings[0]!.message, /Do not repeat/u);
    assert.doesNotMatch(JSON.stringify([body, f.logs]), /private queue diagnostic|synthetic-credential/u);
    assert.equal((await f.execute()).status, 409);
    assert.equal(f.posts, 1);
  });
}

for (const fault of ["coordinator", "invocation", "audit"] as const) {
  test(`successful GitHub execution reports ${fault} bookkeeping failure without failing its other records`, async (t) => {
    const f = await fixture(t);
    if (fault === "coordinator") t.mock.method(f.coordinator, "finishRun", async () => { throw new Error("private coordinator diagnostic"); });
    if (fault === "invocation") {
      const register = f.invocations.register.bind(f.invocations);
      t.mock.method(f.invocations, "register", async (key: string, value: InvocationRecord) => {
        if (value.status === "succeeded") throw new Error("private invocation diagnostic");
        await register(key, value);
      });
    }
    if (fault === "audit") t.mock.method(f.events, "register", async () => { throw new Error("private audit diagnostic"); });
    const response = await f.execute();
    const body = await response.json() as { ok: boolean; warnings: Array<{ code: string }> };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.warnings.map((warning) => warning.code), [fault === "coordinator" ? "coordinator_outcome_not_recorded" : fault === "invocation" ? "invocation_outcome_not_recorded" : "audit_not_recorded"]);
    assert.equal(f.runStatus, fault === "coordinator" ? "running" : "succeeded");
    assert.equal((await f.invocations.lookup(invocationId))?.status, fault === "invocation" ? "running" : "succeeded");
    assert.deepEqual(f.queued.map((event) => event.outcome), fault === "audit" ? [] : ["succeeded"]);
    assert.doesNotMatch(JSON.stringify([body, f.logs]), /private .* diagnostic|synthetic-credential/u);
    assert.equal((await f.execute()).status, 409);
    assert.equal(f.posts, 1);
  });
}

for (const providerStatus of [201, 502]) {
  test(`all bookkeeping failures preserve the original ${providerStatus === 201 ? "success" : "error"} with bounded warnings`, async (t) => {
    const f = await fixture(t, providerStatus);
    t.mock.method(f.coordinator, "finishRun", async () => { throw new Error("private coordinator diagnostic"); });
    const register = f.invocations.register.bind(f.invocations);
    t.mock.method(f.invocations, "register", async (key: string, value: InvocationRecord) => {
      if (value.status === "failed" || value.status === "succeeded") throw new Error("private invocation diagnostic");
      await register(key, value);
    });
    t.mock.method(f.queue, "send", async () => { throw new Error("private queue diagnostic"); });
    const response = await f.execute();
    const body = await response.json() as { ok?: boolean; error?: string; warnings: Array<{ code: string }> };
    assert.equal(response.status, providerStatus === 201 ? 200 : 422);
    if (providerStatus === 201) assert.equal(body.ok, true);
    else assert.equal(body.error, "GitHub request failed (502): fixture provider failure");
    assert.deepEqual(body.warnings.map((warning) => warning.code), ["coordinator_outcome_not_recorded", "invocation_outcome_not_recorded", "audit_not_queued"]);
    assert.equal(f.posts, 1);
    assert.equal(f.runStatus, "running");
    assert.equal((await f.invocations.lookup(invocationId))?.status, "running");
  });
}

test("registry completion cannot replace or retimestamp a terminal invocation", async (t) => {
  const f = await fixture(t);
  await f.execute();
  const recorded = await f.invocations.lookup(invocationId);
  assert.ok(recorded);
  await assert.rejects(f.registry.updateInvocation(invocationId, { status: "failed" }), /outcome is final/u);
  assert.deepEqual(await f.registry.updateInvocation(invocationId, { status: "succeeded", completedAt: "2099-01-01T00:00:00.000Z" }), recorded);
  assert.deepEqual(await f.invocations.lookup(invocationId), recorded);
});
