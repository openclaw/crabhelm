import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ClawRouterControl,
  resolveClawRouterConfig,
  type ClawRouterConfig,
} from "../src/clawrouter.js";
import { createClawRecord, rotateClawCredentials, setClawEnabled } from "../src/domain.js";

const credentialSecret = "c".repeat(48);
const config: ClawRouterConfig = {
  baseUrl: "https://clawrouter.example.test",
  tenantId: "fakeco",
  allowedProviders: ["anthropic", "openai"],
  defaultModel: "clawrouter/openai/gpt-5.5",
  adminToken: "admin-token",
  credentialSecret,
  accessClientId: "access-id",
  accessClientSecret: "access",
};

function routedClaw() {
  return createClawRecord({
    name: "FakeCo research",
    owner: { subject: "email:research@example.test", label: "Research", source: "email" },
    inference: {
      model: "clawrouter/openai/gpt-5.5",
      fallbackModels: ["clawrouter/anthropic/claude-sonnet-4.6"],
      monthlyBudgetUsd: 2.5,
    },
  }, new Date("2026-07-09T00:00:00.000Z"), { clawRouter: config });
}

test("ClawRouter fleet configuration is explicit and fail-closed", () => {
  assert.equal(resolveClawRouterConfig({ CRABHELM_CLAWROUTER: "off" }), undefined);
  assert.throws(
    () => resolveClawRouterConfig({ CRABHELM_CLAWROUTER: "invalid" }),
    /must be on or off/u,
  );
  assert.throws(
    () => resolveClawRouterConfig({ CRABHELM_CLAWROUTER: "on" }),
    /CLAWROUTER_BASE_URL is required/u,
  );
  assert.throws(
    () => resolveClawRouterConfig({
      CRABHELM_CLAWROUTER: "on",
      CLAWROUTER_BASE_URL: config.baseUrl,
      CLAWROUTER_TENANT_ID: config.tenantId,
      CLAWROUTER_ALLOWED_PROVIDERS: "openai",
      CLAWROUTER_DEFAULT_MODEL: config.defaultModel,
      CLAWROUTER_ADMIN_TOKEN: config.adminToken,
      CLAWROUTER_CREDENTIAL_SECRET: credentialSecret,
      CLAWROUTER_ACCESS_CLIENT_ID: "only-one-half",
    }),
    /must be configured together/u,
  );
});

test("ClawRouter control registers scoped metadata, rotates credentials, and projects bounded usage", async () => {
  const calls: Array<{ path: string; method: string; headers: Headers; body?: Record<string, unknown> }> = [];
  let expectedCredential = "";
  const claw = routedClaw();
  const expectedRouter = claw.desired.inference.router;
  assert.equal(expectedRouter.kind, "clawrouter");
  if (expectedRouter.kind !== "clawrouter") throw new Error("expected ClawRouter desired state");
  const control = new ClawRouterControl(config, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ path: url.pathname, method: init?.method ?? "GET", headers, ...(body ? { body } : {}) });
      if (url.pathname.startsWith("/v1/admin/policies/")) {
        return Response.json({ policyId: url.pathname.split("/").at(-1), ...body });
      }
      if (url.pathname.startsWith("/v1/admin/credentials/")) {
        return Response.json({
          credentialId: url.pathname.split("/").at(-1),
          policyId: body?.policyId,
          enabled: body?.enabled,
          policyEnabled: body?.enabled,
          generationMatches: true,
          active: body?.enabled,
        });
      }
      if (url.pathname === "/v1/health") return Response.json({ ok: true, service: "clawrouter-edge" });
      if (url.pathname === "/v1/key/inspect") {
        assert.equal(headers.get("authorization"), `Bearer ${expectedCredential}`);
        return Response.json({
          kid: expectedRouter.credentialId,
          verified: true,
          enabled: true,
          providers: ["anthropic", "openai"],
          tenantId: "fakeco",
        });
      }
      if (url.pathname === "/v1/catalog") {
        return Response.json({
          version: "clawrouter.client-catalog.v1",
          providers: [{ id: "openai", executable: true, models: [{ id: "gpt-5.5" }] }],
        });
      }
      if (url.pathname === "/v1/usage") {
        return Response.json({
          policyId: "ignored",
          budget: { configured: true, limitMicros: 2_500_000, spentMicros: 125_000, remainingMicros: 2_375_000 },
          usage: {
            summary: {
              requestCount: 4,
              successCount: 3,
              errorCount: 1,
              inputTokens: 120,
              outputTokens: 40,
              totalTokens: 160,
              actualCostMicros: 125_000,
            },
            events: [{ prompt: "must never enter Crabhelm state", credential: "also forbidden" }],
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const firstCredentials = Object.fromEntries(await control.credentials(claw, 1));
  expectedCredential = firstCredentials.CLAWROUTER_API_KEY!;
  assert.match(expectedCredential, /^clawrouter-live-crabhelm_[0-9a-f]{32}-[A-Za-z0-9_-]+$/u);
  assert.equal(firstCredentials.CRABHELM_ROUTER_BASE_URL, config.baseUrl);
  assert.equal(firstCredentials.OPENAI_API_KEY, undefined);

  const observation = await control.reconcile(claw);
  assert.equal(observation.routerHealthy, true);
  assert.equal(observation.catalogReady, true);
  assert.equal(observation.routeVerified, false);
  assert.deepEqual(observation.providers, ["anthropic", "openai"]);
  assert.deepEqual(observation.usage, {
    requestCount: 4,
    successCount: 3,
    errorCount: 1,
    inputTokens: 120,
    outputTokens: 40,
    totalTokens: 160,
    actualCostMicros: 125_000,
  });
  assert.doesNotMatch(JSON.stringify(observation), /must never|also forbidden/u);

  const policyCall = calls.find((call) => call.path.startsWith("/v1/admin/policies/"))!;
  assert.deepEqual(policyCall.body, {
    enabled: true,
    providers: ["anthropic", "openai"],
    tenantId: "fakeco",
    tokenRole: "service",
    monthlyBudgetMicros: 2_500_000,
    retainRequestContent: false,
  });
  assert.equal(policyCall.headers.get("authorization"), "Bearer admin-token");
  assert.equal(policyCall.headers.get("cf-access-client-id"), "access-id");
  assert.equal(policyCall.headers.get("cf-access-client-secret"), "access");

  const credentialCall = calls.find((call) => call.path.startsWith("/v1/admin/credentials/"))!;
  const router = claw.desired.inference.router;
  assert.equal(router.kind, "clawrouter");
  const suffix = expectedCredential.slice(`clawrouter-live-${router.credentialId}-`.length);
  assert.equal(
    credentialCall.body?.secretSha256,
    createHash("sha256").update(suffix).digest("hex"),
  );
  assert.equal(JSON.stringify(credentialCall.body).includes(expectedCredential), false);

  const rotated = rotateClawCredentials(claw);
  const rotatedEntries = Object.fromEntries(await control.credentials(rotated, 2));
  assert.notEqual(rotatedEntries.CLAWROUTER_API_KEY, expectedCredential);
  await assert.rejects(control.credentials(rotated, 1), /does not match desired state/u);

  const disabled = await control.reconcile(setClawEnabled(rotated, false));
  assert.equal(disabled.policyActive, false);
  assert.equal(disabled.credentialActive, false);
  assert.equal(disabled.routeVerified, false);
});

test("ClawRouter status fails closed when observed credential scope drifts", async () => {
  const claw = routedClaw();
  const expectedRouter = claw.desired.inference.router;
  assert.equal(expectedRouter.kind, "clawrouter");
  if (expectedRouter.kind !== "clawrouter") throw new Error("expected ClawRouter desired state");
  const control = new ClawRouterControl(config, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.pathname.startsWith("/v1/admin/credentials/")) {
        return Response.json({
          credentialId: url.pathname.split("/").at(-1),
          policyId: body.policyId,
          enabled: body.enabled,
          policyEnabled: body.enabled,
          generationMatches: true,
          active: body.enabled,
        });
      }
      if (url.pathname.startsWith("/v1/admin/policies/")) {
        return Response.json({ policyId: url.pathname.split("/").at(-1), ...body });
      }
      if (url.pathname === "/v1/health") return Response.json({ ok: true });
      if (url.pathname === "/v1/key/inspect") {
        return Response.json({
          kid: expectedRouter.credentialId,
          verified: true,
          enabled: true,
          providers: ["openai"],
        });
      }
      return Response.json({ providers: [] });
    },
  });
  await assert.rejects(control.reconcile(claw), /credential scope did not converge/u);
});

test("ClawRouter control refuses persisted desired state from another fleet", async () => {
  let requests = 0;
  const control = new ClawRouterControl(config, {
    fetch: async () => {
      requests += 1;
      return Response.json({ ok: true });
    },
  });
  const claw = routedClaw();
  const router = claw.desired.inference.router;
  assert.equal(router.kind, "clawrouter");
  if (router.kind !== "clawrouter") throw new Error("expected ClawRouter desired state");
  const drifted: typeof claw = {
    ...claw,
    desired: {
      ...claw.desired,
      inference: {
        ...claw.desired.inference,
        router: { ...router, baseUrl: "https://other-router.example.test" },
      },
    },
  };

  await assert.rejects(control.reconcile(drifted), /does not match fleet configuration/u);
  await assert.rejects(control.credentials(drifted, 1), /does not match fleet configuration/u);
  assert.equal(requests, 0);
});
