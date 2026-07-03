import { createHash } from "node:crypto";
import { childPolicyHash } from "./domain.js";
import { CrabhelmOperationalError, operationalError } from "./errors.js";
import type {
  ChildOperationalProbes,
  ClawRecord,
  DisableResult,
  DrainResult,
  InspectResult,
  ParentControlLink,
  ProvisionResult,
  RevokeControlResult,
} from "./types.js";

type OpenClawNodeControl = {
  inspect(
    claw: ClawRecord,
    options?: { reconcileDesired?: boolean },
  ): Promise<{
    status: "pending" | "paired";
    message: string;
    controlLink?: ParentControlLink;
    gatewayReady?: boolean;
    gatewayVersion?: string;
    configHash?: string;
    ingressDisabled?: boolean;
    probes?: ChildOperationalProbes;
  }>;
  disable(claw: ClawRecord): Promise<{
    status: "pending" | "paired";
    message: string;
    controlLink?: ParentControlLink;
    gatewayReady?: boolean;
    configHash?: string;
    ingressDisabled?: boolean;
  }>;
  drain(claw: ClawRecord): Promise<DrainResult>;
  revokePairing(claw: ClawRecord): Promise<RevokeControlResult>;
};

export type ChildCoreProvider = {
  provision(claw: ClawRecord): Promise<ProvisionResult>;
  inspect(claw: ClawRecord, options?: { reconcileDesired?: boolean }): Promise<InspectResult>;
  disable(claw: ClawRecord): Promise<DisableResult>;
  drain(claw: ClawRecord): Promise<DrainResult>;
  remove(claw: ClawRecord): Promise<{ absent: boolean; message: string }>;
  revokeControl(claw: ClawRecord): Promise<RevokeControlResult>;
};

export type RoutedProviderTarget = {
  profile: string;
  region?: string;
  provider: ChildCoreProvider;
};

export class RoutedChildCoreProvider implements ChildCoreProvider {
  readonly #targets: ReadonlyMap<string, RoutedProviderTarget>;

  constructor(targets: Record<string, RoutedProviderTarget>) {
    this.#targets = new Map(Object.entries(targets));
  }

  async provision(claw: ClawRecord): Promise<ProvisionResult> {
    return this.#provider(claw).provision(claw);
  }

  async inspect(claw: ClawRecord, options?: { reconcileDesired?: boolean }): Promise<InspectResult> {
    return this.#provider(claw).inspect(claw, options);
  }

  async disable(claw: ClawRecord): Promise<DisableResult> {
    return this.#provider(claw).disable(claw);
  }

  async drain(claw: ClawRecord): Promise<DrainResult> {
    return this.#provider(claw).drain(claw);
  }

  async remove(claw: ClawRecord): Promise<{ absent: boolean; message: string }> {
    return this.#provider(claw).remove(claw);
  }

  async revokeControl(claw: ClawRecord): Promise<RevokeControlResult> {
    return this.#provider(claw).revokeControl(claw);
  }

  #provider(claw: ClawRecord): ChildCoreProvider {
    const deployment = claw.desired.deployment;
    const target = this.#targets.get(deployment.target);
    if (!target) {
      throw operationalError(
        "DEPLOYMENT_TARGET_UNAVAILABLE",
        `Deployment target ${deployment.target} is unavailable`,
      );
    }
    if (
      deployment.profile !== target.profile ||
      (deployment.region ?? "") !== (target.region ?? "")
    ) {
      throw operationalError(
        "DEPLOYMENT_TARGET_UNAVAILABLE",
        `Deployment target ${deployment.target} does not match its administrator policy`,
      );
    }
    return target.provider;
  }
}

export class SimulatorChildCoreProvider implements ChildCoreProvider {
  async provision(claw: ClawRecord): Promise<ProvisionResult> {
    const now = new Date().toISOString();
    const workspaceId = crabboxWorkspaceId(claw);
    return {
      phase: "ready",
      message: "Child Gateway healthy; parent control identity paired",
      health: "healthy",
      lifecycle: {
        workspaceId,
        providerResourceId: `sim/${workspaceId}`,
        responseDigest: createHash("sha256").update(`${claw.id}:${workspaceId}`).digest("hex"),
      },
      controlLink: {
        status: "paired",
        transport: "openclaw-node",
        command: "crabhelm.child.status",
        nodeId: `sim-child-${claw.id.slice(0, 8)}`,
        lastSeenAt: now,
      },
      gatewayVersion: "simulated-2026.6.11",
      configHash: childPolicyHash(claw),
      probes: simulatedProbes(claw),
    };
  }

  async inspect(claw: ClawRecord): Promise<InspectResult> {
    if (!claw.observed.lifecycle) {
      return { absent: true };
    }
    return {
      phase: claw.desired.enabled ? "ready" : "ready",
      health: "healthy",
      message: "Child Gateway healthy; desired state converged",
      lifecycle: claw.observed.lifecycle,
      controlLink: {
        ...claw.observed.controlLink,
        status: "paired",
        lastSeenAt: new Date().toISOString(),
      },
      gatewayVersion: claw.observed.gatewayVersion ?? "simulated-2026.6.11",
      configHash: childPolicyHash(claw),
      probes: claw.observed.probes ?? simulatedProbes(claw),
      lastSeenAt: new Date().toISOString(),
    };
  }

  async disable(claw: ClawRecord): Promise<DisableResult> {
    return {
      applied: true,
      health: "healthy",
      message: "Child ingress disabled; workspace retained",
      lifecycle: claw.observed.lifecycle,
      controlLink: { ...claw.observed.controlLink, status: "paired" },
      lastSeenAt: new Date().toISOString(),
      configHash: childPolicyHash(claw),
    };
  }

  async drain(_claw: ClawRecord): Promise<DrainResult> {
    return {
      drained: true,
      activeRuns: 0,
      checkedAt: new Date().toISOString(),
      message: "Simulated child has no active runs",
    };
  }

  async remove(_claw: ClawRecord): Promise<{ absent: boolean; message: string }> {
    return { absent: true, message: "Provider resource confirmed absent" };
  }

  async revokeControl(_claw: ClawRecord): Promise<RevokeControlResult> {
    return {
      removedPairedDevice: true,
      rejectedPendingRequest: false,
      alreadyAbsent: false,
      message: "Simulated native parent pairing removed",
    };
  }
}

export type CrabboxProviderOptions = {
  baseUrl: string;
  token: string;
  profile: string;
  ttlSeconds: number;
  idleTimeoutSeconds: number;
  nodeControl?: OpenClawNodeControl;
  workspaceBootstrap?: {
    command(claw: ClawRecord): Promise<string>;
    inspect(
      claw: ClawRecord,
      workspace: { status: string; attachUrl?: string },
    ): Promise<{ ready: boolean; message: string; gatewayVersion?: string }>;
    disable?(claw: ClawRecord): Promise<DisableResult>;
    drain?(claw: ClawRecord): Promise<DrainResult>;
    revokeControl?(claw: ClawRecord): Promise<RevokeControlResult>;
    runtimeDiagnostics?(
      claw: ClawRecord,
      workspace: { status: string; attachUrl?: string },
    ): Promise<{ events: Array<Record<string, unknown>>; processes: string[] }>;
  };
  fetch?: typeof globalThis.fetch;
};

export function createConfiguredCrabboxTargetProvider(
  targetId: string,
  options: CrabboxProviderOptions,
): { provider: ChildCoreProvider; admissionOpen: boolean; message?: string } {
  try {
    return { provider: new CrabboxChildCoreProvider(options), admissionOpen: true };
  } catch {
    const message = `Crabbox configuration is invalid for deployment target ${targetId}`;
    return {
      provider: new UnconfiguredChildCoreProvider(message),
      admissionOpen: false,
      message,
    };
  }
}

export class CrabboxChildCoreProvider implements ChildCoreProvider {
  readonly #options: CrabboxProviderOptions;

  constructor(options: CrabboxProviderOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new Error("Crabbox adapter URL must use HTTPS or loopback HTTP");
    }
    if (url.search || url.hash) {
      throw new Error("Crabbox adapter URL must not include a query or fragment");
    }
    this.#options = { ...options, baseUrl: url.toString().replace(/\/$/, "") };
  }

  async provision(claw: ClawRecord): Promise<ProvisionResult> {
    if (claw.desired.deployment.profile !== this.#options.profile) {
      throw operationalError("CRABBOX_UNCONFIGURED", "Child deployment profile is not allowed");
    }
    const workspaceId = crabboxWorkspaceId(claw);
    const command = await this.#options.workspaceBootstrap?.command(claw);
    const response = await this.#request("/v1/workspaces", {
      method: "POST",
      // Crabbox binds retries to the workspace identity itself.
      headers: { "idempotency-key": workspaceId },
      body: JSON.stringify({
        id: workspaceId,
        parentSessionId: null,
        rootSessionId: claw.id,
        profile: this.#options.profile,
        purpose: `OpenClaw child core for ${claw.desired.owner.subject}`,
        summary: `Crabhelm child ${claw.desired.name}`,
        owner: claw.desired.owner.subject,
        createdBy: "crabhelm-parent",
        ttlSeconds: this.#options.ttlSeconds,
        idleTimeoutSeconds: this.#options.idleTimeoutSeconds,
        capabilities: { desktop: false, browser: false, code: false },
        ...(command ? { command } : {}),
      }),
    });
    const body = asRecord(await readBody(response));
    if (!response.ok) {
      const providerCode = readString(body, "code") ?? readString(asRecord(body.error), "code") ?? "unknown";
      const providerMessage = readString(body, "message") ??
        (typeof body.error === "string" ? body.error : readString(asRecord(body.error), "message")) ??
        "unspecified";
      console.error(JSON.stringify({
        event: "crabbox_create_rejected",
        status: response.status,
        code: providerCode,
        message: providerMessage,
      }));
      throw operationalError(
        "CRABBOX_CREATE_HTTP",
        `Crabbox create failed (HTTP ${response.status}, ${providerCode}): ${providerMessage.slice(0, 200)}`,
      );
    }
    const reportedId = readString(body, "id") ?? readString(asRecord(body.workspace), "id");
    if (reportedId !== workspaceId) {
      throw operationalError(
        "CRABBOX_IDENTITY_MISMATCH",
        "Crabbox returned a different workspace identity",
      );
    }
    const workspace = asRecord(body.workspace);
    const status = (
      readString(body, "status") ?? readString(workspace, "status") ?? ""
    ).toLowerCase();
    if (status !== "provisioning" && status !== "ready") {
      throw operationalError(
        "CRABBOX_CREATE_STATE",
        status
          ? `Crabbox create did not enter an active state (${status})`
          : "Crabbox create returned no lifecycle state",
      );
    }
    const providerResourceId =
      readString(body, "providerResourceId") ?? readString(body, "provider_resource_id");
    return {
      phase: "enrolling",
      message: "Workspace created; waiting for child Gateway enrollment",
      health: "unknown",
      lifecycle: {
        workspaceId,
        ...(providerResourceId ? { providerResourceId } : {}),
        responseDigest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      },
    };
  }

  async inspect(
    claw: ClawRecord,
    options: { reconcileDesired?: boolean } = {},
  ): Promise<InspectResult> {
    const id = claw.observed.lifecycle?.workspaceId ??
      (claw.observed.deletion ? crabboxWorkspaceId(claw) : undefined);
    if (!id) {
      return { absent: true };
    }
    const response = await this.#request(`/v1/workspaces/${encodeURIComponent(id)}`, {
      method: "GET",
    });
    if (response.status === 404) {
      return { absent: true };
    }
    const body = asRecord(await readBody(response));
    if (!response.ok) {
      throw operationalError(
        "CRABBOX_INSPECT_HTTP",
        `Crabbox inspect failed (HTTP ${response.status})`,
      );
    }
    const reportedId = readString(body, "id") ?? readString(asRecord(body.workspace), "id");
    if (reportedId !== id) {
      throw operationalError(
        "CRABBOX_IDENTITY_MISMATCH",
        "Crabbox inspect returned a different workspace identity",
      );
    }
    const workspace = asRecord(body.workspace);
    const status = (readString(body, "status") ?? readString(workspace, "status"))?.toLowerCase();
    const attachUrl = readString(body, "attachUrl") ?? readString(workspace, "attachUrl");
    if (status === "stopped" || status === "deleted") {
      return { absent: true, message: `Crabbox provider reports ${status}` };
    }
    if (status === "failed" || status === "error") {
      const diagnostic = crabboxWorkspaceFailureDiagnostic(body, workspace);
      throw operationalError("CRABBOX_WORKSPACE_FAILED", `Crabbox workspace reported failure${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    if (this.#options.workspaceBootstrap && status === "ready") {
      const bootstrap = await this.#options.workspaceBootstrap.inspect(claw, {
        status,
        ...(attachUrl ? { attachUrl } : {}),
      });
      if (bootstrap.ready) {
        const now = new Date().toISOString();
        const probes = workspaceOperationalProbes(claw, now);
        return {
          phase: "ready",
          health: "healthy",
          message: bootstrap.message,
          lifecycle: claw.observed.lifecycle,
          controlLink: {
            status: "paired",
            transport: "crabbox-workspace",
            command: "crabhelm.bootstrap.status",
            nodeId: id,
            lastSeenAt: now,
          },
          ...(bootstrap.gatewayVersion ? { gatewayVersion: bootstrap.gatewayVersion } : {}),
          configHash: childPolicyHash(claw),
          probes,
          lastSeenAt: now,
        };
      }
      return {
        phase: "enrolling",
        health: "unknown",
        message: bootstrap.message,
        lifecycle: claw.observed.lifecycle,
      };
    }
    let nodeEvidence;
    try {
      nodeEvidence = await this.#options.nodeControl?.inspect(claw, {
        reconcileDesired: options.reconcileDesired !== false,
      });
    } catch (error) {
      if (error instanceof CrabhelmOperationalError) throw error;
      throw operationalError(
        "CHILD_CONTROL_FAILED",
        "Child control policy or health reconciliation failed",
        error,
      );
    }
    const desiredHash = childPolicyHash(claw);
    const policyReady =
      nodeEvidence?.status === "paired" &&
      nodeEvidence.gatewayReady === true &&
      nodeEvidence.ingressDisabled !== true &&
      nodeEvidence.configHash === desiredHash;
    const operationalReady =
      nodeEvidence?.probes?.model.authReady === true &&
      (!claw.desired.channels.slack.enabled || nodeEvidence.probes.slack.status === "healthy");
    const ready = policyReady && operationalReady;
    const attention = policyReady && Boolean(nodeEvidence?.probes) && !operationalReady;
    return {
      phase: ready ? "ready" : attention ? "attention" : "enrolling",
      health: ready ? "healthy" : attention ? "degraded" : "unknown",
      message:
        nodeEvidence?.message ??
        (status === "stopping"
          ? "Crabbox provider release is pending"
          : `Workspace provider status is ${status ?? "unknown"}; child bootstrap is pending`),
      lifecycle: claw.observed.lifecycle,
      ...(nodeEvidence?.controlLink ? { controlLink: nodeEvidence.controlLink } : {}),
      ...(nodeEvidence?.gatewayVersion ? { gatewayVersion: nodeEvidence.gatewayVersion } : {}),
      ...(nodeEvidence?.configHash ? { configHash: nodeEvidence.configHash } : {}),
      ...(nodeEvidence?.probes ? { probes: nodeEvidence.probes } : {}),
      ...(ready ? { lastSeenAt: new Date().toISOString() } : {}),
    };
  }

  async runtimeDiagnostics(claw: ClawRecord): Promise<{ events: Array<Record<string, unknown>>; processes: string[] }> {
    const id = claw.observed.lifecycle?.workspaceId;
    if (!id) throw new Error("claw has no Crabbox workspace");
    const response = await this.#request(`/v1/workspaces/${encodeURIComponent(id)}`, { method: "GET" });
    const body = asRecord(await readBody(response));
    if (!response.ok) throw new Error(`Crabbox diagnostics inspection failed (HTTP ${response.status})`);
    const workspace = asRecord(body.workspace);
    const status = (readString(body, "status") ?? readString(workspace, "status") ?? "").toLowerCase();
    const attachUrl = readString(body, "attachUrl") ?? readString(workspace, "attachUrl");
    if (!this.#options.workspaceBootstrap?.runtimeDiagnostics) throw new Error("runtime diagnostics are unavailable");
    return this.#options.workspaceBootstrap.runtimeDiagnostics(claw, {
      status,
      ...(attachUrl ? { attachUrl } : {}),
    });
  }

  async disable(claw: ClawRecord): Promise<DisableResult> {
    if (this.#options.workspaceBootstrap?.disable) {
      return this.#options.workspaceBootstrap.disable(claw);
    }
    if (this.#options.nodeControl) {
      let evidence;
      try {
        evidence = await this.#options.nodeControl.disable(claw);
      } catch (error) {
        if (error instanceof CrabhelmOperationalError) throw error;
        throw operationalError(
          "CHILD_INGRESS_DISABLE_FAILED",
          "Child ingress disable could not be verified",
          error,
        );
      }
      return {
        applied: evidence.ingressDisabled === true,
        health: evidence.gatewayReady ? "healthy" : "unknown",
        message: evidence.message,
        lifecycle: claw.observed.lifecycle,
        controlLink: evidence.controlLink ?? claw.observed.controlLink,
        lastSeenAt: new Date().toISOString(),
        ...(evidence.configHash ? { configHash: evidence.configHash } : {}),
      };
    }
    return {
      applied: false,
      health: "unknown",
      message: "Disable refused: an enrolled child node control link is required",
      lifecycle: claw.observed.lifecycle,
      controlLink: claw.observed.controlLink,
    };
  }

  async drain(claw: ClawRecord): Promise<DrainResult> {
    if (this.#options.workspaceBootstrap?.drain) {
      return this.#options.workspaceBootstrap.drain(claw);
    }
    if (!this.#options.nodeControl) {
      throw operationalError(
        "CHILD_CONTROL_FAILED",
        "Session drain requires an enrolled child node control link",
      );
    }
    try {
      return await this.#options.nodeControl.drain(claw);
    } catch (error) {
      if (error instanceof CrabhelmOperationalError) throw error;
      throw operationalError(
        "CHILD_CONTROL_FAILED",
        "Child active-run drain could not be verified",
        error,
      );
    }
  }

  async remove(claw: ClawRecord): Promise<{ absent: boolean; message: string }> {
    const id = claw.observed.lifecycle?.workspaceId ??
      (claw.observed.deletion ? crabboxWorkspaceId(claw) : undefined);
    if (!id) {
      return { absent: true, message: "No provider identity remains" };
    }
    const response = await this.#request(`/v1/workspaces/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      throw operationalError(
        "CRABBOX_DELETE_HTTP",
        `Crabbox delete failed (HTTP ${response.status})`,
      );
    }
    const check = await this.inspect(claw, { reconcileDesired: false });
    return {
      absent: check.absent === true,
      message: check.absent ? "Provider resource confirmed absent" : "Provider deletion pending",
    };
  }

  async revokeControl(claw: ClawRecord): Promise<RevokeControlResult> {
    if (this.#options.workspaceBootstrap?.revokeControl) {
      return this.#options.workspaceBootstrap.revokeControl(claw);
    }
    if (!this.#options.nodeControl) {
      throw operationalError(
        "CHILD_CONTROL_FAILED",
        "Native parent pairing cleanup is unavailable",
      );
    }
    try {
      return await this.#options.nodeControl.revokePairing(claw);
    } catch (error) {
      if (error instanceof CrabhelmOperationalError) throw error;
      throw operationalError(
        "CHILD_CONTROL_FAILED",
        "Native parent pairing cleanup could not be verified",
        error,
      );
    }
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const fetcher = this.#options.fetch ?? globalThis.fetch;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#options.token}`);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    try {
      return await fetcher(`${this.#options.baseUrl}${path}`, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers,
      });
    } catch (error) {
      throw operationalError("CRABBOX_UNREACHABLE", "Crabbox adapter is unreachable", error);
    }
  }
}

function simulatedProbes(claw: ClawRecord): NonNullable<ProvisionResult["probes"]> {
  return {
    checkedAt: new Date().toISOString(),
    slack: {
      status: claw.desired.channels.slack.enabled ? "healthy" : "unconfigured",
      configured: claw.desired.channels.slack.enabled,
      connected: claw.desired.channels.slack.enabled,
      accountCount: claw.desired.channels.slack.enabled ? 1 : 0,
      ...(claw.desired.channels.slack.enabled ? { probeOk: true, auditOk: true } : {}),
    },
    model: {
      status: "ready",
      configuredModel: claw.desired.inference.model,
      resolvedModel: claw.desired.inference.model,
      authReady: true,
      liveInferenceProbe: false,
      missingProviders: [],
      unusableProfileCount: 0,
    },
    diagnostics: {
      logLevel: claw.desired.observability.logLevel,
      redaction: "tools",
      processUptimeSeconds: 0,
      rssBytes: 0,
      nodeVersion: process.version,
      platform: process.platform,
      contentCaptured: false,
    },
  };
}

function workspaceOperationalProbes(
  claw: ClawRecord,
  checkedAt: string,
): NonNullable<ProvisionResult["probes"]> {
  return {
    checkedAt,
    slack: {
      status: "unconfigured",
      configured: false,
      connected: false,
      accountCount: 0,
    },
    model: {
      status: "ready",
      configuredModel: claw.desired.inference.model,
      resolvedModel: claw.desired.inference.model,
      authReady: true,
      liveInferenceProbe: true,
      missingProviders: [],
      unusableProfileCount: 0,
    },
    diagnostics: {
      logLevel: claw.desired.observability.logLevel,
      redaction: "tools",
      processUptimeSeconds: 0,
      rssBytes: 0,
      nodeVersion: "managed-runtime",
      platform: "crabbox-workspace",
      contentCaptured: false,
    },
  };
}

function crabboxWorkspaceFailureDiagnostic(...roots: Record<string, unknown>[]): string | undefined {
  const records = roots.flatMap((root) => [
    root,
    asRecord(root.error),
    asRecord(root.failure),
    asRecord(root.details),
  ]);
  for (const record of records) {
    const code = (readString(record, "code") ?? readString(record, "reason"))?.toLowerCase();
    const message = readString(record, "message") ?? (typeof record.error === "string" ? record.error : undefined);
    const status = message?.match(/\bCRABHELM_[A-Z0-9_]{3,80}\b/u)?.[0];
    if (status) return status;
    if (message === "workspace provisioning deadline expired" || message === "workspace provisioning failed") return message;
    const normalized = `${code ?? ""} ${message?.toLowerCase() ?? ""}`;
    const category = [
      ["permission denied", "PROVIDER_PERMISSION_DENIED"],
      ["no such file", "PROVIDER_FILE_MISSING"],
      ["not found", "PROVIDER_DEPENDENCY_MISSING"],
      ["syntax", "PROVIDER_COMMAND_SYNTAX"],
      ["timed out", "PROVIDER_TIMEOUT"],
      ["timeout", "PROVIDER_TIMEOUT"],
      ["exit status", "PROVIDER_COMMAND_EXIT"],
      ["exited with", "PROVIDER_COMMAND_EXIT"],
      ["bootstrap", "PROVIDER_BOOTSTRAP_FAILED"],
      ["capacity", "PROVIDER_CAPACITY"],
    ].find(([needle]) => normalized?.includes(needle));
    if (category) return category[1];
  }
  return undefined;
}

export class UnconfiguredChildCoreProvider implements ChildCoreProvider {
  readonly #message: string;

  constructor(message: string) {
    this.#message = message;
  }

  provision(): Promise<ProvisionResult> {
    return Promise.reject(operationalError("CRABBOX_UNCONFIGURED", this.#message));
  }

  inspect(): Promise<InspectResult> {
    return Promise.reject(operationalError("CRABBOX_UNCONFIGURED", this.#message));
  }

  disable(): Promise<DisableResult> {
    return Promise.reject(operationalError("CRABBOX_UNCONFIGURED", this.#message));
  }

  drain(): Promise<DrainResult> {
    return Promise.reject(operationalError("CRABBOX_UNCONFIGURED", this.#message));
  }

  remove(): Promise<{ absent: boolean; message: string }> {
    return Promise.reject(operationalError("CRABBOX_UNCONFIGURED", this.#message));
  }

  revokeControl(): Promise<RevokeControlResult> {
    return Promise.reject(operationalError("CRABBOX_UNCONFIGURED", this.#message));
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

async function readBody(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, 100_000);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
}

export function crabboxWorkspaceId(claw: Pick<ClawRecord, "id" | "desired">): string {
  const direct = `crabhelm-${claw.desired.slug}`;
  if (direct.length <= 63) return direct;
  const suffix = claw.id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 8);
  const slug = claw.desired.slug.slice(0, 45).replace(/-+$/g, "");
  return `crabhelm-${slug}-${suffix}`;
}
