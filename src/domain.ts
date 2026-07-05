import { createHash, randomUUID } from "node:crypto";
import type {
  AccessPolicy,
  ClawRecord,
  CreateClawInput,
  DeploymentSpec,
  FleetSummary,
  InferencePolicy,
  ManagedPolicySpec,
  ObservabilityPolicy,
  OwnerRef,
  PolicyFieldChange,
  SlackPolicy,
  UpdateClawInput,
} from "./types.js";

const subjectPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/+\-]{0,199}$/;
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const modelPattern = /^[a-z0-9][a-z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.:\-]{0,199}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

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

function normalizeModels(input?: Partial<InferencePolicy>): InferencePolicy {
  const model = requireText(input?.model ?? "openai/gpt-5.5", "inference model", 220);
  const fallbackModels = [...new Set(input?.fallbackModels ?? [])];
  for (const value of [model, ...fallbackModels]) {
    if (!modelPattern.test(value)) {
      throw new Error(`model must use provider/model form: ${value}`);
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
  return {
    provider: modelProvider,
    model,
    fallbackModels,
    ...(input?.authRef ? { authRef: requireText(input.authRef, "inference auth ref", 240) } : {}),
    ...(monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd } : {}),
  };
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
  input?: Partial<Omit<ObservabilityPolicy, "metadataOnly">>,
): ObservabilityPolicy {
  const logLevel = input?.logLevel ?? "info";
  if (!(["error", "warn", "info", "debug"] as const).includes(logLevel)) {
    throw new Error("log level must be error, warn, info, or debug");
  }
  const retentionDays = input?.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("retention must be between 1 and 365 days");
  }
  return { logLevel, retentionDays, metadataOnly: true };
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
  const inference = normalizeModels(input?.inference);
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

export function createClawRecord(input: CreateClawInput, now = new Date()): ClawRecord {
  const name = requireText(input.name, "name", 80);
  const slug = input.slug ? requireText(input.slug, "slug", 63) : slugify(name);
  if (!slugPattern.test(slug)) {
    throw new Error("slug must be a lowercase DNS label");
  }
  const profile = requireText(input.deployment?.profile ?? "openclaw-core", "profile", 63);
  if (!slugPattern.test(profile)) {
    throw new Error("deployment profile must be a lowercase DNS label");
  }
  const timestamp = now.toISOString();
  return {
    id: randomUUID(),
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
        ...(normalizeAppliance(input.deployment) ? { appliance: normalizeAppliance(input.deployment) } : {}),
      },
      inference: normalizeModels(input.inference),
      channels: { slack: normalizeSlack(input.slack, slug) },
      access: normalizeAccess(input.access),
      observability: normalizeObservability(input.observability),
      enabled: true,
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
      observability: { ...record.desired.observability, ...patch.observability },
    },
    now,
  );
  const desired = {
    ...merged.desired,
    generation: record.desired.generation,
    enabled: record.desired.enabled,
  };
  if (canonicalJson(desired) === canonicalJson(record.desired)) {
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

function nextRecordRevision(record: ClawRecord): number {
  return Number.isSafeInteger(record.revision) && record.revision >= 0
    ? record.revision + 1
    : 1;
}

export function childPolicyHash(record: ClawRecord): string {
  const serialized = canonicalJson({
    model: record.desired.inference.model,
    fallbackModels: record.desired.inference.fallbackModels,
    slackEnabled: record.desired.channels.slack.enabled,
    access: record.desired.access,
    logLevel: record.desired.observability.logLevel,
    appliance: record.desired.deployment.appliance,
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
