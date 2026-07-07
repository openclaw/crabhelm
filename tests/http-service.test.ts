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
import { signClaims } from "../worker/security.js";

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
    { RUNTIME_URL: RUNTIME, SLACK_SIGNING_SECRET: "unused" } as Env,
    background,
    { runtimeLabel: "portable-test" },
  );

  assert.equal(response.status, 413);
  assert.equal(await response.text(), "payload too large");
  assert.equal(cancelled, true);
  assert.ok(chunks >= 3 && chunks < 10);
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
    CRABHELM_MODEL_PROXY: "off",
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
