import assert from "node:assert/strict";
import test from "node:test";
import { childPolicyHash, createClawRecord } from "../src/domain.js";
import type { OpenClawNodeControl } from "../src/node-control.js";
import {
  crabboxWorkspaceId,
  CrabboxChildCoreProvider,
  createConfiguredCrabboxTargetProvider,
  RoutedChildCoreProvider,
  SimulatorChildCoreProvider,
} from "../src/providers.js";

test("Crabbox provider sends a fixed OpenClaw appliance request", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const provider = new CrabboxChildCoreProvider({
    baseUrl: "https://crabbox.example.test/adapter",
    token: "test-token",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: "crabhelm-ada",
          status: "ready",
          providerResourceId: "applied/ada-box",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    },
  });
  const claw = createClawRecord({
    name: "Ada",
    owner: { subject: "github:ada", label: "@ada", source: "github" },
  });
  const result = await provider.provision(claw);

  assert.equal(capturedUrl, "https://crabbox.example.test/adapter/v1/workspaces");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(
    new Headers(capturedInit?.headers).get("idempotency-key"),
    "crabhelm-ada",
  );
  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.id, "crabhelm-ada");
  assert.equal(body.profile, "openclaw-core");
  assert.equal(body.owner, "github:ada");
  assert.equal(body.capabilities.desktop, false);
  assert.equal(body.capabilities.browser, false);
  assert.equal(body.capabilities.code, false);
  assert.equal("command" in body, false);
  assert.equal("provider" in body, false);
  assert.equal(result.phase, "enrolling");
  assert.equal(result.lifecycle.providerResourceId, "applied/ada-box");
  assert.equal(result.lifecycle.responseDigest.length, 64);
});

test("Crabbox provider refuses insecure non-loopback control planes", () => {
  assert.throws(
    () =>
      new CrabboxChildCoreProvider({
        baseUrl: "http://crabbox.example.test",
        token: "test-token",
        profile: "openclaw-core",
        ttlSeconds: 14_400,
        idleTimeoutSeconds: 14_400,
      }),
    /HTTPS or loopback/,
  );
});

test("Crabbox provider rejects a create response already stopping", async () => {
  const provider = new CrabboxChildCoreProvider({
    baseUrl: "https://crabbox.example.test",
    token: "test-token",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
    fetch: async () => new Response(
      JSON.stringify({ id: "crabhelm-failed-create", status: "stopping" }),
      { status: 201, headers: { "content-type": "application/json" } },
    ),
  });
  const claw = createClawRecord({
    name: "Failed create",
    owner: { subject: "manual:failed-create", label: "Failed", source: "manual" },
  });

  await assert.rejects(
    provider.provision(claw),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "CRABBOX_CREATE_STATE" &&
      /stopping/.test(error.message),
  );
});

test("Crabbox provider rejects create success without lifecycle state", async () => {
  const provider = new CrabboxChildCoreProvider({
    baseUrl: "https://crabbox.example.test",
    token: "test-token",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
    fetch: async () => new Response(
      JSON.stringify({ id: "crabhelm-missing-state" }),
      { status: 201, headers: { "content-type": "application/json" } },
    ),
  });
  const claw = createClawRecord({
    name: "Missing state",
    owner: { subject: "manual:missing-state", label: "Missing", source: "manual" },
  });

  await assert.rejects(provider.provision(claw), /no lifecycle state/);
});

test("one invalid target configuration degrades locally instead of throwing", async () => {
  const result = createConfiguredCrabboxTargetProvider("broken", {
    baseUrl: "http://remote.example.test/path?unsafe=true",
    token: "test-token",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
  });
  assert.equal(result.admissionOpen, false);
  assert.equal(result.message, "Crabbox configuration is invalid for deployment target broken");
  const claw = createClawRecord({
    name: "Broken",
    owner: { subject: "manual:broken", label: "Broken", source: "manual" },
  });
  await assert.rejects(result.provider.provision(claw), /invalid for deployment target broken/);
});

test("Crabbox stopped status is explicit provider-absence evidence", async () => {
  const provider = new CrabboxChildCoreProvider({
    baseUrl: "https://crabbox.example.test",
    token: "test-token",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
    fetch: async () =>
      new Response(
        JSON.stringify({
          id: "crabhelm-ada",
          status: "stopped",
          message: "Provider absent; history retained",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const claw = createClawRecord({
    name: "Ada",
    owner: { subject: "github:ada", label: "@ada", source: "github" },
  });
  claw.observed.lifecycle = {
    workspaceId: "crabhelm-ada",
    responseDigest: "digest",
  };

  assert.deepEqual(await provider.inspect(claw), {
    absent: true,
    message: "Crabbox provider reports stopped",
  });
});

test("Crabbox failed status exposes only allowlisted bootstrap diagnostics", async () => {
  const provider = new CrabboxChildCoreProvider({
    baseUrl: "https://crabbox.example.test",
    token: "test-token",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
    fetch: async () => Response.json({ id: "crabhelm-failed", status: "failed", message: "remote output secret=hidden CRABHELM_INSTALL_FAILED_BOOTSTRAP" }),
  });
  const claw = createClawRecord({ name: "Failed", owner: { subject: "github:failed", label: "@failed", source: "github" } });
  claw.observed.lifecycle = { workspaceId: "crabhelm-failed", responseDigest: "digest" };
  await assert.rejects(provider.inspect(claw), (error: Error) => {
    assert.match(error.message, /CRABHELM_INSTALL_FAILED_BOOTSTRAP/u);
    assert.doesNotMatch(error.message, /secret=hidden/u);
    return true;
  });

  const categorized = new CrabboxChildCoreProvider({
    baseUrl: "https://crabbox.example.test", token: "test-token", profile: "openclaw-core", ttlSeconds: 14_400, idleTimeoutSeconds: 14_400,
    fetch: async () => Response.json({ id: "crabhelm-failed", status: "failed", error: { code: "command_failed", message: "private command exited with status 1 secret=hidden" } }),
  });
  await assert.rejects(categorized.inspect(claw), (error: Error) => {
    assert.match(error.message, /PROVIDER_COMMAND_EXIT/u);
    assert.doesNotMatch(error.message, /secret=hidden/u);
    return true;
  });
});

test("deletion recovers the deterministic Crabbox identity if provisioning evidence raced", async () => {
  let requestedUrl = "";
  const provider = new CrabboxChildCoreProvider({
    baseUrl: "https://crabbox.example.test",
    token: "test-token",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
    fetch: async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({ id: "crabhelm-race", status: "stopped" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const claw = createClawRecord({
    name: "Race",
    owner: { subject: "github:race", label: "@race", source: "github" },
  });
  claw.observed.deletion = {
    stage: "disable",
    requestedAt: new Date().toISOString(),
  };
  const workspaceId = crabboxWorkspaceId(claw);

  await provider.inspect(claw, { reconcileDesired: false });
  assert.equal(
    requestedUrl,
    `https://crabbox.example.test/v1/workspaces/${encodeURIComponent(workspaceId)}`,
  );
});

test("long claw slugs produce valid, collision-fenced Crabbox ids", () => {
  const claw = createClawRecord({
    name: "A".repeat(80),
    owner: { subject: "github:long", label: "@long", source: "github" },
  });
  const id = crabboxWorkspaceId(claw);
  assert.ok(id.length <= 63);
  assert.match(id, /^crabhelm-[a-z0-9-]+-[a-f0-9]{8}$/);
});

test("Crabbox provider requires exact policy and enabled-ingress evidence for convergence", async () => {
  const claw = createClawRecord({
    name: "Evidence",
    owner: { subject: "github:evidence", label: "@evidence", source: "github" },
  });
  claw.observed.lifecycle = { workspaceId: "crabhelm-evidence", responseDigest: "digest" };
  let configHash = "stale";
  let ingressDisabled = false;
  let authReady = true;
  const nodeControl = {
    async inspect() {
      return {
        status: "paired" as const,
        message: "node evidence",
        gatewayReady: true,
        configHash,
        ingressDisabled,
        probes: {
          checkedAt: new Date().toISOString(),
          slack: { status: "unconfigured" as const, configured: false, connected: false, accountCount: 0 },
          model: {
            status: authReady ? "ready" as const : "degraded" as const,
            configuredModel: claw.desired.inference.model,
            authReady,
            liveInferenceProbe: false as const,
            missingProviders: authReady ? [] : ["openai"],
            unusableProfileCount: 0,
          },
        },
      };
    },
  } as unknown as OpenClawNodeControl;
  const provider = new CrabboxChildCoreProvider({
    baseUrl: "https://crabbox.example.test",
    token: "test-token",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
    nodeControl,
    fetch: async () => new Response(
      JSON.stringify({ id: "crabhelm-evidence", status: "running" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  });

  assert.equal((await provider.inspect(claw)).phase, "enrolling");
  configHash = childPolicyHash(claw);
  ingressDisabled = true;
  assert.equal((await provider.inspect(claw)).phase, "enrolling");
  ingressDisabled = false;
  assert.equal((await provider.inspect(claw)).phase, "ready");
  authReady = false;
  const degraded = await provider.inspect(claw);
  assert.equal(degraded.phase, "attention");
  assert.equal(degraded.health, "degraded");
});

test("Crabbox provider delegates standalone lifecycle evidence to its workspace adapter", async () => {
  const claw = createClawRecord({
    name: "Standalone",
    owner: { subject: "github:standalone", label: "@standalone", source: "github" },
  });
  const calls: string[] = [];
  const provider = new CrabboxChildCoreProvider({
    baseUrl: "https://crabbox.example.test",
    token: "test-token",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
    workspaceBootstrap: {
      async command() { return "true"; },
      async inspect() { return { ready: true, message: "ready" }; },
      async disable() {
        calls.push("disable");
        return { applied: true, health: "healthy", message: "disabled" };
      },
      async drain() {
        calls.push("drain");
        return { drained: true, activeRuns: 0, checkedAt: new Date().toISOString(), message: "drained" };
      },
      async revokeControl() {
        calls.push("revoke");
        return {
          removedPairedDevice: false,
          rejectedPendingRequest: false,
          alreadyAbsent: true,
          message: "absent",
        };
      },
    },
  });

  assert.equal((await provider.disable(claw)).applied, true);
  assert.equal((await provider.drain(claw)).activeRuns, 0);
  assert.equal((await provider.revokeControl(claw)).alreadyAbsent, true);
  assert.deepEqual(calls, ["disable", "drain", "revoke"]);
});

test("standalone workspace keeps central Slack ingress out of the child", async () => {
  const claw = createClawRecord({
    name: "Slack standalone",
    owner: { subject: "github:slack", label: "@slack", source: "github" },
    slack: { enabled: true, mode: "socket" },
  });
  claw.observed.lifecycle = {
    workspaceId: "crabhelm-slack-standalone",
    responseDigest: "a".repeat(64),
  };
  const provider = new CrabboxChildCoreProvider({
    baseUrl: "https://crabbox.example.test",
    token: "test-token",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
    workspaceBootstrap: {
      async command() { return "true"; },
      async inspect() { return { ready: true, message: "gateway ready" }; },
    },
    fetch: async () => Response.json({
      workspace: {
        id: "crabhelm-slack-standalone",
        status: "ready",
        attachUrl: "wss://crabbox.example.test/attach",
      },
    }),
  });

  const result = await provider.inspect(claw);
  assert.equal(result.phase, "ready");
  assert.equal(result.health, "healthy");
  assert.equal(result.probes?.slack.status, "unconfigured");
  assert.equal(result.probes?.slack.configured, false);
});

test("routed provider dispatches only through the exact administrator target tuple", async () => {
  const west = new SimulatorChildCoreProvider();
  const europe = new SimulatorChildCoreProvider();
  let westCalls = 0;
  let europeCalls = 0;
  const router = new RoutedChildCoreProvider({
    west: {
      profile: "openclaw-core",
      region: "us-west",
      provider: {
        provision: async (claw) => { westCalls += 1; return west.provision(claw); },
        inspect: (claw) => west.inspect(claw),
        disable: (claw) => west.disable(claw),
        drain: (claw) => west.drain(claw),
        remove: (claw) => west.remove(claw),
        revokeControl: (claw) => west.revokeControl(claw),
      },
    },
    europe: {
      profile: "openclaw-core-eu",
      region: "eu-central",
      provider: {
        provision: async (claw) => { europeCalls += 1; return europe.provision(claw); },
        inspect: (claw) => europe.inspect(claw),
        disable: (claw) => europe.disable(claw),
        drain: (claw) => europe.drain(claw),
        remove: (claw) => europe.remove(claw),
        revokeControl: (claw) => europe.revokeControl(claw),
      },
    },
  });
  const claw = createClawRecord({
    name: "Placed",
    owner: { subject: "github:placed", label: "@placed", source: "github" },
    deployment: { target: "europe", profile: "openclaw-core-eu", region: "eu-central" },
  });
  await router.provision(claw);
  assert.equal(westCalls, 0);
  assert.equal(europeCalls, 1);

  claw.desired.deployment.profile = "openclaw-core";
  await assert.rejects(router.provision(claw), /does not match its administrator policy/);
  claw.desired.deployment.target = "missing";
  await assert.rejects(router.provision(claw), /target missing is unavailable/);
});
