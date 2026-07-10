import assert from "node:assert/strict";
import test from "node:test";
import { childPolicyHash, createClawRecord } from "../src/domain.js";
import {
  buildOperationalProbes,
  childApplyCommand,
  childDrainCommand,
  childHealthCommand,
  childIngressCommand,
  childNodeId,
  childNodeDisplayName,
  childStatusCommand,
  childPairingApproveCommand,
  childPairingListCommand,
  OpenClawNodeControl,
  registerChildCommands,
  registerParentNodePolicy,
} from "../src/node-control.js";

function registrationRuntime(config: Record<string, unknown> = {}) {
  return {
    version: "test-version",
    config: {
      current: () => config,
      async mutateConfigFile<T>(params: {
        mutate(
          draft: Record<string, unknown>,
          context: { previousHash: string | null },
        ): Promise<T> | T;
      }) {
        return { result: await params.mutate(config, { previousHash: "file-hash" }) };
      },
    },
  };
}

test("child status command binds evidence to the configured child id", async () => {
  let handler: ((params?: string | null) => Promise<string>) | undefined;
  registerChildCommands(
    {
      runtime: registrationRuntime({ gateway: { port: 1 } }),
      registerNodeHostCommand(command) {
        if (command.command === childStatusCommand) handler = command.handle;
      },
      registerNodeInvokePolicy() {},
    },
    "child-1",
  );

  assert.ok(handler);
  const response = JSON.parse(await handler(JSON.stringify({ clawId: "child-1" })));
  assert.equal(response.ok, true);
  assert.equal(response.childId, "child-1");
  assert.equal(response.pluginMode, "child");
  assert.equal(response.protocolVersion, 2);
  assert.equal(response.gatewayReady, false);
  assert.equal(response.gatewayVersion, "test-version");
  assert.equal(typeof response.managedHash, "string");
  await assert.rejects(handler(JSON.stringify({ clawId: "other" })), /identity mismatch/);
});

test("child apply command performs managed-field compare-and-swap", async () => {
  const config: Record<string, unknown> = {
    agents: { defaults: { model: "openai/gpt-5.5" } },
    plugins: { allow: "invalid-existing-policy" },
  };
  const handlers = new Map<string, (params?: string | null) => Promise<string>>();
  registerChildCommands(
    {
      runtime: registrationRuntime(config),
      registerNodeHostCommand(command) {
        handlers.set(command.command, command.handle);
      },
      registerNodeInvokePolicy() {},
    },
    "child-1",
  );
  const status = JSON.parse(
    await handlers.get(childStatusCommand)?.(JSON.stringify({ clawId: "child-1" })) ?? "{}",
  );
  const applied = JSON.parse(
    await handlers.get(childApplyCommand)?.(
      JSON.stringify({
        clawId: "child-1",
        generation: 3,
        desiredHash: "desired-hash",
        expectedManagedHash: status.managedHash,
        desired: {
          model: "openai/gpt-5.4-mini",
          fallbackModels: [],
          slackEnabled: false,
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          logLevel: "warn",
          otel: {
            enabled: true,
            endpoint: "https://otel.example.test/v1",
            serviceName: "crabhelm-child-1",
            traces: true,
            metrics: false,
            logs: false,
            sampleRate: 0.2,
            flushIntervalMs: 30_000,
          },
        },
      }),
    ) ?? "{}",
  );

  assert.equal(applied.ok, true);
  assert.equal(applied.generation, 3);
  assert.deepEqual((config.agents as { defaults: { model: unknown } }).defaults.model, {
    primary: "openai/gpt-5.4-mini",
    fallbacks: [],
  });
  assert.equal((config.logging as { level: string }).level, "warn");
  assert.deepEqual((config.plugins as { allow: string[] }).allow, ["crabhelm", "slack", "diagnostics-otel"]);
  assert.equal(
    ((config.plugins as { entries: { "diagnostics-otel": { enabled: boolean } } }).entries["diagnostics-otel"].enabled),
    true,
  );
  assert.deepEqual((config.diagnostics as { enabled: boolean; otel: unknown }), {
    enabled: true,
    otel: {
      enabled: true,
      endpoint: "https://otel.example.test/v1",
      tracesEndpoint: "https://otel.example.test/v1/v1/traces",
      metricsEndpoint: "https://otel.example.test/v1/v1/metrics",
      protocol: "http/protobuf",
      serviceName: "crabhelm-child-1",
      traces: true,
      metrics: false,
      logs: false,
      captureContent: {
        enabled: false,
        inputMessages: false,
        outputMessages: false,
        toolInputs: false,
        toolOutputs: false,
        systemPrompt: false,
        toolDefinitions: false,
      },
      sampleRate: 0.2,
      flushIntervalMs: 30_000,
    },
  });
  assert.equal(
    (((config.plugins as { entries: { crabhelm: { config: Record<string, unknown> } } }).entries
      .crabhelm.config).appliedDesiredHash),
    "desired-hash",
  );
  const converged = JSON.parse(
    await handlers.get(childStatusCommand)?.(JSON.stringify({ clawId: "child-1" })) ?? "{}",
  );
  (config.diagnostics as { enabled: boolean }).enabled = false;
  const disabledGate = JSON.parse(
    await handlers.get(childStatusCommand)?.(JSON.stringify({ clawId: "child-1" })) ?? "{}",
  );
  assert.notEqual(disabledGate.managedHash, converged.managedHash);
  (config.diagnostics as { enabled: boolean }).enabled = true;
  const disableOtelStatus = JSON.parse(
    await handlers.get(childStatusCommand)?.(JSON.stringify({ clawId: "child-1" })) ?? "{}",
  );
  const disabled = JSON.parse(
    await handlers.get(childApplyCommand)?.(JSON.stringify({
      clawId: "child-1",
      generation: 4,
      desiredHash: "disabled-hash",
      expectedManagedHash: disableOtelStatus.managedHash,
      desired: {
        model: "openai/gpt-5.4-mini",
        fallbackModels: [],
        slackEnabled: false,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        logLevel: "warn",
        otel: {
          enabled: false,
          serviceName: "crabhelm-child-1",
          traces: true,
          metrics: false,
          logs: false,
          sampleRate: 0.2,
          flushIntervalMs: 30_000,
        },
      },
    })) ?? "{}",
  );
  assert.equal(disabled.ok, true);
  assert.equal((config.diagnostics as { enabled: boolean }).enabled, false);
});

test("child apply owns the ClawRouter model and origin as one managed setting", async () => {
  const config: Record<string, unknown> = {
    agents: { defaults: { model: "openai/gpt-5.5" } },
    plugins: { allow: ["crabhelm", "slack"] },
  };
  const handlers = new Map<string, (params?: string | null) => Promise<string>>();
  registerChildCommands(
    {
      runtime: registrationRuntime(config),
      registerNodeHostCommand(command) {
        handlers.set(command.command, command.handle);
      },
      registerNodeInvokePolicy() {},
    },
    "child-1",
  );
  const status = JSON.parse(
    await handlers.get(childStatusCommand)?.(JSON.stringify({ clawId: "child-1" })) ?? "{}",
  );
  const apply = handlers.get(childApplyCommand);
  assert.ok(apply);
  const desired = {
    model: "clawrouter/openai/gpt-5.5",
    routerBaseUrl: "https://clawrouter.example.test",
    fallbackModels: [],
    slackEnabled: false,
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    logLevel: "info",
  };
  const applied = JSON.parse(await apply(JSON.stringify({
    clawId: "child-1",
    generation: 2,
    desiredHash: "routed-hash",
    expectedManagedHash: status.managedHash,
    desired,
  })));
  assert.equal(applied.ok, true);
  assert.deepEqual((config.plugins as { allow: string[] }).allow, ["crabhelm", "slack", "clawrouter"]);
  assert.equal(
    ((config.plugins as { entries: { clawrouter: { enabled: boolean } } }).entries.clawrouter.enabled),
    true,
  );
  assert.equal(
    (((config.models as { providers: { clawrouter: { baseUrl: string } } }).providers.clawrouter.baseUrl)),
    "https://clawrouter.example.test",
  );
  await assert.rejects(
    apply(JSON.stringify({
      clawId: "child-1",
      generation: 3,
      desiredHash: "missing-origin",
      expectedManagedHash: "unused",
      desired: { ...desired, routerBaseUrl: undefined },
    })),
    /must select ClawRouter together/u,
  );
});

test("child ingress command disables and restores existing channel states", async () => {
  const config: Record<string, unknown> = {
    channels: {
      slack: { enabled: true },
      telegram: { dmPolicy: "pairing" },
    },
  };
  const handlers = new Map<string, (params?: string | null) => Promise<string>>();
  registerChildCommands(
    {
      runtime: registrationRuntime(config),
      registerNodeHostCommand(command) {
        handlers.set(command.command, command.handle);
      },
      registerNodeInvokePolicy() {},
    },
    "child-1",
  );
  const ingress = handlers.get(childIngressCommand);
  assert.ok(ingress);
  await ingress(JSON.stringify({ clawId: "child-1", enabled: false }));
  const channels = config.channels as Record<string, Record<string, unknown>>;
  assert.equal(channels.slack?.enabled, false);
  assert.equal(channels.telegram?.enabled, false);

  await ingress(JSON.stringify({ clawId: "child-1", enabled: true }));
  assert.equal(channels.slack?.enabled, true);
  assert.equal("enabled" in (channels.telegram ?? {}), false);
});

test("child apply can enable Slack only with child-local credentials", async () => {
  const config: Record<string, unknown> = {
    channels: {
      slack: {
        enabled: false,
        mode: "relay",
        botToken: { source: "env", provider: "default", id: "CRABHELM_TEST_SLACK_BOT_TOKEN" },
        relay: {
          url: "wss://relay.example.test",
          authToken: { source: "env", provider: "default", id: "CRABHELM_TEST_SLACK_RELAY_TOKEN" },
          gatewayId: "child-1",
        },
      },
    },
  };
  const handlers = new Map<string, (params?: string | null) => Promise<string>>();
  registerChildCommands(
    {
      runtime: registrationRuntime(config),
      registerNodeHostCommand(command) {
        handlers.set(command.command, command.handle);
      },
      registerNodeInvokePolicy() {},
    },
    "child-1",
  );
  const status = JSON.parse(
    await handlers.get(childStatusCommand)?.(JSON.stringify({ clawId: "child-1" })) ?? "{}",
  );
  process.env.CRABHELM_TEST_SLACK_BOT_TOKEN = "test-bot-token";
  process.env.CRABHELM_TEST_SLACK_RELAY_TOKEN = "test-relay-token";
  try {
    await handlers.get(childApplyCommand)?.(
      JSON.stringify({
        clawId: "child-1",
        generation: 1,
        desiredHash: "desired-hash",
        expectedManagedHash: status.managedHash,
        desired: {
          model: "openai/gpt-5.5",
          fallbackModels: [],
          slackEnabled: true,
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          logLevel: "info",
        },
      }),
    );
    assert.equal(
      ((config.channels as { slack: { enabled: boolean } }).slack.enabled),
      true,
    );
  } finally {
    delete process.env.CRABHELM_TEST_SLACK_BOT_TOKEN;
    delete process.env.CRABHELM_TEST_SLACK_RELAY_TOKEN;
  }
});

test("child apply rejects syntactic but unresolved Slack secret inputs", async () => {
  const config: Record<string, unknown> = {
    channels: {
      slack: {
        enabled: false,
        mode: "socket",
        botToken: {},
        appToken: {},
      },
    },
  };
  const handlers = new Map<string, (params?: string | null) => Promise<string>>();
  registerChildCommands(
    {
      runtime: registrationRuntime(config),
      registerNodeHostCommand(command) {
        handlers.set(command.command, command.handle);
      },
      registerNodeInvokePolicy() {},
    },
    "child-1",
  );
  const status = JSON.parse(
    await handlers.get(childStatusCommand)?.(JSON.stringify({ clawId: "child-1" })) ?? "{}",
  );
  const apply = handlers.get(childApplyCommand);
  assert.ok(apply);
  const result = JSON.parse(
    await apply(
      JSON.stringify({
        clawId: "child-1",
        generation: 1,
        desiredHash: "desired-hash",
        expectedManagedHash: status.managedHash,
        desired: {
          model: "openai/gpt-5.5",
          fallbackModels: [],
          slackEnabled: true,
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          logLevel: "info",
        },
      }),
    ),
  );
  assert.deepEqual(result.error, { code: "SLACK_CREDENTIALS_UNRESOLVED" });
});

test("parent node policy rejects a paired node with the wrong child name", async () => {
  let policy: ((context: {
    nodeId: string;
    params: unknown;
    node?: { displayName?: string };
    invokeNode(): Promise<unknown>;
  }) => Promise<unknown>) | undefined;
  registerParentNodePolicy({
    runtime: registrationRuntime(),
    registerNodeHostCommand() {},
    registerNodeInvokePolicy(value) {
      policy = value.handle;
    },
  });

  const result = await policy?.({
    nodeId: "wrong-node",
    params: { clawId: "child-1", expectedNodeId: "wrong-node" },
    node: { displayName: "crabhelm:other" },
    async invokeNode() {
      throw new Error("must not invoke");
    },
  });
  assert.deepEqual(result, {
    ok: false,
    code: "CHILD_NODE_MISMATCH",
    message: "paired node display name does not match the requested child",
  });
});

test("node control accepts only native status evidence for the exact child", async () => {
  const claw = createClawRecord({
    name: "Ada",
    owner: { subject: "github:ada", label: "@ada", source: "github" },
  });
  const control = new OpenClawNodeControl({
    async list() {
      return {
        nodes: [
          {
            nodeId: childNodeId(claw.id),
            displayName: childNodeDisplayName(claw.id),
            connected: true,
            commands: [childStatusCommand],
          },
        ],
      };
    },
    async invoke(params) {
      assert.equal(params.nodeId, childNodeId(claw.id));
      assert.equal(params.command, childStatusCommand);
      return {
        ok: true,
        payload: {
          ok: true,
          childId: claw.id,
            pluginMode: "child",
            protocolVersion: 2,
            gatewayReady: false,
            managedHash: "managed-hash",
        },
      };
    },
  });

  const result = await control.inspect(claw);
  assert.equal(result.status, "pending");
  assert.equal(result.controlLink?.nodeId, childNodeId(claw.id));
  assert.equal(result.controlLink?.transport, "openclaw-node");
});

test("node control applies desired state before reporting config convergence", async () => {
  const claw = createClawRecord({
    name: "Model child",
    owner: { subject: "github:model", label: "@model", source: "github" },
    inference: { model: "openai/gpt-5.4-mini" },
    observability: {
      otel: {
        enabled: true,
        endpoint: "https://otel.example.test/v1",
        traces: true,
        metrics: true,
        logs: false,
      },
    },
  });
  let appliedHash: string | undefined;
  let applyCalls = 0;
  let appliedOtel: unknown;
  const control = new OpenClawNodeControl({
    async list() {
      return {
        nodes: [{
          nodeId: childNodeId(claw.id),
          displayName: childNodeDisplayName(claw.id),
          connected: true,
          commands: [childStatusCommand, childApplyCommand, childHealthCommand],
        }],
      };
    },
    async invoke(params) {
      if (params.command === childApplyCommand) {
        applyCalls += 1;
        const apply = params.params as { desiredHash: string; desired: { otel: unknown } };
        appliedHash = apply.desiredHash;
        appliedOtel = apply.desired.otel;
        return { ok: true, payload: { ok: true } };
      }
      if (params.command === childHealthCommand) {
        return {
          ok: true,
          payload: {
            ok: true,
            childId: claw.id,
            protocolVersion: 1,
            probes: buildOperationalProbes(
              { channelAccounts: { slack: [] } },
              { resolvedDefault: claw.desired.inference.model, fallbacks: [], auth: { missingProvidersInUse: [], unusableProfiles: [] } },
              claw.desired.inference.model,
            ),
          },
        };
      }
      return {
        ok: true,
        payload: {
          ok: true,
          childId: claw.id,
          pluginMode: "child",
          protocolVersion: 2,
          gatewayReady: true,
          gatewayVersion: "2026.7.1",
          managedHash: "managed-before",
          ...(appliedHash ? { appliedDesiredHash: appliedHash } : {}),
        },
      };
    },
  });

  const result = await control.inspect(claw);
  assert.equal(applyCalls, 1);
  assert.deepEqual(appliedOtel, claw.desired.observability.otel);
  assert.equal(result.gatewayReady, true);
  assert.equal(result.configHash, appliedHash);
  assert.equal(result.probes?.model.authReady, true);
});

test("node control requires protocol v2 before enabling OpenTelemetry", async () => {
  const claw = createClawRecord({
    name: "Legacy observed child",
    owner: { subject: "github:legacy-observed", label: "@legacy-observed", source: "github" },
    observability: {
      otel: {
        enabled: true,
        endpoint: "https://otel.example.test/v1",
        traces: true,
        metrics: true,
        logs: false,
      },
    },
  });
  let applyCalls = 0;
  const control = new OpenClawNodeControl({
    async list() {
      return { nodes: [{
        nodeId: childNodeId(claw.id),
        displayName: childNodeDisplayName(claw.id),
        connected: true,
        commands: [childStatusCommand, childApplyCommand],
      }] };
    },
    async invoke(params) {
      if (params.command === childApplyCommand) applyCalls += 1;
      return {
        ok: true,
        payload: {
          ok: true,
          childId: claw.id,
          pluginMode: "child",
          protocolVersion: 1,
          gatewayReady: true,
          managedHash: "legacy-managed",
          appliedDesiredHash: "legacy-desired",
        },
      };
    },
  });

  const result = await control.inspect(claw);
  assert.equal(result.status, "pending");
  assert.match(result.message, /plugin upgrade is required/u);
  assert.equal(applyCalls, 0);
});

test("node control preserves allowlisted Slack credential failure codes", async () => {
  const claw = createClawRecord({
    name: "Slack child",
    owner: { subject: "manual:slack", label: "Slack", source: "manual" },
    slack: { enabled: true },
  });
  const control = new OpenClawNodeControl({
    async list() {
      return {
        nodes: [{
          nodeId: childNodeId(claw.id),
          displayName: childNodeDisplayName(claw.id),
          connected: true,
          commands: [childStatusCommand, childApplyCommand, childHealthCommand],
        }],
      };
    },
    async invoke(params) {
      if (params.command === childApplyCommand) {
        return {
          ok: true,
          payload: {
            ok: false,
            childId: claw.id,
            protocolVersion: 1,
            error: { code: "SLACK_CREDENTIALS_UNRESOLVED" },
          },
        };
      }
      return {
        ok: true,
        payload: {
          ok: true,
          childId: claw.id,
          pluginMode: "child",
          protocolVersion: 1,
          gatewayReady: true,
          managedHash: "managed-before",
        },
      };
    },
  });

  await assert.rejects(
    control.inspect(claw),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "SLACK_CREDENTIALS_UNRESOLVED" &&
      error.message === "Child-local Slack credentials are unresolved",
  );
});

test("operational probe sanitizer reports live Slack and model auth without content", () => {
  const probes = buildOperationalProbes(
    {
      channelAccounts: {
        slack: [{
          accountId: "default",
          configured: true,
          running: true,
          connected: true,
          probe: { ok: true, bot: { username: "helper" } },
          audit: { ok: true },
          lastInboundAt: 100,
          lastOutboundAt: 200,
        }],
      },
    },
    {
      defaultModel: "openai/gpt-5.5",
      resolvedDefault: "openai/gpt-5.5",
      fallbacks: [],
      auth: { missingProvidersInUse: [], unusableProfiles: [] },
    },
    "openai/gpt-5.5",
    "2026-07-01T00:00:00.000Z",
  );
  assert.deepEqual(probes.slack, {
    status: "healthy",
    configured: true,
    connected: true,
    accountCount: 1,
    probeOk: true,
    auditOk: true,
    lastInboundAt: 100,
    lastOutboundAt: 200,
  });
  assert.equal(probes.model.status, "ready");
  assert.equal(probes.model.liveInferenceProbe, false);
  assert.equal("messages" in probes, false);
});

test("operational probe sanitizer exposes degraded auth and channel errors", () => {
  const probes = buildOperationalProbes(
    { crabhelmError: "gateway unavailable token=super-secret https://example.test/path?access=secret" },
    {
      resolvedDefault: "openai/gpt-5.5",
      fallbacks: [],
      auth: { missingProvidersInUse: ["openai"], unusableProfiles: [] },
    },
    "openai/gpt-5.5",
  );
  assert.equal(probes.slack.status, "degraded");
  assert.equal(
    probes.slack.lastError,
    "gateway unavailable token=<redacted> https://example.test/path?<redacted>",
  );
  assert.equal(probes.model.authReady, false);
  assert.deepEqual(probes.model.missingProviders, ["openai"]);
});

test("operational probe fails closed on missing model status evidence", () => {
  const probes = buildOperationalProbes({}, {}, "openai/gpt-5.5", "2026-07-01T12:00:00.000Z");

  assert.equal(probes.model.status, "degraded");
  assert.equal(probes.model.authReady, false);
  assert.deepEqual(probes.model.missingProviders, ["model-status-invalid"]);
});

test("operational probe fails closed on malformed model status arrays", () => {
  const probes = buildOperationalProbes(
    {},
    {
      resolvedDefault: "openai/gpt-5.5",
      fallbacks: [42],
      auth: { missingProvidersInUse: [42], unusableProfiles: [] },
    },
    "openai/gpt-5.5",
    "2026-07-01T12:00:00.000Z",
  );

  assert.equal(probes.model.authReady, false);
  assert.deepEqual(probes.model.missingProviders, ["model-status-invalid"]);
});

test("operational probe verifies fallback model evidence and auth", () => {
  const probes = buildOperationalProbes(
    {},
    {
      resolvedDefault: "openai/gpt-5.5",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
      auth: {
        missingProvidersInUse: [],
        unusableProfiles: [{ provider: "anthropic" }],
      },
    },
    "openai/gpt-5.5",
    "2026-07-01T12:00:00.000Z",
    undefined,
    ["anthropic/claude-sonnet-4-6"],
  );

  assert.equal(probes.model.authReady, false);
  assert.equal(probes.model.unusableProfileCount, 1);
});

test("node control stays pending when drift cannot be applied", async () => {
  const claw = createClawRecord({
    name: "Stale child",
    owner: { subject: "github:stale", label: "@stale", source: "github" },
  });
  const control = new OpenClawNodeControl({
    async list() {
      return {
        nodes: [{
          nodeId: childNodeId(claw.id),
          displayName: childNodeDisplayName(claw.id),
          connected: true,
          commands: [childStatusCommand],
        }],
      };
    },
    async invoke() {
      return {
        ok: true,
        payload: {
          ok: true,
          childId: claw.id,
          pluginMode: "child",
          protocolVersion: 1,
          gatewayReady: true,
          managedHash: "managed",
          appliedDesiredHash: "stale",
        },
      };
    },
  });
  const evidence = await control.inspect(claw);
  assert.equal(evidence.status, "pending");
  assert.match(evidence.message, /not advertised/);
});

test("node control confirms ingress disable through the exact paired child", async () => {
  const claw = createClawRecord({
    name: "Disable child",
    owner: { subject: "github:disable", label: "@disable", source: "github" },
  });
  let ingressDisabled = false;
  const control = new OpenClawNodeControl({
    async list() {
      return {
        nodes: [{
          nodeId: childNodeId(claw.id),
          displayName: childNodeDisplayName(claw.id),
          connected: true,
          commands: [childStatusCommand, childIngressCommand],
        }],
      };
    },
    async invoke(params) {
      if (params.command === childIngressCommand) {
        ingressDisabled = !(params.params as { enabled: boolean }).enabled;
        return { ok: true, payload: { ok: true } };
      }
      return {
        ok: true,
        payload: {
          ok: true,
          childId: claw.id,
          pluginMode: "child",
          protocolVersion: 1,
          gatewayReady: true,
          managedHash: "managed",
          ingressDisabled,
        },
      };
    },
  });

  const evidence = await control.disable(claw);
  assert.equal(evidence.ingressDisabled, true);
  assert.equal(evidence.controlLink?.nodeId, childNodeId(claw.id));
});

test("read-only deletion inspection never re-enables disabled ingress", async () => {
  const claw = createClawRecord({
    name: "Deleting child",
    owner: { subject: "github:deleting", label: "@deleting", source: "github" },
  });
  let ingressCalls = 0;
  const control = new OpenClawNodeControl({
    async list() {
      return {
        nodes: [{
          nodeId: childNodeId(claw.id),
          displayName: childNodeDisplayName(claw.id),
          connected: true,
          commands: [childStatusCommand, childIngressCommand],
        }],
      };
    },
    async invoke(params) {
      if (params.command === childIngressCommand) ingressCalls += 1;
      return {
        ok: true,
        payload: {
          ok: true,
          childId: claw.id,
          pluginMode: "child",
          protocolVersion: 1,
          gatewayReady: true,
          managedHash: "managed",
          ingressDisabled: true,
        },
      };
    },
  });

  const evidence = await control.inspect(claw, { reconcileDesired: false });
  assert.equal(evidence.ingressDisabled, true);
  assert.equal(ingressCalls, 0);
});

test("node control accepts only identity-bound active-run drain evidence", async () => {
  const claw = createClawRecord({
    name: "Draining child",
    owner: { subject: "github:draining", label: "@draining", source: "github" },
  });
  let activeRuns = 2;
  const control = new OpenClawNodeControl({
    async list() {
      return {
        nodes: [{
          nodeId: childNodeId(claw.id),
          displayName: childNodeDisplayName(claw.id),
          connected: true,
          commands: [childDrainCommand],
        }],
      };
    },
    async invoke(params) {
      assert.equal(params.command, childDrainCommand);
      return {
        ok: true,
        payload: {
          ok: true,
          childId: claw.id,
          protocolVersion: 1,
          activeRuns,
          drained: activeRuns === 0,
          checkedAt: new Date().toISOString(),
        },
      };
    },
  });

  const busy = await control.drain(claw);
  assert.equal(busy.drained, false);
  assert.equal(busy.activeRuns, 2);
  activeRuns = 0;
  const drained = await control.drain(claw);
  assert.equal(drained.drained, true);
  assert.equal(drained.activeRuns, 0);
});

test("node control rejects inconsistent or cross-child drain evidence", async () => {
  const claw = createClawRecord({
    name: "Bound drain",
    owner: { subject: "github:bound-drain", label: "@bound", source: "github" },
  });
  const control = new OpenClawNodeControl({
    async list() {
      return {
        nodes: [{
          nodeId: childNodeId(claw.id),
          displayName: childNodeDisplayName(claw.id),
          connected: true,
          commands: [childDrainCommand],
        }],
      };
    },
    async invoke() {
      return {
        ok: true,
        payload: {
          ok: true,
          childId: "other-child",
          protocolVersion: 1,
          activeRuns: 0,
          drained: true,
          checkedAt: new Date().toISOString(),
        },
      };
    },
  });

  await assert.rejects(
    control.drain(claw),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "CHILD_DRAIN_INVALID",
  );
});

test("node control removes exact native parent device pairing and confirms absence", async () => {
  const claw = createClawRecord({
    name: "Revoked child",
    owner: { subject: "github:revoked", label: "@revoked", source: "github" },
  });
  const nodeId = childNodeId(claw.id);
  const calls: string[][] = [];
  let cleaned = false;
  const control = new OpenClawNodeControl(
    {
      async list() {
        return { nodes: [] };
      },
      async invoke() {
        throw new Error("must not invoke a released child");
      },
    },
    {
      async runOpenClawCli(args) {
        calls.push(args);
        if (args[0] === "devices" && args[1] === "reject") return JSON.stringify({ ok: true });
        if (args[0] === "devices" && args[1] === "remove") {
          cleaned = true;
          return JSON.stringify({ ok: true });
        }
        return JSON.stringify(cleaned
          ? { paired: [], pending: [] }
          : {
              paired: [{
                deviceId: nodeId,
                displayName: childNodeDisplayName(claw.id),
                roles: ["node"],
              }],
              pending: [{
                requestId: "request-1",
                deviceId: nodeId,
                displayName: childNodeDisplayName(claw.id),
                role: "node",
              }],
            });
      },
    },
  );

  const result = await control.revokePairing(claw);
  assert.equal(result.removedPairedDevice, true);
  assert.equal(result.rejectedPendingRequest, true);
  assert.deepEqual(calls, [
    ["devices", "list", "--json"],
    ["devices", "reject", "request-1", "--json"],
    ["devices", "remove", nodeId, "--json"],
    ["devices", "list", "--json"],
  ]);
});

test("node control refuses whole-device cleanup for a mixed-role native identity", async () => {
  const claw = createClawRecord({
    name: "Role fence",
    owner: { subject: "github:role-fence", label: "@role", source: "github" },
  });
  const calls: string[][] = [];
  const control = new OpenClawNodeControl(
    {
      async list() {
        return { nodes: [] };
      },
      async invoke() {
        throw new Error("not used");
      },
    },
    {
      async runOpenClawCli(args) {
        calls.push(args);
        return JSON.stringify({
          paired: [{
            deviceId: childNodeId(claw.id),
            displayName: childNodeDisplayName(claw.id),
            roles: ["node", "operator"],
          }],
          pending: [],
        });
      },
    },
  );

  await assert.rejects(control.revokePairing(claw), /does not belong to the expected child node/);
  assert.deepEqual(calls, [["devices", "list", "--json"]]);
});

test("node control rejects a lookalike node with the wrong immutable id", async () => {
  const claw = createClawRecord({
    name: "Bound child",
    owner: { subject: "github:bound", label: "@bound", source: "github" },
  });
  const control = new OpenClawNodeControl({
    async list() {
      return {
        nodes: [{
          nodeId: "attacker-node",
          displayName: childNodeDisplayName(claw.id),
          connected: true,
          commands: [childStatusCommand],
        }],
      };
    },
    async invoke() {
      throw new Error("must not invoke");
    },
  });
  await assert.rejects(control.inspect(claw), /wrong immutable node id/);
});

test("node control lists and approves native Slack pairing on the enrolled child", async () => {
  const claw = createClawRecord({
    name: "Slack child",
    owner: { subject: "github:slack", label: "@slack", source: "github" },
  });
  const request = {
    code: "ABC123",
    id: "U012345",
    createdAt: "2026-07-01T00:00:00.000Z",
    accountId: "default",
  };
  const control = new OpenClawNodeControl({
    async list() {
      return {
        nodes: [{
          nodeId: childNodeId(claw.id),
          displayName: childNodeDisplayName(claw.id),
          connected: true,
          commands: [childPairingListCommand, childPairingApproveCommand],
        }],
      };
    },
    async invoke(params) {
      assert.equal(
        (params.params as { expectedNodeId: string }).expectedNodeId,
        childNodeId(claw.id),
      );
      return {
        ok: true,
        payload: {
          ok: true,
          childId: claw.id,
          protocolVersion: 1,
          channel: "slack",
          ...(params.command === childPairingListCommand
            ? { requests: [request] }
            : { approved: request }),
        },
      };
    },
  });

  const listed = await control.listPairing(claw);
  assert.deepEqual(listed.requests, [request]);
  const approved = await control.approvePairing(claw, { code: "ABC123" });
  assert.deepEqual(approved.approved, request);
});
