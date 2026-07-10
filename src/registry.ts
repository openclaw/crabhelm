import { randomUUID } from "node:crypto";
import {
  clawCredentialsGeneration,
  createClawRecord,
  fleetSummary,
  managedPolicyDiff,
  managedPolicyPatch,
  normalizeManagedPolicySpec,
  rotateClawCredentials,
  setClawEnabled,
  updateClawRecord,
} from "./domain.js";
import type { StateStore, StateTransaction } from "./state.js";
import type {
  AuditEvent,
  ClawRouterFleetPolicy,
  ClawObserved,
  ClawRecord,
  CreatePolicyInput,
  CreateClawInput,
  PolicyApplicationPreview,
  PolicyTemplate,
  UpdateClawInput,
} from "./types.js";

export type RegistryDeploymentTarget = {
  profile: string;
  region?: string;
};

export class RegistryWriteConflictError extends Error {
  readonly code = "REGISTRY_WRITE_CONFLICT" as const;

  constructor() {
    super("claw state changed during reconciliation");
    this.name = "RegistryWriteConflictError";
  }
}

export function isRegistryWriteConflict(error: unknown): boolean {
  return error instanceof RegistryWriteConflictError ||
    (error instanceof Error &&
      (error as Error & { code?: unknown }).code === "REGISTRY_WRITE_CONFLICT");
}

export class CrabhelmRegistry {
  readonly #claws: StateStore<ClawRecord>;
  readonly #events: StateStore<AuditEvent>;
  readonly #policies?: StateStore<PolicyTemplate>;
  readonly #deploymentTargets?: ReadonlyMap<string, RegistryDeploymentTarget>;
  readonly #defaultDeployment?: { target: string } & RegistryDeploymentTarget;
  readonly #clawRouter?: ClawRouterFleetPolicy;
  readonly #transaction?: StateTransaction;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    claws: StateStore<ClawRecord>,
    events: StateStore<AuditEvent>,
    options: {
      deploymentTargets?: Record<string, RegistryDeploymentTarget>;
      defaultDeployment?: { target: string } & RegistryDeploymentTarget;
      policies?: StateStore<PolicyTemplate>;
      transaction?: StateTransaction;
      clawRouter?: ClawRouterFleetPolicy;
    } = {},
  ) {
    this.#claws = claws;
    this.#events = events;
    this.#deploymentTargets = options.deploymentTargets
      ? new Map(Object.entries(options.deploymentTargets))
      : undefined;
    this.#defaultDeployment = options.defaultDeployment;
    this.#policies = options.policies;
    this.#transaction = options.transaction;
    this.#clawRouter = options.clawRouter;
  }

  async list(): Promise<ClawRecord[]> {
    await this.#tail;
    return (await this.#claws.entries())
      .map((entry) => normalizeRecord(entry.value))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ClawRecord> {
    await this.#tail;
    const record = await this.#claws.lookup(id);
    if (!record) {
      throw new Error("claw not found");
    }
    return normalizeRecord(record);
  }

  async snapshot() {
    const claws = await this.list();
    return {
      summary: fleetSummary(claws),
      claws,
      events: (await this.#events.entries())
        .map((entry) => entry.value)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 200),
      policies: await this.listPolicies(),
    };
  }

  async listPolicies(): Promise<PolicyTemplate[]> {
    await this.#tail;
    if (!this.#policies) return [];
    return (await this.#policies.entries())
      .map((entry) => entry.value)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createPolicy(input: CreatePolicyInput, actor: string): Promise<PolicyTemplate> {
    return this.#serialize(async () => {
      const policies = this.#requirePolicies();
      const name = requirePolicyText(input?.name, "policy name", 80);
      const description = input?.description === undefined
        ? ""
        : requirePolicyText(input.description, "policy description", 240, true);
      const duplicate = (await policies.entries()).some(
        (entry) => entry.value.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
      if (duplicate) throw new Error(`a policy named ${name} already exists`);
      const timestamp = new Date().toISOString();
      const policy: PolicyTemplate = {
        id: randomUUID(),
        name,
        description,
        versions: [{
          version: 1,
          createdAt: timestamp,
          createdBy: actor,
          spec: normalizeManagedPolicySpec(input.spec),
        }],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await policies.register(policy.id, policy);
      await this.#audit({
        actor,
        action: "policy.create",
        outcome: "succeeded",
        summary: `Created policy ${policy.name} v1`,
        details: { policyId: policy.id, version: 1 },
      });
      return policy;
    });
  }

  async addPolicyVersion(
    id: string,
    input: Pick<CreatePolicyInput, "description" | "spec">,
    actor: string,
  ): Promise<PolicyTemplate> {
    return this.#serialize(async () => {
      const policies = this.#requirePolicies();
      const current = await this.#requirePolicy(id);
      if (current.versions.length >= 100) throw new Error("policy version limit reached (100)");
      const version = current.versions.length + 1;
      const timestamp = new Date().toISOString();
      const spec = normalizeManagedPolicySpec(input.spec);
      const latest = current.versions.at(-1)!;
      if (canonicalJson(spec) === canonicalJson(latest.spec)) {
        throw new Error("new policy version must change at least one managed field");
      }
      const next: PolicyTemplate = {
        ...current,
        ...(input.description === undefined
          ? {}
          : { description: requirePolicyText(input.description, "policy description", 240, true) }),
        versions: [...current.versions, { version, createdAt: timestamp, createdBy: actor, spec }],
        updatedAt: timestamp,
      };
      await policies.register(id, next);
      await this.#audit({
        actor,
        action: "policy.version.create",
        outcome: "succeeded",
        summary: `Created policy ${next.name} v${version}`,
        details: { policyId: id, version },
      });
      return next;
    });
  }

  async previewPolicy(
    id: string,
    version: number,
    clawIds: string[],
  ): Promise<PolicyApplicationPreview> {
    await this.#tail;
    const policy = await this.#requirePolicy(id);
    const selected = requirePolicyVersion(policy, version);
    const ids = requireUniqueClawIds(clawIds);
    const targets = await Promise.all(ids.map(async (clawId) => {
      const claw = await this.#require(clawId);
      assertPolicyTargetMutable(claw);
      return {
        clawId,
        clawName: claw.desired.name,
        expectedGeneration: claw.desired.generation,
        changes: managedPolicyDiff(claw, selected.spec),
      };
    }));
    return { policyId: policy.id, policyName: policy.name, version, targets };
  }

  async applyPolicy(
    id: string,
    version: number,
    clawIds: string[],
    expectedGenerations: Record<string, number>,
    actor: string,
  ): Promise<{ policy: PolicyTemplate; updated: ClawRecord[]; unchanged: ClawRecord[] }> {
    return this.#serialize(async () => {
      const policy = await this.#requirePolicy(id);
      const selected = requirePolicyVersion(policy, version);
      const ids = requireUniqueClawIds(clawIds);
      const current = await Promise.all(ids.map((clawId) => this.#require(clawId)));
      for (const claw of current) {
        assertPolicyTargetMutable(claw);
        const expected = expectedGenerations[claw.id];
        if (!Number.isInteger(expected) || expected !== claw.desired.generation) {
          throw new Error(
            `policy preview is stale for ${claw.desired.name}: expected generation ${expected ?? "missing"}, current generation ${claw.desired.generation}`,
          );
        }
      }
      const updated: ClawRecord[] = [];
      const unchanged: ClawRecord[] = [];
      for (const claw of current) {
        const next = updateClawRecord(claw, managedPolicyPatch(policy.id, version, selected.spec));
        if (next === claw) {
          unchanged.push(claw);
          continue;
        }
        await this.#claws.register(claw.id, next);
        await this.#audit({
          clawId: claw.id,
          actor,
          action: "policy.apply",
          outcome: "requested",
          summary: `Applied ${policy.name} v${version} to ${claw.desired.name}`,
          generation: next.desired.generation,
          details: { policyId: policy.id, version },
        });
        updated.push(next);
      }
      return { policy, updated, unchanged };
    });
  }

  async create(input: CreateClawInput, actor: string): Promise<ClawRecord> {
    return this.#serialize(async () => {
      const next = createClawRecord(
        this.#withDefaultDeployment(input),
        new Date(),
        this.#clawRouter ? { clawRouter: this.#clawRouter } : {},
      );
      this.#assertDeployment(next.desired.deployment);
      const duplicate = (await this.#claws.entries()).some(
        (entry) => entry.value.desired.slug === next.desired.slug && entry.value.observed.phase !== "deleted",
      );
      if (duplicate) {
        throw new Error(`a claw with slug ${next.desired.slug} already exists`);
      }
      await this.#claws.register(next.id, next);
      await this.#audit({
        clawId: next.id,
        actor,
        action: "claw.create",
        outcome: "requested",
        summary: `Requested ${next.desired.name}`,
        generation: next.desired.generation,
      });
      return next;
    });
  }

  async update(id: string, patch: UpdateClawInput, actor: string): Promise<ClawRecord> {
    return this.#serialize(async () => {
      const current = await this.#require(id);
      if (
        current.observed.phase === "deleted" ||
        current.observed.phase === "deleting" ||
        current.observed.deletion
      ) {
        throw new Error("cannot update a deleting or deleted claw");
      }
      const next = updateClawRecord(current, patch);
      this.#assertDeployment(next.desired.deployment);
      if (next === current) return current;
      if (
        current.observed.lifecycle &&
        JSON.stringify(deploymentPlacement(next)) !== JSON.stringify(deploymentPlacement(current))
      ) {
        throw new Error("deployment placement is immutable after workspace allocation; replace the claw instead");
      }
      await this.#claws.register(id, next);
      await this.#audit({
        clawId: id,
        actor,
        action: "claw.update",
        outcome: "requested",
        summary: `Updated desired state for ${next.desired.name}`,
        generation: next.desired.generation,
      });
      return next;
    });
  }

  #withDefaultDeployment(input: CreateClawInput): CreateClawInput {
    if (!this.#defaultDeployment) return input;
    const target = input.deployment?.target ?? this.#defaultDeployment.target;
    const configured = this.#deploymentTargets?.get(target);
    return {
      ...input,
      deployment: {
        target,
        profile: input.deployment?.profile ?? configured?.profile ?? this.#defaultDeployment.profile,
        ...(input.deployment?.region ?? configured?.region ?? this.#defaultDeployment.region
          ? { region: input.deployment?.region ?? configured?.region ?? this.#defaultDeployment.region }
          : {}),
        ...(input.deployment?.appliance ? { appliance: input.deployment.appliance } : {}),
      },
    };
  }

  #assertDeployment(deployment: ClawRecord["desired"]["deployment"]): void {
    if (!this.#deploymentTargets) return;
    const configured = this.#deploymentTargets.get(deployment.target);
    if (!configured) throw new Error(`deployment target ${deployment.target} is not configured`);
    if (deployment.profile !== configured.profile) {
      throw new Error(`deployment profile for ${deployment.target} must be ${configured.profile}`);
    }
    if ((deployment.region ?? "") !== (configured.region ?? "")) {
      throw new Error(`deployment region for ${deployment.target} must be ${configured.region ?? "unset"}`);
    }
  }

  async setEnabled(id: string, enabled: boolean, actor: string): Promise<ClawRecord> {
    return this.#serialize(async () => {
      const current = await this.#require(id);
      if (
        current.observed.phase === "deleted" ||
        current.observed.phase === "deleting" ||
        current.observed.deletion
      ) {
        throw new Error("cannot change a deleting or deleted claw");
      }
      const next = setClawEnabled(current, enabled);
      if (next === current) return current;
      await this.#claws.register(id, next);
      await this.#audit({
        clawId: id,
        actor,
        action: enabled ? "claw.enable" : "claw.disable",
        outcome: "requested",
        summary: `${enabled ? "Enabled" : "Disabled"} ${next.desired.name}`,
        generation: next.desired.generation,
      });
      return next;
    });
  }

  async rotateCredentials(id: string, actor: string): Promise<ClawRecord> {
    return this.#serialize(async () => {
      const current = await this.#require(id);
      if (
        current.observed.phase === "deleted" ||
        current.observed.phase === "deleting" ||
        current.observed.deletion
      ) {
        throw new Error("cannot rotate credentials for a deleting or deleted claw");
      }
      const next = rotateClawCredentials(current);
      await this.#claws.register(id, next);
      await this.#audit({
        clawId: id,
        actor,
        action: "claw.rotate-credentials",
        outcome: "requested",
        summary: `Requested credential re-delivery for ${next.desired.name} (epoch ${clawCredentialsGeneration(next)})`,
        generation: next.desired.generation,
      });
      return next;
    });
  }

  async requestRemoval(id: string, actor: string, confirmation: string): Promise<ClawRecord> {
    return this.#serialize(async () => {
      const current = await this.#require(id);
      if (confirmation !== current.desired.name && confirmation !== current.desired.slug) {
        throw new Error("typed confirmation must match the claw name or slug");
      }
      if (current.observed.phase === "deleted") return current;
      if (current.observed.deletion) return current;
      const next: ClawRecord = {
        ...current,
        revision: current.revision + 1,
        desired: {
          ...current.desired,
          enabled: false,
          generation: current.desired.generation + 1,
        },
        observed: {
          ...current.observed,
          phase: "deleting",
          message: "Removal requested; disabling child ingress before release",
          deletion: {
            stage: "disable",
            requestedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date().toISOString(),
      };
      await this.#claws.register(id, next);
      await this.#audit({
        clawId: id,
        actor,
        action: "claw.remove",
        outcome: "requested",
        summary: `Requested removal of ${next.desired.name}`,
        generation: next.desired.generation,
      });
      return next;
    });
  }

  async writeObserved(
    id: string,
    observed: ClawObserved,
    audit?: Omit<AuditEvent, "id" | "at" | "clawId">,
    options: { expectedRevision?: number } = {},
  ): Promise<ClawRecord> {
    return this.#serialize(async () => {
      const current = await this.#require(id);
      if (
        options.expectedRevision !== undefined &&
        current.revision !== options.expectedRevision
      ) {
        throw new RegistryWriteConflictError();
      }
      const next = {
        ...current,
        revision: current.revision + 1,
        observed,
        updatedAt: new Date().toISOString(),
      };
      await this.#claws.register(id, next);
      if (audit) {
        await this.#audit({ clawId: id, ...audit });
      }
      return next;
    });
  }

  async #require(id: string): Promise<ClawRecord> {
    const record = await this.#claws.lookup(id);
    if (!record) {
      throw new Error("claw not found");
    }
    return normalizeRecord(record);
  }

  #requirePolicies(): StateStore<PolicyTemplate> {
    if (!this.#policies) throw new Error("policy storage is unavailable");
    return this.#policies;
  }

  async #requirePolicy(id: string): Promise<PolicyTemplate> {
    const policy = await this.#requirePolicies().lookup(id);
    if (!policy) throw new Error("policy not found");
    return policy;
  }

  async #audit(event: Omit<AuditEvent, "id" | "at">): Promise<void> {
    const value: AuditEvent = { id: randomUUID(), at: new Date().toISOString(), ...event };
    await this.#events.register(value.id, value);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const transactional = () => this.#transaction ? this.#transaction(operation) : operation();
    const next = this.#tail.then(transactional, transactional);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

function normalizeRecord(record: ClawRecord): ClawRecord {
  const legacyDesired = record.desired as ClawRecord["desired"] & {
    inference: ClawRecord["desired"]["inference"] & {
      router?: ClawRecord["desired"]["inference"]["router"];
    };
    observability?: Partial<ClawRecord["desired"]["observability"]> & {
      otel?: ClawRecord["desired"]["observability"]["otel"];
    };
  };
  const observability = legacyDesired.observability;
  const revision = Number.isSafeInteger(record.revision) && record.revision >= 0
    ? record.revision
    : 0;
  if (observability?.otel && legacyDesired.inference.router && revision === record.revision) return record;
  return {
    ...record,
    revision,
    desired: {
      ...record.desired,
      inference: {
        ...record.desired.inference,
        router: legacyDesired.inference.router ?? { kind: "direct" },
      },
      observability: {
        logLevel: observability?.logLevel ?? "info",
        retentionDays: observability?.retentionDays ?? 30,
        metadataOnly: true,
        otel: observability?.otel ?? {
          enabled: false,
          serviceName: `crabhelm-${record.desired.slug}`,
          traces: true,
          metrics: true,
          logs: false,
          sampleRate: 0.1,
          flushIntervalMs: 60_000,
        },
      },
    },
  };
}

function deploymentPlacement(record: ClawRecord): Pick<ClawRecord["desired"]["deployment"], "target" | "profile" | "region"> {
  const { target, profile, region } = record.desired.deployment;
  return { target, profile, ...(region ? { region } : {}) };
}

function requirePolicyText(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const clean = value.trim();
  if ((!allowEmpty && !clean) || clean.length > max) {
    throw new Error(`${label} must be ${allowEmpty ? `at most ${max}` : `between 1 and ${max}`} characters`);
  }
  return clean;
}

function requirePolicyVersion(policy: PolicyTemplate, version: number) {
  if (!Number.isInteger(version) || version < 1) throw new Error("policy version must be a positive integer");
  const selected = policy.versions.find((item) => item.version === version);
  if (!selected) throw new Error(`policy ${policy.name} has no version ${version}`);
  return selected;
}

function requireUniqueClawIds(value: string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error("policy targets must contain between 1 and 100 claw ids");
  }
  const ids = value.map((id) => typeof id === "string" ? id.trim() : "");
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("policy targets must contain unique non-empty claw ids");
  }
  return ids;
}

function assertPolicyTargetMutable(claw: ClawRecord): void {
  if (claw.observed.phase === "deleted" || claw.observed.phase === "deleting" || claw.observed.deletion) {
    throw new Error(`cannot apply policy to deleting or deleted claw ${claw.desired.name}`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
