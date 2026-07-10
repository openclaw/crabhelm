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
  modelProviders: {
    "clawrouter/anthropic/claude-sonnet-4.6": "anthropic",
    "clawrouter/openai/gpt-5.5": "openai",
  },
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

function catalogControl(
  mappedConfig: ClawRouterConfig,
  claw: ReturnType<typeof createClawRecord>,
  providers: Array<Record<string, unknown>>,
): ClawRouterControl {
  const router = claw.desired.inference.router;
  assert.equal(router.kind, "clawrouter");
  if (router.kind !== "clawrouter") throw new Error("expected ClawRouter desired state");
  return new ClawRouterControl(mappedConfig, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.pathname.startsWith("/v1/admin/policies/")) {
        return Response.json({ policyId: router.policyId, ...body });
      }
      if (url.pathname.startsWith("/v1/admin/credentials/")) {
        return Response.json({
          credentialId: router.credentialId,
          policyId: body.policyId,
          enabled: body.enabled,
          policyEnabled: body.enabled,
          generationMatches: true,
          active: body.enabled,
        });
      }
      if (url.pathname === "/v1/health") return Response.json({ ok: true });
      if (url.pathname === "/v1/key/inspect") {
        return Response.json({
          kid: router.credentialId,
          verified: true,
          enabled: true,
          providers: router.providers,
        });
      }
      if (url.pathname === "/v1/catalog") return Response.json({ providers });
      if (url.pathname === "/v1/usage") {
        const limitMicros = claw.desired.inference.monthlyBudgetUsd === undefined
          ? undefined
          : Math.round(claw.desired.inference.monthlyBudgetUsd * 1_000_000);
        return Response.json({
          budget: limitMicros === undefined
            ? { configured: false }
            : { configured: true, limitMicros },
          usage: { summary: {} },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
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
      CLAWROUTER_MODEL_PROVIDER_MAP: "clawrouter/openai/gpt-5.5=openai",
      CLAWROUTER_DEFAULT_MODEL: config.defaultModel,
      CLAWROUTER_ADMIN_TOKEN: config.adminToken,
      CLAWROUTER_CREDENTIAL_SECRET: credentialSecret,
      CLAWROUTER_ACCESS_CLIENT_ID: "only-one-half",
    }),
    /must be configured together/u,
  );
  const variantMap = [
    "clawrouter/bedrock/amazon.nova-lite-v1:0=aws-bedrock",
    "clawrouter/google/gemini-3.5-flash=google-gemini",
    "clawrouter/local/default=local-openai",
  ].join(",");
  const variants = resolveClawRouterConfig({
    CRABHELM_CLAWROUTER: "on",
    CLAWROUTER_BASE_URL: config.baseUrl,
    CLAWROUTER_TENANT_ID: config.tenantId,
    CLAWROUTER_ALLOWED_PROVIDERS: "aws-bedrock,google-gemini,local-openai",
    CLAWROUTER_MODEL_PROVIDER_MAP: variantMap,
    CLAWROUTER_DEFAULT_MODEL: "clawrouter/google/gemini-3.5-flash",
    CLAWROUTER_ADMIN_TOKEN: config.adminToken,
    CLAWROUTER_CREDENTIAL_SECRET: credentialSecret,
  });
  assert.deepEqual(variants?.modelProviders, {
    "clawrouter/bedrock/amazon.nova-lite-v1:0": "aws-bedrock",
    "clawrouter/google/gemini-3.5-flash": "google-gemini",
    "clawrouter/local/default": "local-openai",
  });
  assert.throws(
    () => resolveClawRouterConfig({
      CRABHELM_CLAWROUTER: "on",
      CLAWROUTER_BASE_URL: config.baseUrl,
      CLAWROUTER_TENANT_ID: config.tenantId,
      CLAWROUTER_ALLOWED_PROVIDERS: "openai",
      CLAWROUTER_MODEL_PROVIDER_MAP: "clawrouter/google/gemini-3.5-flash=google-gemini",
      CLAWROUTER_DEFAULT_MODEL: "clawrouter/google/gemini-3.5-flash",
      CLAWROUTER_ADMIN_TOKEN: config.adminToken,
      CLAWROUTER_CREDENTIAL_SECRET: credentialSecret,
    }),
    /provider outside the fleet allowlist/u,
  );
  assert.throws(
    () => resolveClawRouterConfig({
      CRABHELM_CLAWROUTER: "on",
      CLAWROUTER_BASE_URL: config.baseUrl,
      CLAWROUTER_TENANT_ID: config.tenantId,
      CLAWROUTER_ALLOWED_PROVIDERS: "openai",
      CLAWROUTER_MODEL_PROVIDER_MAP: "clawrouter/openai/gpt-5.5=openai,clawrouter/openai/gpt-5.5=openai",
      CLAWROUTER_DEFAULT_MODEL: config.defaultModel,
      CLAWROUTER_ADMIN_TOKEN: config.adminToken,
      CLAWROUTER_CREDENTIAL_SECRET: credentialSecret,
    }),
    /duplicate model/u,
  );
});

for (const variant of [
  {
    providerId: "google-gemini",
    model: "clawrouter/google/gemini-3.5-flash",
    catalogModel: "google/gemini-3.5-flash",
  },
  {
    providerId: "aws-bedrock",
    model: "clawrouter/bedrock/amazon.nova-lite-v1:0",
    catalogModel: "bedrock/amazon.nova-lite-v1:0",
  },
  {
    providerId: "local-openai",
    model: "clawrouter/local/default",
    catalogModel: "local/default",
  },
] as const) {
  test(`ClawRouter catalog maps ${variant.model} to provider ${variant.providerId}`, async () => {
    const mappedConfig: ClawRouterConfig = {
      ...config,
      allowedProviders: [variant.providerId],
      modelProviders: { [variant.model]: variant.providerId },
      defaultModel: variant.model,
    };
    const claw = createClawRecord({
      name: `Mapped ${variant.providerId}`,
      owner: { subject: `manual:${variant.providerId}`, label: variant.providerId, source: "manual" },
      inference: { model: variant.model },
    }, new Date("2026-07-09T00:00:00.000Z"), { clawRouter: mappedConfig });
    const observation = await catalogControl(mappedConfig, claw, [{
      id: variant.providerId,
      executable: true,
      models: [{ id: variant.catalogModel }],
    }]).reconcile(claw);
    assert.equal(observation.catalogReady, true);
    assert.deepEqual(observation.providers, [variant.providerId]);
  });
}

test("ClawRouter catalog fails closed on absent or ambiguous mapped models", async () => {
  const claw = routedClaw();
  await assert.rejects(catalogControl(config, claw, []).reconcile(claw), /catalog is not ready/u);
  const duplicate = { id: "openai", executable: true, models: [{ id: "openai/gpt-5.5" }] };
  await assert.rejects(
    catalogControl(config, claw, [duplicate, duplicate]).reconcile(claw),
    /catalog is not ready/u,
  );
});

test("ClawRouter control registers scoped metadata, rotates credentials, and projects bounded usage", async () => {
  const calls: Array<{ path: string; method: string; headers: Headers; body?: Record<string, unknown> }> = [];
  let expectedCredential = "";
  let includeFallback = false;
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
          providers: [
            { id: "openai", executable: true, models: [{ id: "openai/gpt-5.5" }] },
            ...(includeFallback
              ? [{ id: "anthropic", executable: true, models: [{ id: "anthropic/claude-sonnet-4.6" }] }]
              : []),
          ],
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

  await assert.rejects(control.reconcile(claw), /health or model catalog is not ready/u);
  includeFallback = true;
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
