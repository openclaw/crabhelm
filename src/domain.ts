import { createHash, randomUUID } from "node:crypto";
import type {
  AccessPolicy,
  ClawRouterFleetPolicy,
  ClawRecord,
  CreateClawInput,
  DeploymentSpec,
  FleetSummary,
  InferencePolicy,
  InferenceRouter,
  ManagedPolicySpec,
  ObservabilityPolicy,
  OwnerRef,
  PolicyFieldChange,
  SlackPolicy,
  UpdateClawInput,
} from "./types.js";

const subjectPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/+\-]{0,199}$/;
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const directModelPattern = /^[a-z0-9][a-z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.:\-]{0,199}$/;
const clawRouterModelPattern = /^clawrouter\/[a-z0-9][a-z0-9-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9_.:\-]{0,199}(?:\/[a-zA-Z0-9][a-zA-Z0-9_.:\-]{0,199})*$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

export type CreateClawRecordOptions = {
  id?: string;
  clawRouter?: ClawRouterFleetPolicy;
};

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
  const clean = value.trim();
  if (!clean || clean.length > max) {
    throw new Error(`${label} must be between 1 and ${max} characters`);
  }
  return clean;
}

function normalizeOwner(owner: OwnerRef): OwnerRef {
  const subject = requireText(owner?.subject, "owner subject", 200);
  if (!subjectPattern.test(subject)) {
    throw new Error("owner subject contains unsupported characters");
  }
  const source = owner?.source;
  if (source !== "github" && source !== "slack" && source !== "email" && source !== "manual") {
    throw new Error("owner source must be github, slack, email, or manual");
  }
  return {
    subject,
    label: requireText(owner?.label, "owner label", 120),
    source,
  };
}

function normalizeModels(
  input: CreateClawInput["inference"] | undefined,
  clawId: string,
  clawRouter?: ClawRouterFleetPolicy,
  allowClawRouterTemplate = false,
): InferencePolicy {
  const model = requireText(
    input?.model ?? clawRouter?.defaultModel ?? "openai/gpt-5.5",
    "inference model",
    220,
  );
  const fallbackModels = [...new Set(input?.fallbackModels ?? [])];
  const routedSyntax = Boolean(clawRouter) || (allowClawRouterTemplate && model.startsWith("clawrouter/"));
  for (const value of [model, ...fallbackModels]) {
    if (routedSyntax ? !clawRouterModelPattern.test(value) : !directModelPattern.test(value)) {
      throw new Error(routedSyntax
        ? `ClawRouter fleets require clawrouter/provider/model form: ${value}`
        : `model must use provider/model form: ${value}`);
    }
  }
  const modelProvider = model.slice(0, model.indexOf("/"));
  if (input?.provider !== undefined) {
    const requestedProvider = requireText(input.provider, "inference provider", 80);
    if (requestedProvider !== modelProvider) {
      throw new Error(`inference provider ${requestedProvider} does not match model ${model}`);
    }
  }
  const monthlyBudgetUsd = input?.monthlyBudgetUsd;
  if (
    monthlyBudgetUsd !== undefined &&
    (!Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd < 0 || monthlyBudgetUsd > 1_000_000)
  ) {
    throw new Error("monthly budget must be between 0 and 1000000 USD");
  }
  let router: InferenceRouter = { kind: "direct" };
  let authRef = input?.authRef
    ? requireText(input.authRef, "inference auth ref", 240)
    : undefined;
  if (clawRouter) {
    const models = [model, ...fallbackModels];
    if (models.some((value) => !value.startsWith("clawrouter/"))) {
      throw new Error("ClawRouter fleets require clawrouter/provider/model references");
    }
    const providers = [...new Set(models.map((value) => value.split("/")[1] ?? ""))].sort();
    if (providers.some((provider) => !clawRouter.allowedProviders.includes(provider))) {
      throw new Error("inference model provider is outside the fleet ClawRouter allowlist");
    }
    const credentialId = clawRouterCredentialId(clawId);
    router = {
      kind: "clawrouter",
      baseUrl: clawRouter.baseUrl,
      tenantId: clawRouter.tenantId,
      policyId: credentialId,
      credentialId,
      allowedProviders: [...clawRouter.allowedProviders],
      providers,
    };
    authRef = `clawrouter:${credentialId}`;
  }
  return {
    provider: modelProvider,
    model,
    fallbackModels,
    ...(authRef ? { authRef } : {}),
    ...(monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd } : {}),
    router,
  };
}

function clawRouterCredentialId(clawId: string): string {
  const compact = clawId.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(compact)) throw new Error("claw id is invalid for ClawRouter identity");
  return `crabhelm_${compact}`;
}

function normalizeSlack(input: Partial<SlackPolicy> | undefined, slug: string): SlackPolicy {
  const mode = input?.mode ?? "socket";
  if (mode !== "relay" && mode !== "socket" && mode !== "http") {
    throw new Error("Slack mode must be relay, socket, or http");
  }
  return {
    enabled: input?.enabled ?? false,
    mode,
    ...(input?.workspaceId
      ? { workspaceId: requireText(input.workspaceId, "Slack workspace id", 80) }
      : {}),
    routeKey: requireText(input?.routeKey ?? slug, "Slack route key", 120),
    ...(input?.botTokenRef
      ? { botTokenRef: requireText(input.botTokenRef, "Slack bot token ref", 240) }
      : {}),
    ...(input?.relayTokenRef
      ? { relayTokenRef: requireText(input.relayTokenRef, "Slack relay token ref", 240) }
      : {}),
  };
}

function normalizeAccess(input?: Partial<AccessPolicy>): AccessPolicy {
  const dmPolicy = input?.dmPolicy ?? "pairing";
  const groupPolicy = input?.groupPolicy ?? "allowlist";
  if (!(["pairing", "allowlist", "disabled"] as const).includes(dmPolicy)) {
    throw new Error("DM policy must be pairing, allowlist, or disabled");
  }
  if (!(["allowlist", "disabled"] as const).includes(groupPolicy)) {
    throw new Error("group policy must be allowlist or disabled");
  }
  return { dmPolicy, groupPolicy };
}

function normalizeObservability(
  input: CreateClawInput["observability"] | undefined,
  slug = "openclaw",
): ObservabilityPolicy {
  const logLevel = input?.logLevel ?? "info";
  if (!(["error", "warn", "info", "debug"] as const).includes(logLevel)) {
    throw new Error("log level must be error, warn, info, or debug");
  }
  const retentionDays = input?.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("retention must be between 1 and 365 days");
  }
  for (const [field, value] of [
    ["enabled", input?.otel?.enabled],
    ["traces", input?.otel?.traces],
    ["metrics", input?.otel?.metrics],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`OpenTelemetry ${field} must be a boolean`);
    }
  }
  const rawEndpoint = input?.otel?.endpoint;
  if (rawEndpoint !== undefined && typeof rawEndpoint !== "string") {
    throw new Error("OpenTelemetry endpoint must be a string");
  }
  const endpoint = rawEndpoint?.trim();
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("OpenTelemetry endpoint must be an HTTPS URL without credentials, query, or fragment");
    }
  }
  const enabled = input?.otel?.enabled ?? false;
  if (enabled && !endpoint) throw new Error("OpenTelemetry endpoint is required when export is enabled");
  const traces = input?.otel?.traces ?? true;
  const metrics = input?.otel?.metrics ?? true;
  if (enabled && !traces && !metrics) {
    throw new Error("OpenTelemetry export requires traces, metrics, or both");
  }
  if (input?.otel?.logs !== undefined && input.otel.logs !== false) {
    throw new Error("OpenTelemetry log export is unavailable under metadata-only policy");
  }
  const sampleRate = input?.otel?.sampleRate ?? 0.1;
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new Error("OpenTelemetry sample rate must be between 0 and 1");
  }
  const flushIntervalMs = input?.otel?.flushIntervalMs ?? 60_000;
  if (!Number.isInteger(flushIntervalMs) || flushIntervalMs < 1_000 || flushIntervalMs > 300_000) {
    throw new Error("OpenTelemetry flush interval must be between 1000 and 300000 milliseconds");
  }
  const serviceName = requireText(input?.otel?.serviceName ?? `crabhelm-${slug}`, "OpenTelemetry service name", 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(serviceName)) {
    throw new Error("OpenTelemetry service name contains unsupported characters");
  }
  return {
    logLevel,
    retentionDays,
    metadataOnly: true,
    otel: {
      enabled,
      ...(endpoint ? { endpoint } : {}),
      serviceName,
      traces,
      metrics,
      logs: false,
      sampleRate,
      flushIntervalMs,
    },
  };
}

function normalizeAppliance(input: CreateClawInput["deployment"]): DeploymentSpec["appliance"] {
  if (!input?.appliance) return undefined;
  const manifestSha256 = requireText(input.appliance.manifestSha256, "appliance manifest SHA-256", 64);
  const archiveSha256 = requireText(input.appliance.archiveSha256, "appliance archive SHA-256", 64);
  const nodeSha256 = requireText(input.appliance.nodeSha256, "appliance Node SHA-256", 64);
  if (!sha256Pattern.test(manifestSha256) || !sha256Pattern.test(archiveSha256) || !sha256Pattern.test(nodeSha256)) {
    throw new Error("appliance release digests must be lowercase SHA-256 values");
  }
  return { manifestSha256, archiveSha256, nodeSha256 };
}

export function normalizeManagedPolicySpec(input: ManagedPolicySpec): ManagedPolicySpec {
  const inference = normalizeModels(
    input?.inference,
    "00000000-0000-4000-8000-000000000000",
    undefined,
    true,
  );
  return {
    inference: {
      model: inference.model,
      fallbackModels: inference.fallbackModels,
    },
    slackEnabled: Boolean(input?.slackEnabled),
    access: normalizeAccess(input?.access),
    observability: {
      logLevel: normalizeObservability(input?.observability).logLevel,
    },
  };
}

export function managedPolicyPatch(
  policyId: string,
  version: number,
  spec: ManagedPolicySpec,
): UpdateClawInput {
  return {
    templateId: requireText(policyId, "policy id", 80),
    templateVersion: version,
    inference: {
      model: spec.inference.model,
      fallbackModels: spec.inference.fallbackModels,
    },
    slack: { enabled: spec.slackEnabled },
    access: spec.access,
    observability: { logLevel: spec.observability.logLevel },
  };
}

export function managedPolicyDiff(record: ClawRecord, spec: ManagedPolicySpec): PolicyFieldChange[] {
  const fields: Array<[string, string | boolean, string | boolean]> = [
    ["inference.model", record.desired.inference.model, spec.inference.model],
    [
      "inference.fallbackModels",
      record.desired.inference.fallbackModels.join(", ") || "none",
      spec.inference.fallbackModels.join(", ") || "none",
    ],
    ["channels.slack.enabled", record.desired.channels.slack.enabled, spec.slackEnabled],
    ["access.dmPolicy", record.desired.access.dmPolicy, spec.access.dmPolicy],
    ["access.groupPolicy", record.desired.access.groupPolicy, spec.access.groupPolicy],
    ["observability.logLevel", record.desired.observability.logLevel, spec.observability.logLevel],
  ];
  return fields
    .filter(([, before, after]) => before !== after)
    .map(([field, before, after]) => ({ field, before, after }));
}

export function createClawRecord(
  input: CreateClawInput,
  now = new Date(),
  options: CreateClawRecordOptions = {},
): ClawRecord {
  const id = options.id ?? randomUUID();
  const name = requireText(input.name, "name", 80);
  const slug = input.slug ? requireText(input.slug, "slug", 63) : slugify(name);
  if (!slugPattern.test(slug)) {
    throw new Error("slug must be a lowercase DNS label");
  }
  const profile = requireText(input.deployment?.profile ?? "openclaw-core", "profile", 63);
  if (!slugPattern.test(profile)) {
    throw new Error("deployment profile must be a lowercase DNS label");
  }
  const appliance = normalizeAppliance(input.deployment);
  const timestamp = now.toISOString();
  return {
    id,
    revision: 1,
    desired: {
      generation: 1,
      name,
      slug,
      owner: normalizeOwner(input.owner),
      templateId: requireText(input.templateId ?? "default", "template id", 80),
      templateVersion: input.templateVersion ?? 1,
      deployment: {
        target: requireText(input.deployment?.target ?? "default", "deployment target", 80),
        profile,
        ...(input.deployment?.region
          ? { region: requireText(input.deployment.region, "region", 80) }
          : {}),
        ...(appliance ? { appliance } : {}),
      },
      inference: normalizeModels(input.inference, id, options.clawRouter),
      channels: { slack: normalizeSlack(input.slack, slug) },
      access: normalizeAccess(input.access),
      observability: normalizeObservability(input.observability, slug),
      enabled: true,
      credentialsGeneration: 1,
    },
    observed: {
      generation: 0,
      phase: "requested",
      message: "Waiting for the parent reconciler",
      health: "unknown",
      controlLink: {
        status: "pending",
        transport: "openclaw-node",
        command: "crabhelm.child.status",
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updateClawRecord(
  record: ClawRecord,
  patch: UpdateClawInput,
  now = new Date(),
): ClawRecord {
  const inference = {
    ...record.desired.inference,
    ...patch.inference,
    ...(patch.inference?.model !== undefined && patch.inference.provider === undefined
      ? { provider: undefined }
      : {}),
  };
  const router = record.desired.inference.router;
  const merged = createClawRecord(
    {
      name: patch.name ?? record.desired.name,
      slug: record.desired.slug,
      owner: patch.owner ?? record.desired.owner,
      templateId: patch.templateId ?? record.desired.templateId,
      templateVersion: patch.templateVersion ?? record.desired.templateVersion,
      deployment: { ...record.desired.deployment, ...patch.deployment },
      inference,
      slack: { ...record.desired.channels.slack, ...patch.slack },
      access: { ...record.desired.access, ...patch.access },
      observability: {
        ...record.desired.observability,
        ...patch.observability,
        otel: { ...record.desired.observability.otel, ...patch.observability?.otel },
      },
    },
    now,
    {
      id: record.id,
      ...(router.kind === "clawrouter"
        ? {
            clawRouter: {
              baseUrl: router.baseUrl,
              tenantId: router.tenantId,
              allowedProviders: router.allowedProviders,
              defaultModel: record.desired.inference.model,
            },
          }
        : {}),
    },
  );
  const desired = {
    ...merged.desired,
    generation: record.desired.generation,
    enabled: record.desired.enabled,
    credentialsGeneration: clawCredentialsGeneration(record),
  };
  // Compare against a baseline that carries the same defaulted credential
  // epoch, so records persisted before the field never diff on a no-op patch.
  const baseline = { ...record.desired, credentialsGeneration: clawCredentialsGeneration(record) };
  if (canonicalJson(desired) === canonicalJson(baseline)) {
    return record;
  }
  return {
    ...record,
    revision: nextRecordRevision(record),
    desired: {
      ...desired,
      generation: record.desired.generation + 1,
    },
    updatedAt: now.toISOString(),
  };
}

export function setClawEnabled(record: ClawRecord, enabled: boolean, now = new Date()): ClawRecord {
  if (record.desired.enabled === enabled) {
    return record;
  }
  return {
    ...record,
    revision: nextRecordRevision(record),
    desired: {
      ...record.desired,
      enabled,
      generation: record.desired.generation + 1,
    },
    updatedAt: now.toISOString(),
  };
}

// Records persisted before the credential-epoch field exist without it.
export function clawCredentialsGeneration(record: ClawRecord): number {
  const value = record.desired.credentialsGeneration;
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

export function rotateClawCredentials(record: ClawRecord, now = new Date()): ClawRecord {
  const credentialsGeneration = clawCredentialsGeneration(record) + 1;
  if (credentialsGeneration > 1_000_000) {
    throw new Error("credential rotation limit reached");
  }
  return {
    ...record,
    revision: nextRecordRevision(record),
    desired: {
      ...record.desired,
      credentialsGeneration,
      generation: record.desired.generation + 1,
    },
    updatedAt: now.toISOString(),
  };
}

function nextRecordRevision(record: ClawRecord): number {
  return Number.isSafeInteger(record.revision) && record.revision >= 0
    ? record.revision + 1
    : 1;
}

export function childPolicyHash(record: ClawRecord): string {
  const serialized = canonicalJson({
    model: record.desired.inference.model,
    fallbackModels: record.desired.inference.fallbackModels,
    router: record.desired.inference.router,
    slackEnabled: record.desired.channels.slack.enabled,
    access: record.desired.access,
    logLevel: record.desired.observability.logLevel,
    otel: record.desired.observability.otel,
    appliance: record.desired.deployment.appliance,
    credentialsGeneration: clawCredentialsGeneration(record),
  });
  return createHash("sha256").update(serialized).digest("hex");
}

export function standaloneBootstrapHash(record: ClawRecord): string {
  return standaloneBootstrapHashFor(
    record.desired.inference.model,
    record.desired.observability,
    record.desired.inference.router,
  );
}

export function standaloneBootstrapHashFor(
  model: string,
  observability: Pick<ObservabilityPolicy, "logLevel" | "otel">,
  router: InferenceRouter = { kind: "direct" },
): string {
  const serialized = canonicalJson({
    model,
    router,
    logLevel: observability.logLevel,
    otel: observability.otel,
  });
  return createHash("sha256").update(serialized).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function fleetSummary(records: ClawRecord[]): FleetSummary {
  return {
    total: records.filter((record) => record.observed.phase !== "deleted").length,
    ready: records.filter((record) => record.observed.phase === "ready").length,
    provisioning: records.filter((record) =>
      ["requested", "provisioning", "enrolling", "deleting"].includes(record.observed.phase),
    ).length,
    attention: records.filter((record) => record.observed.phase === "attention").length,
    disabled: records.filter((record) => record.observed.phase === "disabled").length,
    drifted: records.filter(
      (record) =>
        record.observed.phase !== "deleted" &&
        record.desired.generation !== record.observed.generation,
    ).length,
  };
}
