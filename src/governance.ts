import { createHash, randomUUID } from "node:crypto";
import { slugify } from "./domain.js";
import type {
  ActorMode,
  ActorPolicy,
  CapabilityDefinition,
  CreatePrincipalInput,
  CreatePersonaInput,
  CreateSkillInput,
  ManagedAgentSpec,
  OAuthConnectionRecord,
  PersonaBinding,
  PersonaInstructions,
  PersonaRecord,
  PrincipalRecord,
  PublishedContext,
  SkillFile,
  SkillRecord,
  UpdatePersonaInput,
} from "./governance-types.js";

const subjectPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/+\-]{0,199}$/u;
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const skillPathPattern = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const capabilityIdPattern = /^[a-z][a-z0-9.-]{2,119}$/u;
const departmentPattern = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/u;

export const SYSTEM_OPERATOR_PRINCIPAL_ID = "principal:operator";

export const DEFAULT_CAPABILITIES: readonly CapabilityDefinition[] = Object.freeze([
  {
    id: "github.repository.read",
    provider: "github",
    action: "repository.read",
    label: "Read GitHub repository metadata",
    description: "Read bounded metadata for one explicitly named GitHub repository.",
    risk: "read",
    confirmation: "never",
    allowedActorModes: ["invoker", "service", "invoker-with-service-fallback"],
    requiredScopes: ["repo:read"],
  },
  {
    id: "github.issue.read",
    provider: "github",
    action: "issue.read",
    label: "Read GitHub issue or pull request",
    description: "Read one issue or pull request from one explicitly named repository.",
    risk: "read",
    confirmation: "never",
    allowedActorModes: ["invoker", "service", "invoker-with-service-fallback"],
    requiredScopes: ["repo:read"],
  },
  {
    id: "github.issue.comment",
    provider: "github",
    action: "issue.comment",
    label: "Comment on GitHub issue or pull request",
    description: "Post one bounded comment after requester confirmation.",
    risk: "external",
    confirmation: "always",
    allowedActorModes: ["invoker", "service", "invoker-with-service-fallback"],
    requiredScopes: ["repo:write"],
  },
]);

export function createSystemOperator(now = new Date()): PrincipalRecord {
  const timestamp = now.toISOString();
  return {
    id: SYSTEM_OPERATOR_PRINCIPAL_ID,
    revision: 1,
    subject: "operator:cloudflare",
    label: "Crabhelm operator",
    kind: "human",
    source: "operator",
    roles: ["administrator", "member"],
    departments: ["platform"],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createPrincipalRecord(
  input: CreatePrincipalInput,
  now = new Date(),
): PrincipalRecord {
  const subject = text(input?.subject, "principal subject", 200);
  if (!subjectPattern.test(subject)) throw new Error("principal subject contains unsupported characters");
  const source = input?.source ?? "manual";
  if (!(source === "operator" || source === "github" || source === "slack" || source === "email" || source === "oidc" || source === "manual")) {
    throw new Error("principal source is invalid");
  }
  const kind = input?.kind ?? "human";
  if (kind !== "human" && kind !== "service") throw new Error("principal kind must be human or service");
  const roles = unique(input?.roles ?? ["member"], "principal roles", 2);
  if (!roles.length || roles.some((role) => role !== "administrator" && role !== "member")) {
    throw new Error("principal roles must contain member or administrator");
  }
  const timestamp = now.toISOString();
  return {
    id: randomUUID(),
    revision: 1,
    subject,
    label: text(input.label, "principal label", 120),
    kind,
    source,
    roles,
    departments: departments(input?.departments),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createPersonaRecord(
  input: CreatePersonaInput,
  now = new Date(),
): PersonaRecord {
  const name = text(input?.name, "persona name", 80);
  const slug = input?.slug ? text(input.slug, "persona slug", 63) : slugify(name);
  if (!slugPattern.test(slug)) throw new Error("persona slug must be a lowercase DNS label");
  const kind = input?.kind;
  if (kind !== "personal" && kind !== "shared" && kind !== "profile") {
    throw new Error("persona kind must be personal, shared, or profile");
  }
  const actorPolicy = normalizeActorPolicy(kind, input.actorPolicy);
  const timestamp = now.toISOString();
  return {
    id: randomUUID(),
    revision: 1,
    name,
    slug,
    kind,
    ownerPrincipalId: text(input.ownerPrincipalId, "persona owner", 200),
    clawId: text(input.clawId, "persona claw", 200),
    actorPolicy,
    bindings: normalizeBindings(input.bindings),
    capabilityIds: capabilityIds(input.capabilityIds),
    skillIds: unique(input.skillIds ?? [], "persona skill ids", 100),
    instructions: normalizeInstructions(input.instructions),
    publishedContext: normalizePublishedContext(input.publishedContext),
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updatePersonaRecord(
  record: PersonaRecord,
  input: UpdatePersonaInput,
  now = new Date(),
): PersonaRecord {
  const rebuilt = createPersonaRecord({
    name: input.name ?? record.name,
    slug: input.slug ?? record.slug,
    kind: input.kind ?? record.kind,
    ownerPrincipalId: input.ownerPrincipalId ?? record.ownerPrincipalId,
    clawId: record.clawId,
    actorPolicy: { ...record.actorPolicy, ...input.actorPolicy },
    bindings: input.bindings ?? record.bindings,
    capabilityIds: input.capabilityIds ?? record.capabilityIds,
    skillIds: input.skillIds ?? record.skillIds,
    instructions: { ...record.instructions, ...input.instructions },
    publishedContext: input.publishedContext ?? record.publishedContext,
  }, now);
  const desired = { ...rebuilt, id: record.id, createdAt: record.createdAt, enabled: input.enabled ?? record.enabled };
  const comparable = { ...desired, revision: record.revision, updatedAt: record.updatedAt };
  if (canonicalJson(comparable) === canonicalJson(record)) return record;
  return { ...desired, revision: record.revision + 1, updatedAt: now.toISOString() };
}

export function createSkillRecord(
  input: CreateSkillInput,
  createdBy: string,
  now = new Date(),
): SkillRecord {
  const name = text(input?.name, "skill name", 80);
  const slug = input?.slug ? text(input.slug, "skill slug", 63) : slugify(name);
  if (!slugPattern.test(slug)) throw new Error("skill slug must be a lowercase DNS label");
  if (!Array.isArray(input?.files) || input.files.length < 1 || input.files.length > 50) {
    throw new Error("skill files must contain between 1 and 50 files");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files: SkillFile[] = input.files.map((file) => {
    const path = text(file?.path, "skill file path", 240);
    if (!skillPathPattern.test(path) || path.startsWith(".") || path.includes("..")) {
      throw new Error(`skill file path is unsafe: ${path}`);
    }
    if (seen.has(path)) throw new Error(`skill file path is duplicated: ${path}`);
    seen.add(path);
    const content = typeof file?.content === "string" ? file.content : "";
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > 64 * 1024) throw new Error(`skill file exceeds 64 KiB: ${path}`);
    totalBytes += bytes;
    return { path, content, sha256: sha256(content) };
  });
  if (totalBytes > 256 * 1024) throw new Error("skill files exceed 256 KiB total");
  if (!files.some((file) => file.path === "SKILL.md")) throw new Error("skill requires SKILL.md");
  const timestamp = now.toISOString();
  return {
    id: randomUUID(),
    revision: 1,
    name,
    slug,
    description: optionalText(input.description, "skill description", 240),
    version: 1,
    status: "draft",
    departments: departments(input.departments),
    files,
    digest: sha256(canonicalJson(files)),
    createdBy: text(createdBy, "skill creator", 200),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function approveSkillRecord(
  record: SkillRecord,
  approvedBy: string,
  now = new Date(),
): SkillRecord {
  if (record.status === "revoked") throw new Error("revoked skill cannot be approved");
  if (record.status === "approved") return record;
  return {
    ...record,
    revision: record.revision + 1,
    status: "approved",
    approvedBy: text(approvedBy, "skill approver", 200),
    updatedAt: now.toISOString(),
  };
}

export function capabilityById(id: string): CapabilityDefinition {
  const capability = DEFAULT_CAPABILITIES.find((item) => item.id === id);
  if (!capability) throw new Error(`capability is not configured: ${id}`);
  return capability;
}

export function mayInvokePersona(persona: PersonaRecord, requesterId: string, isAdministrator: boolean): boolean {
  return isAdministrator || persona.ownerPrincipalId === requesterId || persona.kind === "profile";
}

export function resolveInvocationActor(input: {
  requester: PrincipalRecord;
  persona: PersonaRecord;
  capability: CapabilityDefinition;
  principals: PrincipalRecord[];
  connections: OAuthConnectionRecord[];
}): { actor: PrincipalRecord; connection: OAuthConnectionRecord; actorMode: ActorMode; fallbackUsed: boolean } {
  const { requester, persona, capability, principals, connections } = input;
  if (!persona.enabled) throw new Error("persona is disabled");
  if (!persona.capabilityIds.includes(capability.id)) throw new Error("persona is not allowed to use this capability");
  if (!capability.allowedActorModes.includes(persona.actorPolicy.mode)) {
    throw new Error("persona actor mode is not allowed for this capability");
  }
  if (persona.kind === "profile" && persona.actorPolicy.mode !== "invoker") {
    throw new Error("profile assistants must act as the requester");
  }
  const requesterConnection = findConnection(connections, requester.id, capability);
  if (persona.actorPolicy.mode === "invoker") {
    if (!requesterConnection) throw new Error("requester has no compatible OAuth connection");
    return { actor: requester, connection: requesterConnection, actorMode: "invoker", fallbackUsed: false };
  }
  const service = principals.find((principal) => principal.id === persona.actorPolicy.servicePrincipalId);
  if (!service || service.kind !== "service") throw new Error("persona service actor is unavailable");
  const serviceConnection = findConnection(connections, service.id, capability);
  if (persona.actorPolicy.mode === "service") {
    if (!serviceConnection) throw new Error("service actor has no compatible OAuth connection");
    return { actor: service, connection: serviceConnection, actorMode: "service", fallbackUsed: false };
  }
  if (requesterConnection) {
    return {
      actor: requester,
      connection: requesterConnection,
      actorMode: "invoker-with-service-fallback",
      fallbackUsed: false,
    };
  }
  if (!serviceConnection) throw new Error("neither requester nor service actor has a compatible OAuth connection");
  return {
    actor: service,
    connection: serviceConnection,
    actorMode: "invoker-with-service-fallback",
    fallbackUsed: true,
  };
}

export function buildManagedAgentSpec(input: {
  persona: PersonaRecord;
  owner: PrincipalRecord;
  skills: SkillRecord[];
  now?: Date;
}): ManagedAgentSpec {
  const selected = input.persona.skillIds.map((id) => {
    const skill = input.skills.find((item) => item.id === id);
    if (!skill || skill.status !== "approved") throw new Error(`persona skill is not approved: ${id}`);
    if (
      skill.departments.length &&
      !skill.departments.some((department) => input.owner.departments.includes(department))
    ) {
      throw new Error(`persona owner is not eligible for skill ${skill.name}`);
    }
    return {
      id: skill.id,
      name: skill.name,
      slug: skill.slug,
      version: skill.version,
      digest: skill.digest,
      files: skill.files,
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    clawId: input.persona.clawId,
    persona: {
      id: input.persona.id,
      name: input.persona.name,
      slug: input.persona.slug,
      kind: input.persona.kind,
      ownerPrincipalId: input.persona.ownerPrincipalId,
      actorPolicy: input.persona.actorPolicy,
    },
    policyRevision: input.persona.revision,
    capabilityIds: input.persona.capabilityIds,
    instructions: input.persona.instructions,
    publishedContext: input.persona.publishedContext,
    skills: selected,
    readOnly: true,
  };
}

export function invocationArgumentsDigest(input: {
  capabilityId: string;
  target: string;
  arguments: Record<string, string | number | boolean | null>;
}): string {
  const capabilityId = text(input.capabilityId, "capability id", 120);
  if (!capabilityIdPattern.test(capabilityId)) throw new Error("capability id is invalid");
  const target = normalizeGithubTarget(input.target);
  const args = normalizeInvocationArguments(input.arguments);
  return sha256(canonicalJson({ capabilityId, target, arguments: args }));
}

export function normalizeGithubTarget(value: unknown): string {
  const target = text(value, "GitHub target", 220);
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(target)) {
    throw new Error("GitHub target must use owner/repository form");
  }
  return target;
}

export function normalizeInvocationArguments(
  value: unknown,
): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool arguments must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw new Error("tool arguments exceed 20 fields");
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(key)) throw new Error(`tool argument name is invalid: ${key}`);
    if (!(item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      throw new Error(`tool argument must be scalar: ${key}`);
    }
    if (typeof item === "string" && Buffer.byteLength(item, "utf8") > 16 * 1024) {
      throw new Error(`tool argument exceeds 16 KiB: ${key}`);
    }
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error(`tool argument number is invalid: ${key}`);
    normalized[key] = item;
  }
  return normalized;
}

function normalizeActorPolicy(kind: PersonaRecord["kind"], input?: Partial<ActorPolicy>): ActorPolicy {
  const mode = input?.mode ?? "invoker";
  if (!(mode === "invoker" || mode === "service" || mode === "invoker-with-service-fallback")) {
    throw new Error("persona actor mode is invalid");
  }
  if (kind === "profile" && mode !== "invoker") throw new Error("profile assistants must use invoker actor mode");
  if (mode !== "invoker") {
    return { mode, servicePrincipalId: text(input?.servicePrincipalId, "service principal", 200) };
  }
  return { mode };
}

function normalizeBindings(input?: PersonaBinding[]): PersonaBinding[] {
  if (!input) return [];
  if (!Array.isArray(input) || input.length > 50) throw new Error("persona bindings exceed 50 entries");
  return input.map((binding) => {
    if (!(binding?.surface === "slack" || binding?.surface === "web" || binding?.surface === "api")) {
      throw new Error("persona binding surface is invalid");
    }
    if (binding.surface === "slack" && (!binding.workspaceId || !binding.channelId)) {
      throw new Error("Slack persona binding requires workspace and channel ids");
    }
    return {
      surface: binding.surface,
      ...(binding.workspaceId ? { workspaceId: text(binding.workspaceId, "binding workspace", 100) } : {}),
      ...(binding.channelId ? { channelId: text(binding.channelId, "binding channel", 100) } : {}),
    };
  });
}

function normalizeInstructions(input?: Partial<PersonaInstructions>): PersonaInstructions {
  return {
    identity: optionalText(input?.identity, "IDENTITY.md", 16 * 1024),
    soul: optionalText(input?.soul, "SOUL.md", 16 * 1024),
    agents: optionalText(input?.agents, "AGENTS.md", 32 * 1024),
  };
}

function normalizePublishedContext(input?: PublishedContext[]): PublishedContext[] {
  if (!input) return [];
  if (!Array.isArray(input) || input.length > 50) throw new Error("published context exceeds 50 entries");
  return input.map((entry) => {
    const url = entry?.url ? text(entry.url, "published context URL", 500) : undefined;
    if (url && !/^https:\/\//u.test(url)) throw new Error("published context URL must use HTTPS");
    return {
      label: text(entry?.label, "published context label", 120),
      value: text(entry?.value, "published context value", 2_000),
      ...(url ? { url } : {}),
    };
  });
}

function findConnection(
  connections: OAuthConnectionRecord[],
  principalId: string,
  capability: CapabilityDefinition,
): OAuthConnectionRecord | undefined {
  return connections.find((connection) =>
    connection.status === "active" &&
    connection.principalId === principalId &&
    connection.provider === capability.provider &&
    capability.requiredScopes.every((scope) => connection.scopes.includes(scope))
  );
}

function capabilityIds(values?: string[]): string[] {
  const ids = unique(values ?? [], "persona capability ids", 100);
  for (const id of ids) capabilityById(id);
  return ids;
}

function departments(values?: string[]): string[] {
  const items = unique(values ?? [], "departments", 50);
  if (items.some((value) => !departmentPattern.test(value))) throw new Error("department name is invalid");
  return items;
}

function unique<T extends string>(values: T[], label: string, max: number): T[] {
  if (!Array.isArray(values) || values.length > max) throw new Error(`${label} exceed ${max} entries`);
  const clean = values.map((value) => text(value, label, 240) as T);
  if (new Set(clean).size !== clean.length) throw new Error(`${label} must be unique`);
  return clean;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const clean = value.trim();
  if (!clean || Buffer.byteLength(clean, "utf8") > max) {
    throw new Error(`${label} must be between 1 and ${max} bytes`);
  }
  return clean;
}

function optionalText(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > max) {
    throw new Error(`${label} must be at most ${max} bytes`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
