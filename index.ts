import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveCrabhelmConfig,
  type CrabhelmConfig,
  type CrabhelmRuntime,
} from "./src/config.js";
import { createCrabhelmApiHandler, createCrabhelmStaticHandler } from "./src/http.js";
import { GitHubRestMemberSource } from "./src/github.js";
import {
  OpenClawNodeControl,
  registerChildCommands,
  registerParentNodePolicy,
} from "./src/node-control.js";
import {
  createConfiguredCrabboxTargetProvider,
  RoutedChildCoreProvider,
  SimulatorChildCoreProvider,
  UnconfiguredChildCoreProvider,
  type ChildCoreProvider,
} from "./src/providers.js";
import { CrabhelmReconciler } from "./src/reconciler.js";
import { CrabhelmRegistry } from "./src/registry.js";
import path from "node:path";
import { SqliteStateDatabase } from "./src/state.js";
import { crabhelmApprovalCopy, createCrabhelmTool, isCrabhelmMutation } from "./src/tool.js";
import type {
  AuditEvent,
  ClawRecord,
  CreateClawInput,
  CreatePolicyInput,
  PolicyTemplate,
  UpdateClawInput,
} from "./src/types.js";

export default definePluginEntry({
  id: "crabhelm",
  name: "Crabhelm",
  description: "Parent-core control plane for independently deployed OpenClaw child cores.",
  register(api) {
    const config = resolveCrabhelmConfig(api.pluginConfig);
    if (config.mode === "child") {
      if (!config.childId) {
        api.logger.error?.("Crabhelm child mode requires an immutable childId; node command not registered");
        return;
      }
      registerChildCommands(api, config.childId);
      api.logger.info?.(`Crabhelm child node commands registered for ${config.childId}`);
      return;
    }
    registerParentNodePolicy(api);

    const stateRoot = path.join(api.runtime.state.resolveStateDir(), "plugins", "crabhelm");
    const databasePath = path.join(stateRoot, "crabhelm.sqlite");
    const state = new SqliteStateDatabase(databasePath);
    const deploymentTargets = Object.fromEntries(
      config.deployment.targets.map((target) => [
        target.id,
        { profile: target.profile, ...(target.region ? { region: target.region } : {}) },
      ]),
    );
    const defaultTarget = config.deployment.targets.find(
      (target) => target.id === config.deployment.defaultTarget,
    )!;
    const registry = new CrabhelmRegistry(
      state.store<ClawRecord>("claws-v1", 10_000),
      state.store<AuditEvent>("audit-v1", 50_000, { overflow: "evict-oldest" }),
      {
        deploymentTargets,
        defaultDeployment: {
          target: defaultTarget.id,
          profile: defaultTarget.profile,
          ...(defaultTarget.region ? { region: defaultTarget.region } : {}),
        },
        policies: state.store<PolicyTemplate>("policies-v1", 1_000),
        transaction: state.transaction,
      },
    );
    const nodeControl = new OpenClawNodeControl(api.runtime.nodes);
    const deployment = resolveProvider(config.deployment, nodeControl);
    const githubToken = process.env[config.github.tokenEnv];
    const githubSource = githubToken
      ? new GitHubRestMemberSource({
          baseUrl: config.github.apiUrl,
          token: githubToken,
          maxMembers: config.github.maxMembers,
        })
      : undefined;
    const provider = deployment.provider;
    const reconciler = new CrabhelmReconciler(registry, provider);
    const runtime: CrabhelmRuntime = {
      ...deployment.runtime,
      githubImport: Boolean(githubSource),
    };
    const assertCanCreate = (target = runtime.defaultTarget) => {
      const configured = runtime.targets.find((item) => item.id === target);
      if (!configured) throw new Error(`deployment target ${target} is not configured`);
      if (!configured.admissionOpen) throw new Error(configured.message ?? `deployment target ${target} is unavailable`);
    };
    const snapshot = async () => ({ ...(await registry.snapshot()), runtime });

    api.registerTool(createCrabhelmTool({
      registry,
      reconciler,
      nodeControl,
      githubSource,
      assertCanCreate,
      runtime,
    }));
    api.on("before_tool_call", async (event) => {
      if (event.toolName !== "crabhelm" || !isCrabhelmMutation(event.params)) return;
      const copy = crabhelmApprovalCopy(event.params, runtime.defaultTarget);
      return {
        requireApproval: {
          ...copy,
          allowedDecisions: ["allow-once", "deny"],
          timeoutMs: 120_000,
          timeoutBehavior: "deny",
        },
      };
    });

    api.registerGatewayMethod(
      "crabhelm.state",
      async ({ respond }) => respond(true, await snapshot()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "crabhelm.get",
      async ({ params, respond }) =>
        respond(true, await safeCall(() => registry.get(readRequiredString(params, "id")))),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "crabhelm.create",
      async ({ params, respond }) =>
        respond(
          true,
          await safeCall(async () => {
            const spec = asRecord(params).spec as CreateClawInput;
            assertCanCreate(spec.deployment?.target);
            const claw = await registry.create(spec, "gateway-operator");
            return reconciler.reconcileOne(claw.id);
          }),
        ),
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "crabhelm.update",
      async ({ params, respond }) =>
        respond(
          true,
          await safeCall(async () => {
            const raw = asRecord(params);
            const claw = await registry.update(
              readRequiredString(raw, "id"),
              raw.patch as UpdateClawInput,
              "gateway-operator",
            );
            return reconciler.reconcileOne(claw.id);
          }),
        ),
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "crabhelm.reconcile",
      async ({ params, respond }) =>
        respond(
          true,
          await safeCall(() => reconciler.reconcileOne(readRequiredString(params, "id"))),
        ),
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "crabhelm.policy.create",
      async ({ params, respond }) =>
        respond(
          true,
          await safeCall(() => registry.createPolicy(asRecord(params).spec as CreatePolicyInput, "gateway-operator")),
        ),
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "crabhelm.policy.preview",
      async ({ params, respond }) => {
        const raw = asRecord(params);
        respond(
          true,
          await safeCall(() => registry.previewPolicy(
            readRequiredString(raw, "policyId"),
            readRequiredInteger(raw, "version"),
            readStringArray(raw, "clawIds"),
          )),
        );
      },
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "crabhelm.policy.version",
      async ({ params, respond }) => {
        const raw = asRecord(params);
        respond(
          true,
          await safeCall(() => registry.addPolicyVersion(
            readRequiredString(raw, "policyId"),
            asRecord(raw.spec) as unknown as Pick<CreatePolicyInput, "description" | "spec">,
            "gateway-operator",
          )),
        );
      },
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "crabhelm.policy.apply",
      async ({ params, respond }) => {
        const raw = asRecord(params);
        respond(
          true,
          await safeCall(async () => {
            const policyId = readRequiredString(raw, "policyId");
            const version = readRequiredInteger(raw, "version");
            const clawIds = readStringArray(raw, "clawIds");
            const expectedGenerations = readGenerationMap(raw.expectedGenerations, clawIds);
            const canaryId = typeof raw.canaryId === "string" && raw.canaryId.trim()
              ? raw.canaryId.trim()
              : undefined;
            if (canaryId && !clawIds.includes(canaryId)) {
              throw new Error("canaryId must be one of clawIds");
            }
            if (clawIds.length > 1 && !canaryId) {
              throw new Error("canaryId is required when applying a policy to multiple claws");
            }
            const results: Array<{ clawId: string; ok: boolean; canary: boolean; claw?: ClawRecord; error?: string }> = [];
            if (canaryId) {
              await registry.applyPolicy(
                policyId,
                version,
                [canaryId],
                expectedGenerations,
                "gateway-operator",
              );
              const canary = await reconcilePolicyTarget(reconciler, canaryId, true);
              results.push(canary);
              if (!canary.ok) {
                return {
                  policyId,
                  version,
                  canaryId,
                  aborted: true,
                  remainingNotApplied: clawIds.filter((id) => id !== canaryId),
                  results,
                };
              }
            }
            const remaining = clawIds.filter((id) => id !== canaryId);
            if (remaining.length) {
              await registry.applyPolicy(
                policyId,
                version,
                remaining,
                expectedGenerations,
                "gateway-operator",
              );
              results.push(...await mapConcurrent(
                remaining,
                3,
                (clawId) => reconcilePolicyTarget(reconciler, clawId, false),
              ));
            }
            return {
              policyId,
              version,
              canaryId,
              aborted: false,
              requested: results.length,
              succeeded: results.filter((result) => result.ok).length,
              failed: results.filter((result) => !result.ok).length,
              results,
            };
          }),
        );
      },
      { scope: "operator.admin" },
    );

    api.registerHttpRoute({
      path: "/plugins/crabhelm/ui",
      auth: "plugin",
      match: "prefix",
      handler: createCrabhelmStaticHandler(api.rootDir ?? process.cwd()),
    });
    api.registerHttpRoute({
      path: "/plugins/crabhelm/api",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createCrabhelmApiHandler({
        registry,
        reconciler,
        nodeControl,
        githubSource,
        runtime,
        assertCanCreate,
      }),
    });

    let timer: NodeJS.Timeout | undefined;
    api.registerService({
      id: "crabhelm-parent-reconciler",
      async start() {
        await reconciler.reconcileAll();
        timer = setInterval(
          () => void reconciler.reconcileAll().catch((error) => api.logger.error?.(String(error))),
          config.reconcileIntervalSeconds * 1000,
        );
        timer.unref?.();
      },
      stop() {
        if (timer) clearInterval(timer);
        timer = undefined;
      },
    });

    api.session.controls.registerControlUiDescriptor({
      id: "crabhelm-fleet",
      surface: "settings",
      label: "Crabhelm fleet",
      description: "Operate independently deployed OpenClaw child cores.",
      placement: "/plugins/crabhelm/ui/",
      requiredScopes: ["operator.read"],
    });
  },
});

function resolveProvider(config: CrabhelmConfig["deployment"], nodeControl: OpenClawNodeControl): {
  provider: ChildCoreProvider;
  runtime: Omit<CrabhelmRuntime, "githubImport">;
} {
  const routed: Record<string, { profile: string; region?: string; provider: ChildCoreProvider }> = {};
  const targets = config.targets.map((target) => {
    let provider: ChildCoreProvider;
    let admissionOpen = true;
    let message: string | undefined;
    if (config.simulator) {
      provider = new SimulatorChildCoreProvider();
    } else if (!target.crabboxUrl) {
      admissionOpen = false;
      message = `Crabbox URL is missing for deployment target ${target.id}`;
      provider = new UnconfiguredChildCoreProvider(message);
    } else {
      const token = process.env[target.tokenEnv];
      if (!token) {
        admissionOpen = false;
        message = `Crabbox token is unavailable for deployment target ${target.id}`;
        provider = new UnconfiguredChildCoreProvider(message);
      } else {
        const configured = createConfiguredCrabboxTargetProvider(target.id, {
          baseUrl: target.crabboxUrl,
          token,
          profile: target.profile,
          ttlSeconds: target.ttlSeconds,
          idleTimeoutSeconds: target.idleTimeoutSeconds,
          nodeControl,
        });
        provider = configured.provider;
        admissionOpen = configured.admissionOpen;
        message = configured.message;
      }
    }
    routed[target.id] = {
      profile: target.profile,
      ...(target.region ? { region: target.region } : {}),
      provider,
    };
    return {
      id: target.id,
      label: target.label,
      ...(target.region ? { region: target.region } : {}),
      profile: target.profile,
      ttlSeconds: target.ttlSeconds,
      idleTimeoutSeconds: target.idleTimeoutSeconds,
      admissionOpen,
      ...(message ? { message } : {}),
    };
  });
  const available = targets.filter((target) => target.admissionOpen).length;
  const mode = config.simulator
    ? "simulator" as const
    : available === 0
      ? "unconfigured" as const
      : available === targets.length
        ? "crabbox" as const
        : "partial" as const;
  return {
    provider: new RoutedChildCoreProvider(routed),
    runtime: { mode, defaultTarget: config.defaultTarget, targets },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readRequiredString(value: unknown, key: string): string {
  const raw = asRecord(value)[key];
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${key} is required`);
  return raw.trim();
}

function readRequiredInteger(value: unknown, key: string): number {
  const raw = asRecord(value)[key];
  if (!Number.isInteger(raw) || Number(raw) < 1) throw new Error(`${key} must be a positive integer`);
  return Number(raw);
}

function readStringArray(value: unknown, key: string): string[] {
  const raw = asRecord(value)[key];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return raw;
}

function readGenerationMap(value: unknown, clawIds: string[]): Record<string, number> {
  const raw = asRecord(value);
  const result: Record<string, number> = {};
  for (const id of clawIds) {
    const generation = raw[id];
    if (!Number.isInteger(generation) || Number(generation) < 0) {
      throw new Error(`expected generation is required for claw ${id}`);
    }
    result[id] = Number(generation);
  }
  return result;
}

async function reconcilePolicyTarget(
  reconciler: CrabhelmReconciler,
  clawId: string,
  canary: boolean,
): Promise<{ clawId: string; ok: boolean; canary: boolean; claw?: ClawRecord; error?: string }> {
  try {
    const claw = await reconciler.reconcileOne(clawId);
    const ok = claw.observed.generation === claw.desired.generation &&
      (claw.observed.phase === "ready" || claw.observed.phase === "disabled");
    return {
      clawId,
      ok,
      claw,
      ...(ok ? {} : { error: `policy did not converge: ${claw.observed.message}` }),
      canary,
    };
  } catch (error) {
    return { clawId, ok: false, error: error instanceof Error ? error.message : String(error), canary };
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await operation(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function safeCall<T>(call: () => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    return { ok: true, result: await call() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
