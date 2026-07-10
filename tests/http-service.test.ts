/// <reference path="../worker-configuration.d.ts" />
/// <reference path="../worker/env.d.ts" />

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { SessionClaims } from "../src/governance-types.js";
import { createMemoryStateStore, type StateStore } from "../src/state.js";
import {
  CrabhelmControlPlaneService,
  type ControlPlanePlatform,
  type ControlPlaneStateDatabase,
} from "../worker/control-plane-service.js";
import {
  handleCrabhelmRequest,
  type BackgroundContext,
} from "../worker/http-service.js";
import { bootstrapToken } from "../worker/bootstrap.js";
import { signClaims } from "../worker/security.js";
import {
  slackIngressEnabled,
  slackIntegrationConfigured,
} from "../worker/slack-config.js";

const CONSOLE = "https://crabhelm.example.test";
const RUNTIME = "https://crabhelm-runtime.example.test";
const SIGNING_SECRET = "portable-test-signing-secret-at-least-32-bytes";
const VAULT_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const DIGEST = "a".repeat(64);

const background: BackgroundContext = {
  waitUntil() {},
};

test("HTTP service reports the injected platform runtime without consulting bindings", async () => {
  const unavailableBindings = new Proxy({}, {
    get(_target, property) {
      throw new Error(`health probe read unexpected binding ${String(property)}`);
    },
  }) as Env;

  for (const runtimeLabel of ["cloudflare-workers", "aws-ecs", "portable-test"]) {
    const response = await handleCrabhelmRequest(
      new Request(`${CONSOLE}/healthz`),
      unavailableBindings,
      background,
      { runtimeLabel },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "crabhelm",
      runtime: runtimeLabel,
    });
  }
});

test("HTTP service delegates runtime WebSocket setup to the platform adapter", async () => {
  let received: { request: Request; url: URL } | undefined;
  const response = await handleCrabhelmRequest(
    new Request(`${RUNTIME}/api/runtime/connect?clawId=portable-claw`, {
      headers: { upgrade: "websocket" },
    }),
    { RUNTIME_URL: RUNTIME } as Env,
    background,
    {
      runtimeLabel: "portable-test",
      runtimeConnect: async (request, _env, url) => {
        received = { request, url };
        return new Response("portable runtime connector", { status: 209 });
      },
    },
  );

  assert.equal(response.status, 209);
  assert.equal(await response.text(), "portable runtime connector");
  assert.equal(received?.request.headers.get("upgrade"), "websocket");
  assert.equal(received?.url.searchParams.get("clawId"), "portable-claw");
});

test("Slack ingress cancels an oversized chunked body before authentication", async () => {
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(`${RUNTIME}/slack/events`, {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.equal(request.headers.get("content-length"), null);

  const response = await handleCrabhelmRequest(
    request,
    {
      RUNTIME_URL: RUNTIME,
      SLACK_SIGNING_SECRET: "unused",
      SLACK_BOT_TOKEN: "unused",
    } as Env,
    background,
    { runtimeLabel: "portable-test" },
  );

  assert.equal(response.status, 413);
  assert.equal(await response.text(), "payload too large");
  assert.equal(cancelled, true);
  assert.ok(chunks >= 3 && chunks < 10);
});

test("Slack-off mode closes ingress before authentication or body parsing", async () => {
  let cancelled = false;
  let pulled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled = true;
      controller.enqueue(new TextEncoder().encode("must-not-be-read"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await handleCrabhelmRequest(
    new Request(`${RUNTIME}/slack/events`, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
    {
      RUNTIME_URL: RUNTIME,
      CRABHELM_SLACK: "off",
      SLACK_SIGNING_SECRET: "stale",
      SLACK_BOT_TOKEN: "stale",
    } as Env,
    background,
    { runtimeLabel: "portable-test" },
  );

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "not found");
  assert.equal(pulled, false);
  assert.equal(cancelled, true);
});

test("Slack-off mode reports the integration as not configured", async () => {
  let service: CrabhelmControlPlaneService;
  const env = fakeEnv(() => service);
  env.CRABHELM_SLACK = "off";
  env.SLACK_SIGNING_SECRET = "stale";
  env.SLACK_BOT_TOKEN = "stale";
  service = new CrabhelmControlPlaneService(memoryStateDatabase(), env, {
    async schedule() {},
    restart(): never { throw new Error("unused"); },
  });
  const token = await signClaims<SessionClaims>(SIGNING_SECRET, {
    typ: "session",
    aud: "crabhelm-control-plane",
    principalId: "principal:portable-admin",
    roles: ["administrator"],
  }, 300);

  const response = await routedRequest(env, token, "/api/state");
  assert.equal(response.status, 200);
  const state = await response.json() as { integrations: { slack: boolean } };
  assert.equal(state.integrations.slack, false);
});

test("Slack mode preserves the missing default and fails closed on invalid values", () => {
  const credentials = {
    SLACK_SIGNING_SECRET: "stale",
    SLACK_BOT_TOKEN: "stale",
  };

  assert.equal(slackIngressEnabled({}), true);
  assert.equal(slackIngressEnabled({ CRABHELM_SLACK: "on" }), true);
  assert.equal(slackIntegrationConfigured(credentials), true);

  for (const mode of ["off", "false", "OFF", "disabled", "", " on "]) {
    const env = {
      ...credentials,
      CRABHELM_SLACK: mode,
    } as unknown as Env;
    assert.equal(slackIngressEnabled(env), false, mode);
    assert.equal(slackIntegrationConfigured(env), false, mode);
  }
});

test("portable HTTP and control-plane services persist policy state across reconstruction", async () => {
  const database = memoryStateDatabase();
  const scheduled: number[] = [];
  const restart = new Error("portable platform restart");
  const platform: ControlPlanePlatform = {
    async schedule(at) {
      scheduled.push(at);
    },
    restart(): never {
      throw restart;
    },
    terminalDialer: async () => {
      throw new Error("terminal transport is not used by this contract");
    },
  };

  let service: CrabhelmControlPlaneService;
  const env = fakeEnv(() => service);
  service = new CrabhelmControlPlaneService(database, env, platform);
  const token = await signClaims<SessionClaims>(SIGNING_SECRET, {
    typ: "session",
    aud: "crabhelm-control-plane",
    principalId: "principal:portable-admin",
    roles: ["administrator"],
  }, 300);

  const created = await routedRequest(env, token, "/api/policies", {
    method: "POST",
    body: JSON.stringify({
      name: "Portable Service Policy",
      description: "created without workerd",
      spec: {
        inference: { model: "openai/gpt-5.5", fallbackModels: [] },
        slackEnabled: false,
        access: { dmPolicy: "pairing", groupPolicy: "allowlist" },
        observability: { logLevel: "info" },
      },
    }),
  });
  assert.equal(created.status, 201);
  const policy = await created.json() as { id: string };
  assert.ok(policy.id);

  // Reconstruct the service over the same state adapter, like a new platform
  // process handling the next request. The binding below resolves lazily to it.
  service = new CrabhelmControlPlaneService(database, env, platform);
  const stateResponse = await routedRequest(env, token, "/api/state");
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json() as {
    policies: Array<{ id: string; name: string }>;
    runtime: { mode: string; targets: Array<{ admissionOpen: boolean }> };
    viewer: { principalId: string; roles: string[] };
  };
  assert.deepEqual(state.policies.map(({ id, name }) => ({ id, name })), [{
    id: policy.id,
    name: "Portable Service Policy",
  }]);
  assert.equal(state.runtime.mode, "crabbox");
  assert.equal(state.runtime.targets[0]?.admissionOpen, true);
  assert.deepEqual(state.viewer, {
    principalId: "principal:portable-admin",
    roles: ["administrator"],
  });
  assert.deepEqual(scheduled, []);
  assert.deepEqual(service.deploymentIdentity(), {
    archiveId: DIGEST,
    releaseId: DIGEST,
  });
  assert.throws(() => service.restartForDeployment(), (error) => error === restart);
});

test("runtime state reports requested ClawRouter mode when admission is closed", async () => {
  let service: CrabhelmControlPlaneService;
  const env = fakeEnv(() => service);
  env.CRABHELM_CLAWROUTER = "on";
  service = new CrabhelmControlPlaneService(memoryStateDatabase(), env, {
    async schedule() {},
    restart(): never { throw new Error("unused"); },
  });
  const token = await signClaims<SessionClaims>(SIGNING_SECRET, {
    typ: "session",
    aud: "crabhelm-control-plane",
    principalId: "principal:portable-admin",
    roles: ["administrator"],
  }, 300);
  const response = await routedRequest(env, token, "/api/state");
  assert.equal(response.status, 200);
  const state = await response.json() as {
    runtime: { mode: string; inference: { kind: string }; targets: Array<{ admissionOpen: boolean }> };
  };
  assert.equal(state.runtime.mode, "unconfigured");
  assert.equal(state.runtime.inference.kind, "clawrouter");
  assert.equal(state.runtime.targets[0]?.admissionOpen, false);
});

test("Cloudflare entrypoint delegates to the portable HTTP service with its stable label", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /handleCrabhelmRequest\(request,\s*env,\s*ctx,\s*\{\s*runtimeLabel:\s*"cloudflare-workers"\s*\}\)/u,
  );

  const response = await handleCrabhelmRequest(
    new Request(`${CONSOLE}/healthz`),
    {} as Env,
    background,
    { runtimeLabel: "cloudflare-workers" },
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "crabhelm",
    runtime: "cloudflare-workers",
  });
});

test("bootstrap accepts the authoritative multi-segment ClawRouter model and origin", async () => {
  const childId = "685b2bda-351e-450b-a91c-45938c54454f";
  let refreshRegistrations = 0;
  let inferenceEntries = [
    ["CLAWROUTER_API_KEY", "clawrouter-live-crabhelm_685b2bda351e450ba91c45938c54454f-test-secret"],
    ["CRABHELM_ROUTER_BASE_URL", "https://clawrouter.example.test"],
  ];
  const token = await bootstrapToken(
    SIGNING_SECRET,
    childId,
    DIGEST,
    DIGEST,
    DIGEST,
    Date.now() + 60_000,
  );
  const controlPlane = {
    bootstrapInference: async () => ({
      model: "clawrouter/openai/gpt-5.5",
      router: {
        kind: "clawrouter" as const,
        baseUrl: "https://clawrouter.example.test",
        tenantId: "fakeco",
        policyId: "crabhelm_685b2bda351e450ba91c45938c54454f",
        credentialId: "crabhelm_685b2bda351e450ba91c45938c54454f",
        projectId: "685b2bda-351e-450b-a91c-45938c54454f",
        allowedProviders: ["openai"],
        modelProviders: { "clawrouter/openai/gpt-5.5": "openai" },
        providers: ["openai"],
      },
      credentialsGeneration: 2,
    }),
    inferenceCredentials: async () => inferenceEntries,
  };
  const env = {
    RUNTIME_URL: RUNTIME,
    BOOTSTRAP_SIGNING_SECRET: SIGNING_SECRET,
    APPLIANCE_MANIFEST_SHA256: DIGEST,
    APPLIANCE_ARCHIVE_SHA256: DIGEST,
    NODE_RUNTIME_SHA256: DIGEST,
    RUNTIME_SIGNING_SECRET: SIGNING_SECRET,
    CRABHELM_EGRESS_LOCKDOWN: "required",
    CONTROL_PLANE: { getByName: () => controlPlane },
    CLAW_COORDINATOR: {
      getByName: () => ({
        async registerRuntimeRefresh() {
          refreshRegistrations += 1;
        },
      }),
    },
  } as unknown as Env;
  const url = new URL(`${RUNTIME}/bootstrap/${childId}/install.sh`);
  url.searchParams.set("model", "clawrouter/openai/gpt-5.5");
  url.searchParams.set("slack", "false");
  url.searchParams.set("credentials", "2");
  url.searchParams.set("policyHash", DIGEST);
  const response = await handleCrabhelmRequest(
    new Request(url, { headers: { authorization: `Bearer ${token}` } }),
    env,
    background,
    { runtimeLabel: "portable-test" },
  );

  assert.equal(response.status, 200);
  const script = await response.text();
  assert.match(script, /CRABHELM_MODEL='clawrouter\/openai\/gpt-5\.5'/u);
  assert.match(script, /CRABHELM_ROUTER_BASE_URL='https:\/\/clawrouter\.example\.test'/u);
  assert.match(script, /credentials\.env\?credentials=2/u);

  url.pathname = `/bootstrap/${childId}/credentials.env`;
  const credentialsResponse = await handleCrabhelmRequest(
    new Request(url, { headers: { authorization: `Bearer ${token}` } }),
    env,
    background,
    { runtimeLabel: "portable-test" },
  );
  assert.equal(credentialsResponse.status, 200);
  const credentials = await credentialsResponse.text();
  assert.match(credentials, /^CLAWROUTER_API_KEY=/mu);
  assert.match(credentials, /^CRABHELM_ROUTER_BASE_URL='https:\/\/clawrouter\.example\.test'$/mu);
  assert.match(credentials, /^CRABHELM_RUNTIME_TOKEN=/mu);
  assert.doesNotMatch(credentials, /OPENAI_API_KEY|CLAWROUTER_ADMIN_TOKEN|upstream/iu);
  assert.equal(refreshRegistrations, 1);

  inferenceEntries = [["OPENAI_API_KEY", "upstream-provider-secret"]];
  const rejected = await handleCrabhelmRequest(
    new Request(url, { headers: { authorization: `Bearer ${token}` } }),
    env,
    background,
    { runtimeLabel: "portable-test" },
  );
  assert.equal(rejected.status, 503);
  assert.equal(refreshRegistrations, 1);
});

test("Prometheus endpoint requires its machine credential and exports metadata only", async () => {
  const database = memoryStateDatabase();
  let service: CrabhelmControlPlaneService;
  const env = fakeEnv(() => service);
  env.CRABHELM_PROMETHEUS = "on";
  env.METRICS_BEARER_TOKEN = "m".repeat(40);
  service = new CrabhelmControlPlaneService(database, env, {
    async schedule() {},
    restart(): never { throw new Error("unused"); },
  });
  const missing = await handleCrabhelmRequest(
    new Request(`${RUNTIME}/metrics`),
    env,
    background,
    { runtimeLabel: "portable-test" },
  );
  assert.equal(missing.status, 401);
  const response = await handleCrabhelmRequest(
    new Request(`${RUNTIME}/metrics`, {
      headers: { authorization: `Bearer ${env.METRICS_BEARER_TOKEN}` },
    }),
    env,
    background,
    { runtimeLabel: "portable-test" },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /version=0\.0\.4/u);
  const body = await response.text();
  assert.match(body, /crabhelm_claws\{phase="ready"\} 0/u);
  assert.match(body, /crabhelm_clawrouter_routes_verified 0/u);
  assert.doesNotMatch(body, /prompt|completion|message|credential|tool.output/iu);
});

function memoryStateDatabase(): ControlPlaneStateDatabase {
  const stores = new Map<string, StateStore<unknown>>();
  return {
    store<T>(namespace: string): StateStore<T> {
      let store = stores.get(namespace);
      if (!store) {
        store = createMemoryStateStore<unknown>();
        stores.set(namespace, store);
      }
      return store as StateStore<T>;
    },
    transaction: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
  };
}

async function routedRequest(
  env: Env,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("origin", CONSOLE);
  headers.set("sec-fetch-site", "same-origin");
  // Caller-controlled internal identity must be replaced by the verified token.
  headers.set("x-crabhelm-principal-id", "principal:forged");
  headers.set("x-crabhelm-roles", "administrator,forged-role");
  if (init.body) headers.set("content-type", "application/json");
  return handleCrabhelmRequest(
    new Request(`${CONSOLE}${path}`, { ...init, headers }),
    env,
    background,
    { runtimeLabel: "portable-test" },
  );
}

function fakeEnv(currentService: () => CrabhelmControlPlaneService): Env {
  const emptyBucket = {
    async get() { return null; },
    async put() {},
    async delete() {},
  };
  const coordinator = {
    async runtimeStatus() {
      return { connected: 0, pending: 0, running: 0, awaitingDelivery: 0 };
    },
  };
  return {
    APPLIANCES: emptyBucket,
    OAUTH_VAULT: emptyBucket,
    AUDIT_ARCHIVE: emptyBucket,
    AUDIT_QUEUE: { async send() {} },
    ASSETS: { async fetch() { return new Response("asset"); } },
    CONTROL_PLANE: {
      getByName() {
        return {
          fetch: (request: Request) => currentService().fetch(request),
          managedSpec: (clawId: string) => currentService().managedSpec(clawId),
          bootstrapInference: (clawId: string) => currentService().bootstrapInference(clawId),
          inferenceCredentials: (clawId: string, generation: number) =>
            currentService().inferenceCredentials(clawId, generation),
          prometheusMetrics: () => currentService().prometheusMetrics(),
          resolveAccessIdentity: (identity: Parameters<CrabhelmControlPlaneService["resolveAccessIdentity"]>[0]) =>
            currentService().resolveAccessIdentity(identity),
        };
      },
    },
    CLAW_COORDINATOR: { getByName() { return coordinator; } },
    PUBLIC_URL: CONSOLE,
    RUNTIME_URL: RUNTIME,
    CRABBOX_URL: "https://crabbox.example.test",
    CRABBOX_TOKEN: "portable-broker-token",
    CRABBOX_TARGET_ID: "portable",
    CRABBOX_TARGET_LABEL: "Portable target",
    CRABBOX_TARGET_REGION: "test-region-1",
    CRABBOX_PROFILE: "openclaw-core",
    CRABBOX_TTL_SECONDS: "14400",
    CRABBOX_IDLE_TIMEOUT_SECONDS: "14400",
    CRABHELM_EGRESS_LOCKDOWN: "required",
    CRABHELM_CLAWROUTER: "off",
    CRABHELM_PROMETHEUS: "off",
    NODE_RUNTIME_SHA256: DIGEST,
    APPLIANCE_ARCHIVE_SHA256: DIGEST,
    APPLIANCE_MANIFEST_SHA256: DIGEST,
    BOOTSTRAP_SIGNING_SECRET: SIGNING_SECRET,
    SESSION_SIGNING_SECRET: SIGNING_SECRET,
    INVOCATION_SIGNING_SECRET: SIGNING_SECRET,
    RUNTIME_SIGNING_SECRET: SIGNING_SECRET,
    VAULT_MASTER_KEY: VAULT_KEY,
    OPENAI_API_KEY: "test-provider-key",
    SLACK_SIGNING_SECRET: "test-slack-secret",
    GITHUB_OAUTH_CLIENT_ID: "test-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
    CF_ACCESS_TEAM_DOMAIN: "",
    CF_ACCESS_AUD: "",
    CF_ACCESS_ADMIN_EMAILS: "",
    CF_ACCESS_ADMIN_GROUPS: "",
    CRABHELM_PROBE_EMAIL: "",
  } as unknown as Env;
}
