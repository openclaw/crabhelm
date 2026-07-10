import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { childPolicyHash } from "./domain.js";
import {
  operationalError,
  operationalErrorFromChildCode,
  type CrabhelmOperationalErrorCode,
} from "./errors.js";
import type { ChildOperationalProbes, ClawRecord, ParentControlLink } from "./types.js";

export const childStatusCommand = "crabhelm.child.status" as const;
export const childApplyCommand = "crabhelm.child.apply" as const;
export const childIngressCommand = "crabhelm.child.ingress" as const;
export const childPairingListCommand = "crabhelm.child.pairing.list" as const;
export const childPairingApproveCommand = "crabhelm.child.pairing.approve" as const;
export const childHealthCommand = "crabhelm.child.health" as const;
export const childDrainCommand = "crabhelm.child.drain.status" as const;
const protocolVersion = 2;
const healthProbeMaxAgeMs = 5 * 60 * 1000;
const execFileAsync = promisify(execFile);

export type NodesRuntime = {
  list(params?: { connected?: boolean }): Promise<{
    nodes: Array<{
      nodeId: string;
      displayName?: string;
      connected?: boolean;
      caps?: string[];
      commands?: string[];
    }>;
  }>;
  invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<unknown>;
};

type OpenClawCliRunner = (args: string[], timeout?: number) => Promise<string>;

type ConfigRuntime = {
  version: string;
  config: {
    current(): Record<string, unknown>;
    mutateConfigFile<T>(params: {
      afterWrite: { mode: "auto" };
      mutate(
        draft: Record<string, unknown>,
        context: { previousHash: string | null },
      ): Promise<T> | T;
    }): Promise<{ result?: T }>;
  };
};

type NodeRegistrationApi = {
  runtime: ConfigRuntime;
  registerNodeHostCommand(command: {
    command: string;
    cap?: string;
    dangerous?: boolean;
    handle(paramsJSON?: string | null): Promise<string>;
  }): void;
  registerNodeInvokePolicy(policy: {
    commands: string[];
    defaultPlatforms?: Array<"linux" | "macos" | "windows" | "ios" | "android" | "unknown">;
    dangerous?: boolean;
    handle(context: {
      nodeId: string;
      params: unknown;
      node?: { displayName?: string };
      invokeNode(): Promise<unknown>;
    }): Promise<unknown>;
  }): void;
};

export function registerChildCommands(api: NodeRegistrationApi, childId: string): void {
  api.registerNodeHostCommand({
    command: childStatusCommand,
    cap: "crabhelm-child-status",
    dangerous: false,
    async handle(paramsJSON) {
      requireChildId(parseRecord(paramsJSON), childId);
      return JSON.stringify(await childStatus(api.runtime, childId));
    },
  });
  api.registerNodeHostCommand({
    command: childHealthCommand,
    cap: "crabhelm-child-health",
    dangerous: false,
    async handle(paramsJSON) {
      const params = parseRecord(paramsJSON);
      requireChildId(params, childId);
      const model = requireString(params.model, "model", 220);
      const probes = await probeChildOperationalHealth(model, api.runtime.config.current());
      return JSON.stringify({ ok: true, childId, protocolVersion, probes });
    },
  });
  api.registerNodeHostCommand({
    command: childDrainCommand,
    cap: "crabhelm-child-drain-status",
    dangerous: false,
    async handle(paramsJSON) {
      requireChildId(parseRecord(paramsJSON), childId);
      const drain = await probeActiveChildRuns();
      return JSON.stringify({ ok: true, childId, protocolVersion, ...drain });
    },
  });
  api.registerNodeHostCommand({
    command: childApplyCommand,
    cap: "crabhelm-child-apply",
    dangerous: true,
    async handle(paramsJSON) {
      const params = parseRecord(paramsJSON);
      requireChildId(params, childId);
      const desired = parseManagedDesired(params.desired);
      if (desired.routerProjectId && desired.routerProjectId !== childId) {
        throw new Error("desired.routerProjectId must match the immutable child id");
      }
      const generation = requirePositiveInteger(params.generation, "generation");
      const desiredHash = requireString(params.desiredHash, "desiredHash", 128);
      const expectedManagedHash = requireString(
        params.expectedManagedHash,
        "expectedManagedHash",
        128,
      );
      if (desired.slackEnabled && !(await hasResolvableSlackCredentials(api.runtime.config.current()))) {
        return JSON.stringify(
          childCommandFailure(childId, "SLACK_CREDENTIALS_UNRESOLVED"),
        );
      }
      try {
        const write = await api.runtime.config.mutateConfigFile({
          afterWrite: { mode: "auto" },
          mutate(draft) {
            const current = readManagedState(draft);
            if (managedHash(current) !== expectedManagedHash) {
              throw new Error("managed child config changed since status read");
            }
            applyManagedDesired(draft, desired);
            const pluginConfig = ensurePluginConfig(draft);
            const nextManagedHash = managedHash(readManagedState(draft));
            pluginConfig.appliedGeneration = generation;
            pluginConfig.appliedDesiredHash = desiredHash;
            pluginConfig.appliedManagedHash = nextManagedHash;
            return {
              generation,
              desiredHash,
              managedHash: nextManagedHash,
            };
          },
        });
        return JSON.stringify({ ok: true, childId, protocolVersion, ...write.result });
      } catch (error) {
        if (error instanceof Error && error.message === "managed child config changed since status read") {
          return JSON.stringify(childCommandFailure(childId, "CHILD_POLICY_CAS_CONFLICT"));
        }
        throw error;
      }
    },
  });
  api.registerNodeHostCommand({
    command: childIngressCommand,
    cap: "crabhelm-child-ingress",
    dangerous: true,
    async handle(paramsJSON) {
      const params = parseRecord(paramsJSON);
      requireChildId(params, childId);
      if (typeof params.enabled !== "boolean") throw new Error("enabled is required");
      const write = await api.runtime.config.mutateConfigFile({
        afterWrite: { mode: "auto" },
        mutate(draft) {
          setChannelIngress(draft, params.enabled as boolean);
          return { ingressDisabled: !params.enabled };
        },
      });
      return JSON.stringify({ ok: true, childId, protocolVersion, ...write.result });
    },
  });
  api.registerNodeHostCommand({
    command: childPairingListCommand,
    cap: "crabhelm-child-pairing-list",
    dangerous: false,
    async handle(paramsJSON) {
      const params = parseRecord(paramsJSON);
      requireChildId(params, childId);
      const channel = requirePairingChannel(params.channel);
      const accountId = optionalAccountId(params.accountId);
      const requests = await listNativePairingRequests(channel, accountId);
      return JSON.stringify({ ok: true, childId, protocolVersion, channel, requests });
    },
  });
  api.registerNodeHostCommand({
    command: childPairingApproveCommand,
    cap: "crabhelm-child-pairing-approve",
    dangerous: true,
    async handle(paramsJSON) {
      const params = parseRecord(paramsJSON);
      requireChildId(params, childId);
      const channel = requirePairingChannel(params.channel);
      const accountId = optionalAccountId(params.accountId);
      const code = requireString(params.code, "pairing code", 12).toUpperCase();
      if (!/^[A-Z0-9]{6,12}$/.test(code)) throw new Error("pairing code is invalid");
      const pending = await listNativePairingRequests(channel, accountId);
      const request = pending.find((item) => item.code.toUpperCase() === code);
      if (!request) throw new Error("pending pairing request not found");
      await runOpenClawCli([
        "pairing",
        "approve",
        "--channel",
        channel,
        ...(accountId ? ["--account", accountId] : []),
        code,
      ]);
      return JSON.stringify({ ok: true, childId, protocolVersion, channel, approved: request });
    },
  });
}

export function registerParentNodePolicy(api: NodeRegistrationApi): void {
  api.registerNodeInvokePolicy({
    commands: [childStatusCommand],
    defaultPlatforms: ["linux", "macos", "windows"],
    dangerous: false,
    handle: boundNodePolicy,
  });
  api.registerNodeInvokePolicy({
    commands: [childPairingListCommand],
    defaultPlatforms: ["linux", "macos", "windows"],
    dangerous: false,
    handle: boundNodePolicy,
  });
  api.registerNodeInvokePolicy({
    commands: [childHealthCommand],
    defaultPlatforms: ["linux", "macos", "windows"],
    dangerous: false,
    handle: boundNodePolicy,
  });
  api.registerNodeInvokePolicy({
    commands: [childDrainCommand],
    defaultPlatforms: ["linux", "macos", "windows"],
    dangerous: false,
    handle: boundNodePolicy,
  });
  api.registerNodeInvokePolicy({
    commands: [childPairingApproveCommand],
    dangerous: true,
    handle: boundNodePolicy,
  });
  api.registerNodeInvokePolicy({
    commands: [childApplyCommand],
    dangerous: true,
    handle: boundNodePolicy,
  });
  api.registerNodeInvokePolicy({
    commands: [childIngressCommand],
    dangerous: true,
    handle: boundNodePolicy,
  });
}

async function boundNodePolicy(context: {
  nodeId: string;
  params: unknown;
  node?: { displayName?: string };
  invokeNode(): Promise<unknown>;
}): Promise<unknown> {
  const params = asRecord(context.params);
  const clawId = typeof params.clawId === "string" ? params.clawId.trim() : "";
  const expectedNodeId =
    typeof params.expectedNodeId === "string" ? params.expectedNodeId.trim() : "";
  if (!clawId) return { ok: false, code: "INVALID_CHILD_ID", message: "clawId is required" };
  if (!expectedNodeId || context.nodeId !== expectedNodeId) {
    return {
      ok: false,
      code: "CHILD_NODE_ID_MISMATCH",
      message: "paired node id does not match the enrolled child",
    };
  }
  if (context.node?.displayName !== childNodeDisplayName(clawId)) {
    return {
      ok: false,
      code: "CHILD_NODE_MISMATCH",
      message: "paired node display name does not match the requested child",
    };
  }
  return context.invokeNode();
}

export type ChildNodeEvidence = {
  status: "pending" | "paired";
  message: string;
  controlLink?: ParentControlLink;
  gatewayReady?: boolean;
  gatewayVersion?: string;
  configHash?: string;
  ingressDisabled?: boolean;
  probes?: ChildOperationalProbes;
};

export type ChildPairingRequest = {
  code: string;
  id: string;
  createdAt: string;
  lastSeenAt?: string;
  accountId?: string;
  label?: string;
};

export class OpenClawNodeControl {
  readonly #nodes: NodesRuntime;
  readonly #runCli: OpenClawCliRunner;

  constructor(nodes: NodesRuntime, options: { runOpenClawCli?: OpenClawCliRunner } = {}) {
    this.#nodes = nodes;
    this.#runCli = options.runOpenClawCli ?? runOpenClawCli;
  }

  async inspect(
    claw: ClawRecord,
    options: { reconcileDesired?: boolean } = {},
  ): Promise<ChildNodeEvidence> {
    const { nodes } = await this.#nodes.list({ connected: true });
    const displayName = childNodeDisplayName(claw.id);
    const expectedNodeId = claw.observed.controlLink.nodeId ?? childNodeId(claw.id);
    const node = nodes.find((candidate) => candidate.nodeId === expectedNodeId);
    if (!node) {
      if (nodes.some((candidate) => candidate.displayName === displayName)) {
        throw operationalError(
          "CHILD_IDENTITY_MISMATCH",
          "A paired node claims this child name with the wrong immutable node id",
        );
      }
      return { status: "pending", message: `Waiting for native node pairing: ${displayName}` };
    }
    if (node.displayName !== displayName) {
      throw operationalError(
        "CHILD_IDENTITY_MISMATCH",
        "Enrolled child node id has a mismatched display name",
      );
    }
    if (!node.commands?.includes(childStatusCommand)) {
      return {
        status: "pending",
        message: "Child node is connected but does not advertise the Crabhelm status command",
      };
    }
    let status = await this.#status(node.nodeId, claw);
    if (options.reconcileDesired !== false && status.ingressDisabled) {
      if (!node.commands.includes(childIngressCommand)) {
        return { ...this.#evidence(
          node.nodeId,
          status,
          "Child node paired but ingress remains disabled; enable command is not advertised",
        ), status: "pending" };
      }
      await this.#setIngress(node.nodeId, claw, true);
      status = await this.#status(node.nodeId, claw);
      if (status.ingressDisabled) throw new Error("Child node did not re-enable channel ingress");
    }
    const desiredHash = childPolicyHash(claw);
    if (claw.desired.observability.otel.enabled && status.protocolVersion < 2) {
      return {
        ...this.#evidence(
          node.nodeId,
          status,
          "Child node paired; policy-aware Crabhelm plugin upgrade is required for OpenTelemetry",
        ),
        status: "pending",
      };
    }
    let appliedNow = false;
    if (options.reconcileDesired !== false && status.appliedDesiredHash !== desiredHash) {
      if (!node.commands.includes(childApplyCommand)) {
        return { ...this.#evidence(
          node.nodeId,
          status,
          "Child node paired; desired-state command is not advertised",
        ), status: "pending" };
      }
      const applyResponse = await this.#nodes.invoke({
        nodeId: node.nodeId,
        command: childApplyCommand,
        params: {
          clawId: claw.id,
          expectedNodeId: node.nodeId,
          generation: claw.desired.generation,
          desiredHash,
          expectedManagedHash: status.managedHash,
          desired: {
            model: claw.desired.inference.model,
            fallbackModels: claw.desired.inference.fallbackModels,
            ...(claw.desired.inference.router.kind === "clawrouter"
              ? {
                  routerBaseUrl: claw.desired.inference.router.baseUrl,
                  routerProjectId: claw.desired.inference.router.projectId,
                }
              : {}),
            slackEnabled: claw.desired.channels.slack.enabled,
            dmPolicy: claw.desired.access.dmPolicy,
            groupPolicy: claw.desired.access.groupPolicy,
            logLevel: claw.desired.observability.logLevel,
            otel: claw.desired.observability.otel,
          },
        },
        timeoutMs: 15_000,
        idempotencyKey: `crabhelm-child-apply-${claw.id}-${claw.desired.generation}`,
      });
      throwIfChildCommandFailed(applyResponse);
      status = await this.#status(node.nodeId, claw);
      if (status.appliedDesiredHash !== desiredHash) {
        throw new Error("Child node did not report the applied desired generation");
      }
      appliedNow = true;
    }
    let probes = claw.observed.probes;
    if (options.reconcileDesired !== false) {
      if (!node.commands.includes(childHealthCommand)) {
        return {
          ...this.#evidence(
            node.nodeId,
            status,
            "Child node paired and policy applied; operational health command is not advertised",
          ),
          status: "pending",
        };
      }
      const checkedAt = probes ? Date.parse(probes.checkedAt) : Number.NaN;
      const stale = !Number.isFinite(checkedAt) || Date.now() - checkedAt > healthProbeMaxAgeMs;
      if (stale || appliedNow) {
        probes = await this.#health(node.nodeId, claw);
      }
    }
    return this.#evidence(
      node.nodeId,
      status,
      status.gatewayReady && probes?.model.authReady &&
          (!claw.desired.channels.slack.enabled || probes.slack.status === "healthy")
        ? "Native child node paired; child Gateway ready and desired state applied"
        : "Native child node paired; waiting for operational health",
      probes,
    );
  }

  async disable(claw: ClawRecord): Promise<ChildNodeEvidence> {
    const { nodes } = await this.#nodes.list({ connected: true });
    const displayName = childNodeDisplayName(claw.id);
    const expectedNodeId = claw.observed.controlLink.nodeId ?? childNodeId(claw.id);
    const node = nodes.find((candidate) => candidate.nodeId === expectedNodeId);
    if (!node) {
      throw operationalError(
        "CHILD_IDENTITY_MISMATCH",
        "Cannot disable ingress because the enrolled child node is not connected",
      );
    }
    if (node.displayName !== displayName) {
      throw operationalError(
        "CHILD_IDENTITY_MISMATCH",
        "Cannot disable ingress because the child node identity does not match",
      );
    }
    if (!node.commands?.includes(childIngressCommand)) {
      throw operationalError(
        "CHILD_COMMAND_MISSING",
        "Child does not advertise the required ingress command",
      );
    }
    await this.#setIngress(node.nodeId, claw, false);
    const status = await this.#status(node.nodeId, claw);
    if (!status.ingressDisabled) throw new Error("Child node did not confirm disabled ingress");
    return this.#evidence(node.nodeId, status, "Child channel ingress disabled and verified");
  }

  async drain(claw: ClawRecord): Promise<{
    drained: boolean;
    activeRuns: number;
    checkedAt: string;
    message: string;
  }> {
    const node = await this.#requireConnectedNode(claw, childDrainCommand);
    const response = await this.#nodes.invoke({
      nodeId: node.nodeId,
      command: childDrainCommand,
      params: { clawId: claw.id, expectedNodeId: node.nodeId },
      timeoutMs: 30_000,
      idempotencyKey: `crabhelm-drain-${claw.id}-${Date.now()}`,
    });
    const payload = readPayload(response);
    throwIfChildCommandFailed(response);
    const activeRuns = payload.activeRuns;
    if (
      payload.ok !== true ||
      payload.childId !== claw.id ||
      !isSupportedChildProtocol(payload.protocolVersion) ||
      !Number.isInteger(activeRuns) ||
      Number(activeRuns) < 0 ||
      typeof payload.drained !== "boolean"
    ) {
      throw operationalError("CHILD_DRAIN_INVALID", "Child drain evidence is invalid");
    }
    const checkedAt = requireString(payload.checkedAt, "drain checkedAt", 64);
    if (!Number.isFinite(Date.parse(checkedAt))) {
      throw operationalError("CHILD_DRAIN_INVALID", "Child drain timestamp is invalid");
    }
    if (payload.drained !== (Number(activeRuns) === 0)) {
      throw operationalError("CHILD_DRAIN_INVALID", "Child drain evidence is inconsistent");
    }
    return {
      drained: payload.drained,
      activeRuns: Number(activeRuns),
      checkedAt,
      message: payload.drained
        ? "Child has no active agent runs"
        : `Waiting for ${Number(activeRuns)} active child agent run${Number(activeRuns) === 1 ? "" : "s"}`,
    };
  }

  async revokePairing(claw: ClawRecord): Promise<{
    removedPairedDevice: boolean;
    rejectedPendingRequest: boolean;
    alreadyAbsent: boolean;
    message: string;
  }> {
    const expectedNodeId = claw.observed.controlLink.nodeId ?? childNodeId(claw.id);
    const expectedDisplayName = childNodeDisplayName(claw.id);
    const before = parseNativeDevicePairingList(
      JSON.parse(await this.#runCli(["devices", "list", "--json"], 15_000)),
    );
    const paired = before.paired.filter((entry) => entry.deviceId === expectedNodeId);
    const pending = before.pending.filter((entry) => entry.deviceId === expectedNodeId);
    for (const entry of [...paired, ...pending]) {
      requireNativeChildDevice(entry, expectedNodeId, expectedDisplayName);
    }
    let rejectedPendingRequest = false;
    for (const entry of pending) {
      if (!entry.requestId) throw new Error("native child pending pairing request has no request id");
      await this.#runCli(["devices", "reject", entry.requestId, "--json"], 15_000);
      rejectedPendingRequest = true;
    }
    let removedPairedDevice = false;
    if (paired.length) {
      await this.#runCli(["devices", "remove", expectedNodeId, "--json"], 15_000);
      removedPairedDevice = true;
    }
    const after = parseNativeDevicePairingList(
      JSON.parse(await this.#runCli(["devices", "list", "--json"], 15_000)),
    );
    if (
      after.paired.some((entry) => entry.deviceId === expectedNodeId) ||
      after.pending.some((entry) => entry.deviceId === expectedNodeId)
    ) {
      throw new Error("native child pairing cleanup was not confirmed");
    }
    const alreadyAbsent = !removedPairedDevice && !rejectedPendingRequest;
    return {
      removedPairedDevice,
      rejectedPendingRequest,
      alreadyAbsent,
      message: alreadyAbsent
        ? "Native parent pairing already absent"
        : "Native parent pairing removed and confirmed absent",
    };
  }

  async listPairing(
    claw: ClawRecord,
    options: { channel?: "slack"; accountId?: string } = {},
  ): Promise<{ channel: "slack"; requests: ChildPairingRequest[] }> {
    const node = await this.#requireConnectedNode(claw, childPairingListCommand);
    const channel = options.channel ?? "slack";
    const response = await this.#nodes.invoke({
      nodeId: node.nodeId,
      command: childPairingListCommand,
      params: {
        clawId: claw.id,
        expectedNodeId: node.nodeId,
        channel,
        ...(options.accountId ? { accountId: options.accountId } : {}),
      },
      timeoutMs: 10_000,
      idempotencyKey: `crabhelm-pairing-list-${claw.id}-${Date.now()}`,
    });
    const payload = readPayload(response);
    return {
      channel,
      requests: parsePairingRequests(payload, claw.id, channel),
    };
  }

  async approvePairing(
    claw: ClawRecord,
    options: { code: string; channel?: "slack"; accountId?: string },
  ): Promise<{ channel: "slack"; approved: ChildPairingRequest }> {
    const node = await this.#requireConnectedNode(claw, childPairingApproveCommand);
    const channel = options.channel ?? "slack";
    const response = await this.#nodes.invoke({
      nodeId: node.nodeId,
      command: childPairingApproveCommand,
      params: {
        clawId: claw.id,
        expectedNodeId: node.nodeId,
        channel,
        code: options.code,
        ...(options.accountId ? { accountId: options.accountId } : {}),
      },
      timeoutMs: 15_000,
      idempotencyKey: `crabhelm-pairing-approve-${claw.id}-${options.code.toUpperCase()}`,
    });
    const payload = readPayload(response);
    const requests = parsePairingRequests(
      { ...payload, requests: payload.approved ? [payload.approved] : [] },
      claw.id,
      channel,
    );
    const approved = requests[0];
    if (!approved) throw new Error("Child returned invalid pairing approval evidence");
    return { channel, approved };
  }

  async #requireConnectedNode(claw: ClawRecord, command: string) {
    const { nodes } = await this.#nodes.list({ connected: true });
    const nodeId = claw.observed.controlLink.nodeId ?? childNodeId(claw.id);
    const node = nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node || node.displayName !== childNodeDisplayName(claw.id)) {
      throw operationalError(
        "CHILD_IDENTITY_MISMATCH",
        "Enrolled child node is not connected with its immutable identity",
      );
    }
    if (!node.commands?.includes(command)) {
      throw operationalError("CHILD_COMMAND_MISSING", "Child does not advertise a required command");
    }
    return node;
  }

  async #setIngress(nodeId: string, claw: ClawRecord, enabled: boolean): Promise<void> {
    await this.#nodes.invoke({
      nodeId,
      command: childIngressCommand,
      params: { clawId: claw.id, expectedNodeId: nodeId, enabled },
      timeoutMs: 15_000,
      idempotencyKey: `crabhelm-child-ingress-${claw.id}-${claw.desired.generation}-${enabled}`,
    });
  }

  async #status(nodeId: string, claw: ClawRecord): Promise<ChildStatusPayload> {
    const response = await this.#nodes.invoke({
      nodeId,
      command: childStatusCommand,
      params: { clawId: claw.id, expectedNodeId: nodeId },
      timeoutMs: 10_000,
      idempotencyKey: `crabhelm-child-status-${claw.id}-${claw.desired.generation}`,
    });
    const payload = readPayload(response);
    throwIfChildCommandFailed(response);
    if (
      payload.ok !== true ||
      payload.childId !== claw.id ||
      payload.pluginMode !== "child" ||
      !isSupportedChildProtocol(payload.protocolVersion) ||
      typeof payload.managedHash !== "string"
    ) {
      throw operationalError("CHILD_STATUS_INVALID", "Child returned invalid status evidence");
    }
    return {
      protocolVersion: payload.protocolVersion,
      gatewayReady: payload.gatewayReady === true,
      gatewayVersion: typeof payload.gatewayVersion === "string" ? payload.gatewayVersion : undefined,
      managedHash: payload.managedHash,
      appliedDesiredHash:
        typeof payload.appliedDesiredHash === "string" ? payload.appliedDesiredHash : undefined,
      ingressDisabled: payload.ingressDisabled === true,
    };
  }

  async #health(nodeId: string, claw: ClawRecord): Promise<ChildOperationalProbes> {
    const response = await this.#nodes.invoke({
      nodeId,
      command: childHealthCommand,
      params: {
        clawId: claw.id,
        expectedNodeId: nodeId,
        model: claw.desired.inference.model,
      },
      timeoutMs: 45_000,
      idempotencyKey: `crabhelm-child-health-${claw.id}-${Math.floor(Date.now() / healthProbeMaxAgeMs)}`,
    });
    const payload = readPayload(response);
    throwIfChildCommandFailed(response);
    if (
      payload.ok !== true ||
      payload.childId !== claw.id ||
      !isSupportedChildProtocol(payload.protocolVersion)
    ) {
      throw operationalError(
        "CHILD_HEALTH_INVALID",
        "Child returned invalid operational health identity evidence",
      );
    }
    try {
      return parseOperationalProbes(payload.probes, claw.desired.inference.model);
    } catch (error) {
      throw operationalError(
        "CHILD_HEALTH_INVALID",
        "Child returned invalid operational health evidence",
        error,
      );
    }
  }

  #evidence(
    nodeId: string,
    status: ChildStatusPayload,
    message: string,
    probes?: ChildOperationalProbes,
  ): ChildNodeEvidence {
    return {
      status: "paired",
      message,
      gatewayReady: status.gatewayReady,
      gatewayVersion: status.gatewayVersion,
      configHash: status.appliedDesiredHash,
      ingressDisabled: status.ingressDisabled,
      ...(probes ? { probes } : {}),
      controlLink: {
        status: "paired",
        transport: "openclaw-node",
        command: childStatusCommand,
        nodeId,
        lastSeenAt: new Date().toISOString(),
      },
    };
  }
}

type ChildStatusPayload = {
  protocolVersion: 1 | 2;
  gatewayReady: boolean;
  gatewayVersion?: string;
  managedHash: string;
  appliedDesiredHash?: string;
  ingressDisabled: boolean;
};

type ManagedDesired = {
  model: string;
  fallbackModels: string[];
  routerBaseUrl?: string;
  routerProjectId?: string;
  legacyOpenAiBaseUrl?: string;
  slackEnabled: boolean;
  dmPolicy: "pairing" | "allowlist" | "disabled";
  groupPolicy: "allowlist" | "disabled";
  logLevel: "error" | "warn" | "info" | "debug";
  otel: {
    enabled: boolean;
    endpoint?: string;
    serviceName: string;
    traces: boolean;
    metrics: boolean;
    logs: boolean;
    sampleRate: number;
    flushIntervalMs: number;
  };
};

async function childStatus(runtime: ConfigRuntime, childId: string): Promise<Record<string, unknown>> {
  const config = runtime.config.current();
  const pluginConfig = readPluginConfig(config);
  const currentManagedHash = managedHash(readManagedState(config));
  const managedStateConverged = pluginConfig.appliedManagedHash === currentManagedHash;
  return {
    ok: true,
    childId,
    pluginMode: "child",
    protocolVersion,
    gatewayReady: await probeLocalGateway(config),
    gatewayVersion: runtime.version,
    managedHash: currentManagedHash,
    ingressDisabled: pluginConfig.ingressDisabled === true,
    ...(typeof pluginConfig.appliedGeneration === "number"
      ? { appliedGeneration: pluginConfig.appliedGeneration }
      : {}),
    ...(managedStateConverged && typeof pluginConfig.appliedDesiredHash === "string"
      ? { appliedDesiredHash: pluginConfig.appliedDesiredHash }
      : {}),
  };
}

async function probeLocalGateway(config: Record<string, unknown>): Promise<boolean> {
  const gateway = asRecord(config.gateway);
  const port = typeof gateway.port === "number" && Number.isInteger(gateway.port) ? gateway.port : 18_789;
  try {
    const [health, readiness] = await Promise.all(
      ["healthz", "readyz"].map((endpoint) => fetch(`http://127.0.0.1:${port}/${endpoint}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      })),
    );
    return health.ok && readiness.ok;
  } catch {
    return false;
  }
}

function parseManagedDesired(value: unknown): ManagedDesired {
  const input = asRecord(value);
  const model = requireString(input.model, "desired.model", 220);
  if (!/^[a-z0-9][a-z0-9_.-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_.:\-]{0,199})+$/.test(model)) {
    throw new Error("desired.model must use provider/model form");
  }
  const fallbackModels = Array.isArray(input.fallbackModels)
    ? input.fallbackModels.map((item) => requireString(item, "fallback model", 220))
    : [];
  const dmPolicy = input.dmPolicy;
  const groupPolicy = input.groupPolicy;
  const logLevel = input.logLevel;
  if (!(dmPolicy === "pairing" || dmPolicy === "allowlist" || dmPolicy === "disabled")) {
    throw new Error("desired.dmPolicy is invalid");
  }
  if (!(groupPolicy === "allowlist" || groupPolicy === "disabled")) {
    throw new Error("desired.groupPolicy is invalid");
  }
  if (typeof input.slackEnabled !== "boolean") throw new Error("desired.slackEnabled is required");
  if (!(logLevel === "error" || logLevel === "warn" || logLevel === "info" || logLevel === "debug")) {
    throw new Error("desired.logLevel is invalid");
  }
  const routerBaseUrl = typeof input.routerBaseUrl === "string" ? input.routerBaseUrl.trim() : undefined;
  if (routerBaseUrl) {
    const url = new URL(routerBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("desired.routerBaseUrl must be an exact HTTPS origin");
    }
  }
  if (model.startsWith("clawrouter/") !== Boolean(routerBaseUrl)) {
    throw new Error("desired.model and desired.routerBaseUrl must select ClawRouter together");
  }
  const routerProjectId = typeof input.routerProjectId === "string"
    ? input.routerProjectId.trim().toLowerCase()
    : undefined;
  if (Boolean(routerProjectId) !== Boolean(routerBaseUrl)) {
    throw new Error("desired.routerProjectId and desired.routerBaseUrl must select ClawRouter together");
  }
  if (routerProjectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(routerProjectId)) {
    throw new Error("desired.routerProjectId must be a UUID");
  }
  return {
    model,
    fallbackModels,
    ...(routerBaseUrl ? { routerBaseUrl } : {}),
    ...(routerProjectId ? { routerProjectId } : {}),
    slackEnabled: input.slackEnabled,
    dmPolicy,
    groupPolicy,
    logLevel,
    otel: parseManagedOtel(input.otel),
  };
}

function parseManagedOtel(value: unknown): ManagedDesired["otel"] {
  if (value === undefined) {
    return {
      enabled: false,
      serviceName: "openclaw",
      traces: true,
      metrics: true,
      logs: false,
      sampleRate: 0.1,
      flushIntervalMs: 60_000,
    };
  }
  const input = asRecord(value);
  for (const field of ["enabled", "traces", "metrics"] as const) {
    if (typeof input[field] !== "boolean") throw new Error(`desired.otel.${field} is required`);
  }
  const enabled = input.enabled as boolean;
  const traces = input.traces as boolean;
  const metrics = input.metrics as boolean;
  if (enabled && !traces && !metrics) throw new Error("desired.otel requires at least one signal");
  if (input.logs !== false) throw new Error("desired.otel.logs must be false");
  const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : undefined;
  if (enabled && !endpoint) throw new Error("desired.otel.endpoint is required");
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("desired.otel.endpoint is invalid");
    }
  }
  const serviceName = requireString(input.serviceName, "desired.otel.serviceName", 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(serviceName)) {
    throw new Error("desired.otel.serviceName is invalid");
  }
  if (typeof input.sampleRate !== "number" || !Number.isFinite(input.sampleRate) || input.sampleRate < 0 || input.sampleRate > 1) {
    throw new Error("desired.otel.sampleRate is invalid");
  }
  if (!Number.isInteger(input.flushIntervalMs) || (input.flushIntervalMs as number) < 1_000 || (input.flushIntervalMs as number) > 300_000) {
    throw new Error("desired.otel.flushIntervalMs is invalid");
  }
  return {
    enabled,
    ...(endpoint ? { endpoint } : {}),
    serviceName,
    traces,
    metrics,
    logs: false,
    sampleRate: input.sampleRate,
    flushIntervalMs: input.flushIntervalMs as number,
  };
}

function readManagedState(config: Record<string, unknown>): ManagedDesired {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents.defaults);
  const modelConfig = defaults.model;
  const model =
    typeof modelConfig === "string"
      ? modelConfig
      : typeof asRecord(modelConfig).primary === "string"
        ? String(asRecord(modelConfig).primary)
        : "";
  const fallbacks = asRecord(modelConfig).fallbacks;
  const channels = asRecord(config.channels);
  const hasSlack = channels.slack !== undefined;
  const slack = asRecord(channels.slack);
  const logging = asRecord(config.logging);
  const diagnostics = asRecord(config.diagnostics);
  const diagnosticsOtel = asRecord(diagnostics.otel);
  const plugins = asRecord(config.plugins);
  const providers = asRecord(asRecord(config.models).providers);
  const openAiBaseUrl = asRecord(providers.openai).baseUrl;
  const clawRouterEntry = asRecord(asRecord(plugins.entries).clawrouter);
  const clawRouterProvider = asRecord(providers.clawrouter);
  const clawRouterApiKey = asRecord(clawRouterProvider.apiKey);
  const clawRouterHeaders = asRecord(clawRouterProvider.headers);
  const headerKeys = Object.keys(clawRouterHeaders);
  const hasDynamicAttribution = headerKeys.some((name) => dynamicClawRouterHeaders.has(name.toLowerCase()));
  const projectHeaderKeys = headerKeys.filter((name) => name.toLowerCase() === clawRouterProjectHeader.toLowerCase());
  const clawRouterAllowed = Array.isArray(plugins.allow) && plugins.allow.includes("clawrouter");
  const diagnosticsEntry = asRecord(asRecord(plugins.entries)["diagnostics-otel"]);
  const diagnosticsAllowed = Array.isArray(plugins.allow) && plugins.allow.includes("diagnostics-otel");
  return {
    model,
    fallbackModels: Array.isArray(fallbacks)
      ? fallbacks.filter((item): item is string => typeof item === "string")
      : [],
    ...(clawRouterAllowed &&
      clawRouterEntry.enabled === true &&
      typeof clawRouterProvider.baseUrl === "string" &&
      clawRouterApiKey.source === "env" &&
      clawRouterApiKey.provider === "default" &&
      clawRouterApiKey.id === "CLAWROUTER_API_KEY" &&
      !hasDynamicAttribution &&
      projectHeaderKeys.length === 1 &&
      projectHeaderKeys[0] === clawRouterProjectHeader &&
      typeof clawRouterHeaders[clawRouterProjectHeader] === "string"
      ? {
          routerBaseUrl: String(clawRouterProvider.baseUrl),
          routerProjectId: String(clawRouterHeaders[clawRouterProjectHeader]),
        }
      : {}),
    ...(typeof openAiBaseUrl === "string" ? { legacyOpenAiBaseUrl: openAiBaseUrl } : {}),
    slackEnabled: hasSlack && slack.enabled !== false,
    dmPolicy:
      slack.dmPolicy === "allowlist" || slack.dmPolicy === "disabled"
        ? slack.dmPolicy
        : "pairing",
    groupPolicy: slack.groupPolicy === "disabled" ? "disabled" : "allowlist",
    logLevel:
      logging.level === "error" || logging.level === "warn" || logging.level === "debug"
        ? logging.level
        : "info",
    otel: {
      enabled:
        diagnosticsAllowed &&
        diagnosticsEntry.enabled === true &&
        diagnostics.enabled === true &&
        diagnosticsOtel.enabled === true &&
        typeof diagnosticsOtel.endpoint === "string" &&
        diagnosticsOtel.tracesEndpoint === appendOtelSignalPath(diagnosticsOtel.endpoint, "traces") &&
        diagnosticsOtel.metricsEndpoint === appendOtelSignalPath(diagnosticsOtel.endpoint, "metrics"),
      ...(typeof diagnosticsOtel.endpoint === "string" ? { endpoint: diagnosticsOtel.endpoint } : {}),
      serviceName: typeof diagnosticsOtel.serviceName === "string" ? diagnosticsOtel.serviceName : "",
      traces: diagnosticsOtel.traces === true,
      metrics: diagnosticsOtel.metrics === true,
      logs: diagnosticsOtel.logs === true,
      sampleRate: typeof diagnosticsOtel.sampleRate === "number" ? diagnosticsOtel.sampleRate : -1,
      flushIntervalMs: typeof diagnosticsOtel.flushIntervalMs === "number" ? diagnosticsOtel.flushIntervalMs : -1,
    },
  };
}

function applyManagedDesired(config: Record<string, unknown>, desired: ManagedDesired): void {
  const agents = ensureRecord(config, "agents");
  const defaults = ensureRecord(agents, "defaults");
  defaults.model = { primary: desired.model, fallbacks: desired.fallbackModels };
  const channels = ensureRecord(config, "channels");
  const slack = ensureRecord(channels, "slack");
  slack.enabled = desired.slackEnabled;
  slack.dmPolicy = desired.dmPolicy;
  slack.groupPolicy = desired.groupPolicy;
  ensureRecord(config, "logging").level = desired.logLevel;
  const plugins = ensureRecord(config, "plugins");
  const existingAllow = Array.isArray(plugins.allow)
    ? plugins.allow.filter((id): id is string => typeof id === "string")
    : [];
  const managedAllow = new Set(["crabhelm", "slack", "clawrouter", "diagnostics-otel"]);
  plugins.allow = [
    ...existingAllow.filter(
      (id, index) => !managedAllow.has(id) && existingAllow.indexOf(id) === index,
    ),
    "crabhelm",
    "slack",
    ...(desired.routerBaseUrl ? ["clawrouter"] : []),
    ...(desired.otel.enabled ? ["diagnostics-otel"] : []),
  ];
  const clawRouterEntry = ensureRecord(ensureRecord(plugins, "entries"), "clawrouter");
  clawRouterEntry.enabled = Boolean(desired.routerBaseUrl);
  const modelProviders = ensureRecord(ensureRecord(config, "models"), "providers");
  if (desired.routerBaseUrl) {
    const clawRouterProvider = ensureRecord(modelProviders, "clawrouter");
    clawRouterProvider.baseUrl = desired.routerBaseUrl;
    clawRouterProvider.apiKey = {
      source: "env",
      provider: "default",
      id: "CLAWROUTER_API_KEY",
    };
    const headers = ensureRecord(clawRouterProvider, "headers");
    for (const name of Object.keys(headers)) {
      const normalized = name.toLowerCase();
      if (normalized === clawRouterProjectHeader.toLowerCase() || dynamicClawRouterHeaders.has(normalized)) {
        delete headers[name];
      }
    }
    headers[clawRouterProjectHeader] = desired.routerProjectId;
  } else {
    delete modelProviders.clawrouter;
  }
  const openAiProvider = asRecord(modelProviders.openai);
  delete openAiProvider.baseUrl;
  if (modelProviders.openai !== undefined && Object.keys(openAiProvider).length === 0) {
    delete modelProviders.openai;
  }
  const diagnosticsEntry = ensureRecord(ensureRecord(plugins, "entries"), "diagnostics-otel");
  diagnosticsEntry.enabled = desired.otel.enabled;
  const diagnostics = ensureRecord(config, "diagnostics");
  diagnostics.enabled = desired.otel.enabled;
  diagnostics.otel = {
    enabled: desired.otel.enabled,
    ...(desired.otel.endpoint ? { endpoint: desired.otel.endpoint } : {}),
    ...(desired.otel.endpoint ? {
      tracesEndpoint: appendOtelSignalPath(desired.otel.endpoint, "traces"),
      metricsEndpoint: appendOtelSignalPath(desired.otel.endpoint, "metrics"),
    } : {}),
    protocol: "http/protobuf",
    serviceName: desired.otel.serviceName,
    traces: desired.otel.traces,
    metrics: desired.otel.metrics,
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
    sampleRate: desired.otel.sampleRate,
    flushIntervalMs: desired.otel.flushIntervalMs,
  };
}

const clawRouterProjectHeader = "X-ClawRouter-Project-Id";
const dynamicClawRouterHeaders = new Set([
  "x-clawrouter-agent-id",
  "x-clawrouter-parent-agent-id",
  "x-clawrouter-session-id",
  "x-clawrouter-request-id",
  "x-request-id",
]);

function managedHash(value: ManagedDesired): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function appendOtelSignalPath(endpoint: string, signal: "traces" | "metrics"): string {
  return `${endpoint.replace(/\/+$/u, "")}/v1/${signal}`;
}

function readPluginConfig(config: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(asRecord(config.plugins).entries).crabhelm).config
    ? asRecord(asRecord(asRecord(asRecord(config.plugins).entries).crabhelm).config)
    : {};
}

function ensurePluginConfig(config: Record<string, unknown>): Record<string, unknown> {
  const plugins = ensureRecord(config, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const crabhelm = ensureRecord(entries, "crabhelm");
  return ensureRecord(crabhelm, "config");
}

function setChannelIngress(config: Record<string, unknown>, enabled: boolean): void {
  const channels = ensureRecord(config, "channels");
  const pluginConfig = ensurePluginConfig(config);
  if (!enabled) {
    if (pluginConfig.ingressDisabled === true) return;
    const states: Record<string, boolean | "missing"> = {};
    for (const [name, value] of Object.entries(channels)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const channel = value as Record<string, unknown>;
      states[name] = typeof channel.enabled === "boolean" ? channel.enabled : "missing";
      channel.enabled = false;
    }
    pluginConfig.disabledChannelStates = states;
    pluginConfig.ingressDisabled = true;
    return;
  }
  if (pluginConfig.ingressDisabled !== true) return;
  const states = asRecord(pluginConfig.disabledChannelStates);
  for (const [name, previous] of Object.entries(states)) {
    const channel = asRecord(channels[name]);
    if (previous === "missing") delete channel.enabled;
    else if (typeof previous === "boolean") channel.enabled = previous;
  }
  delete pluginConfig.disabledChannelStates;
  pluginConfig.ingressDisabled = false;
}

async function hasResolvableSlackCredentials(config: Record<string, unknown>): Promise<boolean> {
  const slack = asRecord(asRecord(config.channels).slack);
  const accounts = [slack, ...Object.values(asRecord(slack.accounts)).map(asRecord)];
  for (const [index, account] of accounts.entries()) {
    if (!(await hasResolvableSecretInput(config, account.botToken, `channels.slack.accounts.${index}.botToken`))) {
      continue;
    }
    const mode = typeof account.mode === "string" ? account.mode : "socket";
    if (mode === "http") {
      if (await hasResolvableSecretInput(config, account.signingSecret, `channels.slack.accounts.${index}.signingSecret`)) return true;
      continue;
    }
    if (mode === "relay") {
      const relay = asRecord(account.relay);
      if (
        typeof relay.url === "string" &&
        Boolean(relay.url.trim()) &&
        await hasResolvableSecretInput(config, relay.authToken, `channels.slack.accounts.${index}.relay.authToken`) &&
        typeof relay.gatewayId === "string" &&
        Boolean(relay.gatewayId.trim())
      ) return true;
      continue;
    }
    if (await hasResolvableSecretInput(config, account.appToken, `channels.slack.accounts.${index}.appToken`)) return true;
  }
  return false;
}

async function hasResolvableSecretInput(
  config: Record<string, unknown>,
  value: unknown,
  pathLabel: string,
): Promise<boolean> {
  try {
    const { resolveConfiguredSecretInputString } = await import(
      "openclaw/plugin-sdk/secret-input-runtime"
    );
    const resolved = await resolveConfiguredSecretInputString({
      config,
      env: process.env,
      value,
      path: pathLabel,
      unresolvedReasonStyle: "generic",
    });
    return typeof resolved.value === "string" && Boolean(resolved.value.trim());
  } catch (error) {
    const code = asRecord(error).code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw error;
    if (typeof value === "string") return Boolean(value.trim());
    const ref = asRecord(value);
    return ref.source === "env" && typeof ref.id === "string" &&
      /^[A-Z][A-Z0-9_]{0,127}$/.test(ref.id) && Boolean(process.env[ref.id]?.trim());
  }
}

async function listNativePairingRequests(
  channel: "slack",
  accountId?: string,
): Promise<ChildPairingRequest[]> {
  const output = await runOpenClawCli([
    "pairing",
    "list",
    "--channel",
    channel,
    ...(accountId ? ["--account", accountId] : []),
    "--json",
  ]);
  const payload: unknown = JSON.parse(output);
  const requests = asRecord(payload).requests;
  if (!Array.isArray(requests)) throw new Error("pairing list returned invalid JSON");
  return requests.slice(0, 20).map((request) => sanitizePairingRequest(request));
}

async function runOpenClawCli(args: string[], timeout = 15_000): Promise<string> {
  const entry = process.argv[1];
  if (!entry || !path.isAbsolute(entry)) throw new Error("OpenClaw CLI entry is unavailable");
  const result = await execFileAsync(process.execPath, [entry, ...args], {
    timeout,
    maxBuffer: 512 * 1024,
    env: process.env,
  });
  return result.stdout.trim();
}

async function probeActiveChildRuns(): Promise<{
  drained: boolean;
  activeRuns: number;
  checkedAt: string;
}> {
  const pageSize = 200;
  const maxPages = 50;
  let offset = 0;
  let activeRuns = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const output = await runOpenClawCli([
      "gateway",
      "call",
      "sessions.list",
      "--params",
      JSON.stringify({
        limit: pageSize,
        offset,
        configuredAgentsOnly: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
      }),
      "--json",
    ], 25_000);
    const payload = asRecord(JSON.parse(output));
    const sessions = payload.sessions;
    if (!Array.isArray(sessions)) throw new Error("sessions.list returned invalid JSON");
    for (const session of sessions) {
      const row = asRecord(session);
      if (typeof row.hasActiveRun !== "boolean") {
        throw new Error("sessions.list omitted active-run evidence");
      }
      if (row.hasActiveRun) activeRuns += 1;
    }
    offset += sessions.length;
    const total = payload.total;
    if (Number.isInteger(total) && Number(total) >= 0) {
      if (offset >= Number(total)) break;
      if (!sessions.length) throw new Error("sessions.list pagination did not advance");
    } else if (sessions.length < pageSize) {
      break;
    }
    if (page === maxPages - 1) throw new Error("session drain scan exceeded 10000 sessions");
  }
  return { drained: activeRuns === 0, activeRuns, checkedAt: new Date().toISOString() };
}

type NativeDevicePairingEntry = {
  deviceId: string;
  requestId?: string;
  displayName?: string;
  roles: string[];
};

function parseNativeDevicePairingList(value: unknown): {
  paired: NativeDevicePairingEntry[];
  pending: NativeDevicePairingEntry[];
} {
  const payload = asRecord(value);
  const parse = (raw: unknown, pending: boolean): NativeDevicePairingEntry[] => {
    if (!Array.isArray(raw)) throw new Error("native device pairing list is invalid");
    return raw.map((item) => {
      const entry = asRecord(item);
      return {
        deviceId: requireString(entry.deviceId, "native device id", 200),
        ...(pending ? { requestId: requireString(entry.requestId, "native request id", 200) } : {}),
        ...(typeof entry.displayName === "string" && entry.displayName.trim()
          ? { displayName: entry.displayName.trim().slice(0, 200) }
          : {}),
        roles: Array.isArray(entry.roles)
          ? entry.roles.filter((role): role is string => typeof role === "string")
          : typeof entry.role === "string"
            ? [entry.role]
            : [],
      };
    });
  };
  return { paired: parse(payload.paired, false), pending: parse(payload.pending, true) };
}

function requireNativeChildDevice(
  entry: NativeDevicePairingEntry,
  expectedNodeId: string,
  expectedDisplayName: string,
): void {
  if (
    entry.deviceId !== expectedNodeId ||
    entry.roles.length !== 1 ||
    entry.roles[0] !== "node"
  ) {
    throw new Error("native pairing entry does not belong to the expected child node");
  }
  if (entry.displayName && entry.displayName !== expectedDisplayName) {
    throw new Error("native child pairing display name does not match");
  }
}

async function probeChildOperationalHealth(
  model: string,
  config: Record<string, unknown>,
): Promise<ChildOperationalProbes> {
  const channelPayload = await runJsonProbe(
    ["channels", "status", "--channel", "slack", "--probe", "--timeout", "10000", "--json"],
    35_000,
  );
  const modelPayload = await runJsonProbe(["models", "status", "--json"], 25_000);
  return buildOperationalProbes(
    channelPayload,
    modelPayload,
    model,
    undefined,
    buildDiagnostics(config),
    readManagedState(config).fallbackModels,
  );
}

async function runJsonProbe(args: string[], timeout: number): Promise<unknown> {
  try {
    return JSON.parse(await runOpenClawCli(args, timeout));
  } catch (error) {
    return { crabhelmError: boundedMessage(error) };
  }
}

export function buildOperationalProbes(
  channelPayload: unknown,
  modelPayload: unknown,
  configuredModel: string,
  checkedAt = new Date().toISOString(),
  diagnostics = buildDiagnostics({}),
  configuredFallbacks: string[] = [],
): ChildOperationalProbes {
  const channels = asRecord(channelPayload);
  const accountsValue = asRecord(channels.channelAccounts).slack;
  const accounts = Array.isArray(accountsValue) ? accountsValue.map(asRecord).slice(0, 20) : [];
  const channelError = optionalBoundedString(channels.crabhelmError, 300);
  const configured = accounts.some((account) => account.configured === true);
  const successful = accounts.find((account) => {
    const probe = asRecord(account.probe);
    const audit = asRecord(account.audit);
    return account.configured === true && probe.ok === true && audit.ok !== false;
  });
  const lastError = channelError ?? accounts
    .map((account) => optionalBoundedString(account.lastError, 300) ?? optionalBoundedString(asRecord(account.probe).error, 300))
    .find((value): value is string => Boolean(value));
  const probeValues = accounts.map((account) => asRecord(account.probe).ok).filter((value) => typeof value === "boolean");
  const auditValues = accounts.map((account) => asRecord(account.audit).ok).filter((value) => typeof value === "boolean");
  const models = asRecord(modelPayload);
  const auth = asRecord(models.auth);
  const modelError = optionalBoundedString(models.crabhelmError, 300);
  const missingProvidersValue = auth.missingProvidersInUse;
  const unusableProfilesValue = auth.unusableProfiles;
  const hasMissingProviders =
    Array.isArray(missingProvidersValue) &&
    missingProvidersValue.every((value) => typeof value === "string");
  const hasUnusableProfiles =
    Array.isArray(unusableProfilesValue) &&
    unusableProfilesValue.every(
      (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    );
  const statusFallbacks =
    Array.isArray(models.fallbacks) && models.fallbacks.every((value) => typeof value === "string")
    ? models.fallbacks
    : undefined;
  const exactModelEvidence =
    models.resolvedDefault === configuredModel &&
    statusFallbacks !== undefined &&
    statusFallbacks.length === configuredFallbacks.length &&
    statusFallbacks.every((value, index) => value === configuredFallbacks[index]);
  const validStatusShape = hasMissingProviders && hasUnusableProfiles && exactModelEvidence;
  const missingProviders = hasMissingProviders
    ? missingProvidersValue.filter((value): value is string => typeof value === "string").slice(0, 20)
    : [];
  const desiredProviders = new Set(
    [configuredModel, ...configuredFallbacks]
      .map((value) => value.split("/", 1)[0]?.toLowerCase())
      .filter((value): value is string => Boolean(value)),
  );
  const unusableProfiles = hasUnusableProfiles
    ? unusableProfilesValue.map(asRecord).filter((profile) => {
        const provider = typeof profile.provider === "string" ? profile.provider.toLowerCase() : "";
        return !provider || desiredProviders.has(provider);
      })
    : [];
  const authReady =
    validStatusShape &&
    !modelError &&
    missingProviders.length === 0 &&
    unusableProfiles.length === 0;
  const reportedMissingProviders = validStatusShape
    ? modelError
      ? ["model-status-command-failed"]
      : missingProviders
    : ["model-status-invalid"];
  return {
    checkedAt,
    slack: {
      status: channelError ? "degraded" : !configured ? "unconfigured" : successful ? "healthy" : "degraded",
      configured,
      connected: Boolean(successful && (successful.connected === true || successful.running === true || asRecord(successful.probe).ok === true)),
      accountCount: accounts.length,
      ...(probeValues.length ? { probeOk: probeValues.some((value) => value === true) } : {}),
      ...(auditValues.length ? { auditOk: auditValues.every((value) => value === true) } : {}),
      ...(lastError ? { lastError } : {}),
      ...maxTimestamp(accounts, "lastInboundAt"),
      ...maxTimestamp(accounts, "lastOutboundAt"),
    },
    model: {
      status: authReady ? "ready" : "degraded",
      configuredModel,
      ...(typeof models.resolvedDefault === "string"
        ? { resolvedModel: models.resolvedDefault.slice(0, 220) }
        : {}),
      authReady,
      liveInferenceProbe: false,
      missingProviders: reportedMissingProviders,
      unusableProfileCount: unusableProfiles.length,
    },
    diagnostics,
  };
}

function parseOperationalProbes(value: unknown, expectedModel: string): ChildOperationalProbes {
  const probes = asRecord(value);
  const checkedAt = requireString(probes.checkedAt, "probes.checkedAt", 80);
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtMs) || checkedAtMs > Date.now() + 5 * 60 * 1000) {
    throw new Error("Child returned invalid operational health timestamp");
  }
  const slack = asRecord(probes.slack);
  const model = asRecord(probes.model);
  const diagnostics = asRecord(probes.diagnostics);
  const slackStatus = slack.status;
  if (slackStatus !== "healthy" && slackStatus !== "degraded" && slackStatus !== "unconfigured") {
    throw new Error("Child returned invalid Slack health status");
  }
  const modelStatus = model.status;
  if (modelStatus !== "ready" && modelStatus !== "degraded") {
    throw new Error("Child returned invalid model health status");
  }
  if (model.configuredModel !== expectedModel || model.liveInferenceProbe !== false) {
    throw new Error("Child returned mismatched model health evidence");
  }
  if (typeof slack.configured !== "boolean" || typeof slack.connected !== "boolean") {
    throw new Error("Child returned invalid Slack health evidence");
  }
  const accountCount = requireBoundedInteger(slack.accountCount, "slack.accountCount", 0, 20);
  const authReady = model.authReady;
  if (typeof authReady !== "boolean") throw new Error("Child returned invalid model auth evidence");
  const missingProviders = Array.isArray(model.missingProviders)
    ? model.missingProviders.map((item) => requireString(item, "missing provider", 300)).slice(0, 20)
    : [];
  return {
    checkedAt,
    slack: {
      status: slackStatus,
      configured: slack.configured,
      connected: slack.connected,
      accountCount,
      ...(typeof slack.probeOk === "boolean" ? { probeOk: slack.probeOk } : {}),
      ...(typeof slack.auditOk === "boolean" ? { auditOk: slack.auditOk } : {}),
      ...(typeof slack.lastError === "string" ? { lastError: slack.lastError.slice(0, 300) } : {}),
      ...(validTimestamp(slack.lastInboundAt) ? { lastInboundAt: slack.lastInboundAt as number } : {}),
      ...(validTimestamp(slack.lastOutboundAt) ? { lastOutboundAt: slack.lastOutboundAt as number } : {}),
    },
    model: {
      status: modelStatus,
      configuredModel: expectedModel,
      ...(typeof model.resolvedModel === "string" ? { resolvedModel: model.resolvedModel.slice(0, 220) } : {}),
      authReady,
      liveInferenceProbe: false,
      missingProviders,
      unusableProfileCount: requireBoundedInteger(
        model.unusableProfileCount,
        "model.unusableProfileCount",
        0,
        10_000,
      ),
    },
    diagnostics: {
      logLevel: requireLogLevel(diagnostics.logLevel),
      redaction: requireRedaction(diagnostics.redaction),
      processUptimeSeconds: requireBoundedNumber(
        diagnostics.processUptimeSeconds,
        "diagnostics.processUptimeSeconds",
        0,
        10 * 365 * 24 * 60 * 60,
      ),
      rssBytes: requireBoundedNumber(diagnostics.rssBytes, "diagnostics.rssBytes", 0, 1024 ** 5),
      nodeVersion: requireString(diagnostics.nodeVersion, "diagnostics.nodeVersion", 80),
      platform: requireString(diagnostics.platform, "diagnostics.platform", 40),
      contentCaptured: false,
    },
  };
}

function buildDiagnostics(config: Record<string, unknown>): ChildOperationalProbes["diagnostics"] {
  const logging = asRecord(config.logging);
  const level = logging.level;
  const logLevel = level === "error" || level === "warn" || level === "debug" ? level : "info";
  const redactSensitive = logging.redactSensitive;
  const redaction = redactSensitive === "off" || redactSensitive === "tools"
    ? redactSensitive
    : "default";
  const memory = process.memoryUsage();
  return {
    logLevel,
    redaction,
    processUptimeSeconds: Math.max(0, Math.round(process.uptime())),
    rssBytes: Math.max(0, memory.rss),
    nodeVersion: process.version.slice(0, 80),
    platform: process.platform.slice(0, 40),
    contentCaptured: false,
  };
}

function requireLogLevel(value: unknown): "error" | "warn" | "info" | "debug" {
  if (value === "error" || value === "warn" || value === "info" || value === "debug") return value;
  throw new Error("Child returned invalid diagnostic log level");
}

function requireRedaction(value: unknown): "tools" | "off" | "default" {
  if (value === "tools" || value === "off" || value === "default") return value;
  throw new Error("Child returned invalid diagnostic redaction policy");
}

function maxTimestamp(accounts: Record<string, unknown>[], key: "lastInboundAt" | "lastOutboundAt") {
  const values = accounts.map((account) => account[key]).filter(validTimestamp) as number[];
  return values.length ? { [key]: Math.max(...values) } : {};
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalBoundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim()
    ? sanitizeDiagnosticMessage(value).slice(0, max)
    : undefined;
}

function boundedMessage(error: unknown): string {
  return sanitizeDiagnosticMessage(error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function sanitizeDiagnosticMessage(value: string): string {
  return value
    .replace(/\b(?:bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(xox[baprs]-)[A-Za-z0-9-]+/gi, "$1<redacted>")
    .replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?<redacted>")
    .replace(/\s+/g, " ")
    .trim();
}

function requireBoundedInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function requireBoundedNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function sanitizePairingRequest(value: unknown): ChildPairingRequest {
  const request = asRecord(value);
  const meta = asRecord(request.meta);
  const code = requireString(request.code, "pairing request code", 12).toUpperCase();
  const id = requireString(request.id, "pairing request id", 200);
  const createdAt = requireString(request.createdAt, "pairing request time", 80);
  return {
    code,
    id,
    createdAt,
    ...(typeof request.lastSeenAt === "string" ? { lastSeenAt: request.lastSeenAt.slice(0, 80) } : {}),
    ...(typeof request.accountId === "string"
      ? { accountId: request.accountId.slice(0, 80) }
      : typeof meta.accountId === "string"
        ? { accountId: meta.accountId.slice(0, 80) }
        : {}),
    ...(typeof request.label === "string"
      ? { label: request.label.slice(0, 120) }
      : typeof meta.name === "string"
        ? { label: meta.name.slice(0, 120) }
        : typeof meta.username === "string"
          ? { label: meta.username.slice(0, 120) }
        : {}),
  };
}

function parsePairingRequests(
  payload: Record<string, unknown>,
  childId: string,
  channel: "slack",
): ChildPairingRequest[] {
  if (
    payload.ok !== true ||
    payload.childId !== childId ||
    !isSupportedChildProtocol(payload.protocolVersion) ||
    payload.channel !== channel ||
    !Array.isArray(payload.requests)
  ) {
    throw new Error("Child returned invalid pairing evidence");
  }
  return payload.requests.map((request) => sanitizePairingRequest(request));
}

function requirePairingChannel(value: unknown): "slack" {
  if (value !== "slack") throw new Error("only Slack pairing is supported in this slice");
  return value;
}

function optionalAccountId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const accountId = requireString(value, "accountId", 64);
  if (!/^[A-Za-z0-9_-]+$/.test(accountId)) throw new Error("accountId is invalid");
  return accountId;
}

export function childNodeDisplayName(clawId: string): string {
  return `crabhelm:${clawId}`;
}

export function childNodeId(clawId: string): string {
  return `crabhelm-${clawId}`;
}

function requireChildId(params: Record<string, unknown>, childId: string): void {
  if (params.clawId !== childId) throw new Error("Crabhelm child identity mismatch");
}

function requireString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function isSupportedChildProtocol(value: unknown): value is 1 | 2 {
  return value === 1 || value === 2;
}

function parseRecord(value?: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  return asRecord(parsed);
}

function readPayload(value: unknown): Record<string, unknown> {
  const response = asRecord(value);
  if (typeof response.payloadJSON === "string") return parseRecord(response.payloadJSON);
  return asRecord(response.payload);
}

function childCommandFailure(
  childId: string,
  code: CrabhelmOperationalErrorCode,
): Record<string, unknown> {
  return { ok: false, childId, protocolVersion, error: { code } };
}

function throwIfChildCommandFailed(value: unknown): void {
  const payload = readPayload(value);
  if (payload.ok !== false) return;
  throw operationalErrorFromChildCode(asRecord(payload.error).code);
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
