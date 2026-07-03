import { randomUUID } from "node:crypto";
import {
  approveSkillRecord,
  buildManagedAgentSpec,
  createPersonaRecord,
  createPrincipalRecord,
  createSkillRecord,
  createSystemOperator,
  DEFAULT_CAPABILITIES,
  SYSTEM_OPERATOR_PRINCIPAL_ID,
  updatePersonaRecord,
} from "./governance.js";
import type {
  ConfirmationRecord,
  CreateOAuthConnectionInput,
  CreatePersonaInput,
  CreatePrincipalInput,
  CreateSkillInput,
  GovernanceAuditEvent,
  GovernanceSnapshot,
  InvocationRecord,
  ManagedAgentSpec,
  OAuthConnectionRecord,
  OAuthStateRecord,
  PersonaRecord,
  PrincipalRecord,
  SkillRecord,
  UpdatePersonaInput,
} from "./governance-types.js";
import type { StateStore, StateTransaction } from "./state.js";
import type { ClawRecord } from "./types.js";

type Stores = {
  principals: StateStore<PrincipalRecord>;
  personas: StateStore<PersonaRecord>;
  skills: StateStore<SkillRecord>;
  connections: StateStore<OAuthConnectionRecord>;
  oauthStates: StateStore<OAuthStateRecord>;
  confirmations: StateStore<ConfirmationRecord>;
  invocations: StateStore<InvocationRecord>;
  events: StateStore<GovernanceAuditEvent>;
  transaction?: StateTransaction;
};

export class GovernanceRegistry {
  readonly #stores: Stores;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(stores: Stores) {
    this.#stores = stores;
  }

  async snapshot(): Promise<GovernanceSnapshot> {
    await this.#tail;
    await this.ensureSystem();
    return {
      principals: await values(this.#stores.principals, (a, b) => a.label.localeCompare(b.label)),
      personas: await values(this.#stores.personas, (a, b) => a.name.localeCompare(b.name)),
      capabilities: [...DEFAULT_CAPABILITIES],
      skills: await values(this.#stores.skills, (a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      connections: (await values(this.#stores.connections, (a, b) => b.updatedAt.localeCompare(a.updatedAt))).map((connection) => ({ ...connection, vaultKey: "redacted" })),
      confirmations: (await values(this.#stores.confirmations, (a, b) => b.createdAt.localeCompare(a.createdAt))).slice(0, 200),
      invocations: (await values(this.#stores.invocations, (a, b) => b.issuedAt.localeCompare(a.issuedAt))).slice(0, 200),
      governanceEvents: (await values(this.#stores.events, (a, b) => b.at.localeCompare(a.at))).slice(0, 300),
    };
  }

  async ensureSystem(): Promise<PrincipalRecord> {
    const existing = await this.#stores.principals.lookup(SYSTEM_OPERATOR_PRINCIPAL_ID);
    if (existing) return existing;
    const operator = createSystemOperator();
    await this.#stores.principals.register(operator.id, operator);
    return operator;
  }

  async ensurePersonaForClaw(claw: ClawRecord): Promise<PersonaRecord> {
    return this.#serialize(async () => {
      await this.ensureSystem();
      const principals = await values(this.#stores.principals);
      let owner = principals.find((principal) => principal.subject === claw.desired.owner.subject);
      if (!owner) {
        owner = createPrincipalRecord({
          subject: claw.desired.owner.subject,
          label: claw.desired.owner.label,
          source: claw.desired.owner.source,
        });
        await this.#stores.principals.register(owner.id, owner);
      }
      const existing = (await values(this.#stores.personas)).find((persona) => persona.clawId === claw.id);
      if (existing) return existing;
      const persona = createPersonaRecord({
        name: claw.desired.name,
        slug: claw.desired.slug,
        kind: "personal",
        ownerPrincipalId: owner.id,
        clawId: claw.id,
        capabilityIds: DEFAULT_CAPABILITIES.map((capability) => capability.id),
        instructions: {
          identity: `# Identity\n\nYou are ${claw.desired.name}, an OpenClaw teammate managed by Crabhelm.`,
          soul: "# Operating principles\n\nRespect requester authority, least privilege, confirmation, and attribution.",
          agents: "# Managed runtime\n\nUse only governed capabilities. Never request, store, or expose durable credentials.",
        },
      });
      await this.#stores.personas.register(persona.id, persona);
      await this.audit({
        clawId: claw.id,
        requesterId: SYSTEM_OPERATOR_PRINCIPAL_ID,
        personaId: persona.id,
        action: "persona.bootstrap",
        outcome: "succeeded",
        summary: `Created personal persona for ${claw.desired.name}`,
      });
      return persona;
    });
  }

  async createPrincipal(input: CreatePrincipalInput, actorId: string): Promise<PrincipalRecord> {
    return this.#serialize(async () => {
      const next = createPrincipalRecord(input);
      const duplicate = (await values(this.#stores.principals)).some((item) => item.subject === next.subject);
      if (duplicate) throw new Error("principal subject already exists");
      await this.#stores.principals.register(next.id, next);
      await this.audit({ requesterId: actorId, actorId, action: "principal.create", outcome: "succeeded", summary: `Created principal ${next.label}` });
      return next;
    });
  }

  async ensureExternalPrincipal(input: CreatePrincipalInput): Promise<PrincipalRecord> {
    return this.#serialize(async () => {
      const candidate = createPrincipalRecord(input);
      const current = (await values(this.#stores.principals)).find((item) => item.subject === candidate.subject);
      if (!current) {
        await this.#stores.principals.register(candidate.id, candidate);
        await this.audit({ requesterId: candidate.id, actorId: candidate.id, action: "principal.login", outcome: "succeeded", summary: `Created ${candidate.source} principal ${candidate.label}` });
        return candidate;
      }
      const preserveOidcAuthority = current.source === "oidc" && candidate.source !== "oidc";
      const next = {
        ...current,
        revision: current.revision + 1,
        label: preserveOidcAuthority ? current.label : candidate.label,
        source: preserveOidcAuthority ? current.source : candidate.source,
        roles: preserveOidcAuthority ? current.roles : candidate.roles,
        departments: preserveOidcAuthority ? current.departments : candidate.departments,
        updatedAt: new Date().toISOString(),
      };
      await this.#stores.principals.register(current.id, next);
      return next;
    });
  }

  async principalBySubject(subject: string): Promise<PrincipalRecord | undefined> {
    return (await values(this.#stores.principals)).find((item) => item.subject === subject);
  }

  async createPersona(input: CreatePersonaInput, actorId: string): Promise<PersonaRecord> {
    return this.#serialize(async () => {
      await this.requirePrincipal(input.ownerPrincipalId);
      const persona = createPersonaRecord(input);
      if ((await values(this.#stores.personas)).some((item) => item.slug === persona.slug)) {
        throw new Error("persona slug already exists");
      }
      await this.#validatePersona(persona);
      await this.#stores.personas.register(persona.id, persona);
      await this.audit({ clawId: persona.clawId, requesterId: actorId, personaId: persona.id, action: "persona.create", outcome: "succeeded", summary: `Created persona ${persona.name}` });
      return persona;
    });
  }

  async updatePersona(id: string, input: UpdatePersonaInput, actorId: string): Promise<PersonaRecord> {
    return this.#serialize(async () => {
      const current = await this.requirePersona(id);
      const next = updatePersonaRecord(current, input);
      await this.requirePrincipal(next.ownerPrincipalId);
      await this.#validatePersona(next);
      await this.#stores.personas.register(id, next);
      await this.audit({ clawId: next.clawId, requesterId: actorId, personaId: id, action: "persona.update", outcome: "succeeded", summary: `Updated persona ${next.name}` });
      return next;
    });
  }

  async createSkill(input: CreateSkillInput, actorId: string): Promise<SkillRecord> {
    return this.#serialize(async () => {
      const skill = createSkillRecord(input, actorId);
      if ((await values(this.#stores.skills)).some((item) => item.slug === skill.slug)) throw new Error("skill slug already exists");
      await this.#stores.skills.register(skill.id, skill);
      await this.audit({ requesterId: actorId, actorId, action: "skill.create", outcome: "succeeded", summary: `Created draft skill ${skill.name}` });
      return skill;
    });
  }

  async approveSkill(id: string, actorId: string): Promise<SkillRecord> {
    return this.#serialize(async () => {
      const current = await this.#stores.skills.lookup(id);
      if (!current) throw new Error("skill not found");
      const skill = approveSkillRecord(current, actorId);
      await this.#stores.skills.register(id, skill);
      await this.audit({ requesterId: actorId, actorId, action: "skill.approve", outcome: "succeeded", summary: `Approved skill ${skill.name}` });
      return skill;
    });
  }

  async registerConnection(input: CreateOAuthConnectionInput, vaultKey: string, actorId: string, id = randomUUID()): Promise<OAuthConnectionRecord> {
    return this.#serialize(async () => {
      await this.requirePrincipal(input.principalId);
      const now = new Date().toISOString();
      const record: OAuthConnectionRecord = {
        id, revision: 1, principalId: input.principalId, provider: input.provider,
        label: requireText(input.label, "connection label", 120),
        scopes: unique(input.scopes, "connection scopes", 30), vaultKey, status: "active", createdAt: now, updatedAt: now,
      };
      await this.#stores.connections.register(record.id, record);
      await this.audit({ requesterId: actorId, actorId, action: "connection.create", outcome: "succeeded", summary: `Connected ${record.label}` });
      return record;
    });
  }

  async revokeConnection(id: string, actorId: string): Promise<OAuthConnectionRecord> {
    return this.#serialize(async () => {
      const current = await this.requireConnection(id);
      const next = { ...current, revision: current.revision + 1, status: "revoked" as const, updatedAt: new Date().toISOString() };
      await this.#stores.connections.register(id, next);
      await this.audit({ requesterId: actorId, actorId, action: "connection.revoke", outcome: "succeeded", summary: `Revoked ${next.label}` });
      return next;
    });
  }

  async createOAuthState(principalId: string): Promise<OAuthStateRecord> {
    await this.requirePrincipal(principalId);
    const now = new Date();
    const state: OAuthStateRecord = {
      id: randomUUID(),
      principalId,
      provider: "github",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    };
    await this.#stores.oauthStates.register(state.id, state);
    return state;
  }

  async consumeOAuthState(id: string, principalId: string): Promise<OAuthStateRecord> {
    return this.#serialize(async () => {
      const state = await this.#stores.oauthStates.lookup(id);
      if (!state || state.principalId !== principalId || Date.parse(state.expiresAt) <= Date.now()) throw new Error("OAuth state is invalid or expired");
      await this.#stores.oauthStates.delete(id);
      return state;
    });
  }

  async createConfirmation(input: Omit<ConfirmationRecord, "id" | "status" | "createdAt">): Promise<ConfirmationRecord> {
    const confirmation: ConfirmationRecord = { ...input, id: randomUUID(), status: "pending", createdAt: new Date().toISOString() };
    await this.#stores.confirmations.register(confirmation.id, confirmation);
    return confirmation;
  }

  async decideConfirmation(id: string, requesterId: string, approve: boolean): Promise<ConfirmationRecord> {
    return this.#serialize(async () => {
      const current = await this.requireConfirmation(id);
      if (current.requesterId !== requesterId) throw new Error("only the requester may decide confirmation");
      if (current.status !== "pending") throw new Error("confirmation is no longer pending");
      if (Date.parse(current.expiresAt) <= Date.now()) {
        const expired = { ...current, status: "expired" as const, decidedAt: new Date().toISOString() };
        await this.#stores.confirmations.register(id, expired);
        throw new Error("confirmation expired");
      }
      const next = { ...current, status: approve ? "approved" as const : "denied" as const, decidedAt: new Date().toISOString() };
      await this.#stores.confirmations.register(id, next);
      await this.audit({ requesterId, personaId: next.personaId, actorId: next.actorId, capabilityId: next.capabilityId, target: next.target, confirmationId: id, action: "confirmation.decide", outcome: approve ? "succeeded" : "denied", summary: approve ? next.summary : `Denied: ${next.summary}` });
      return next;
    });
  }

  async useConfirmation(id: string, expected: Pick<ConfirmationRecord, "requesterId" | "personaId" | "actorId" | "capabilityId" | "target" | "argumentsDigest">): Promise<ConfirmationRecord> {
    return this.#serialize(async () => {
      const current = await this.requireConfirmation(id);
      if (current.status !== "approved" || Date.parse(current.expiresAt) <= Date.now()) throw new Error("approved confirmation is required");
      for (const key of ["requesterId", "personaId", "actorId", "capabilityId", "target", "argumentsDigest"] as const) {
        if (current[key] !== expected[key]) throw new Error("confirmation does not match the requested action");
      }
      const next = { ...current, status: "used" as const };
      await this.#stores.confirmations.register(id, next);
      return next;
    });
  }

  async saveInvocation(invocation: InvocationRecord): Promise<void> {
    await this.#stores.invocations.register(invocation.id, invocation);
  }

  async updateInvocation(id: string, patch: Partial<InvocationRecord>): Promise<InvocationRecord> {
    const current = await this.#stores.invocations.lookup(id);
    if (!current) throw new Error("invocation not found");
    const next = { ...current, ...patch, id: current.id };
    await this.#stores.invocations.register(id, next);
    return next;
  }

  async managedSpecForClaw(claw: ClawRecord): Promise<ManagedAgentSpec> {
    const persona = await this.ensurePersonaForClaw(claw);
    return buildManagedAgentSpec({ persona, owner: await this.requirePrincipal(persona.ownerPrincipalId), skills: await values(this.#stores.skills) });
  }

  async requirePrincipal(id: string): Promise<PrincipalRecord> {
    const value = await this.#stores.principals.lookup(id);
    if (!value) throw new Error("principal not found");
    return value;
  }

  async requirePersona(id: string): Promise<PersonaRecord> {
    const value = await this.#stores.personas.lookup(id);
    if (!value) throw new Error("persona not found");
    return value;
  }

  async requireConnection(id: string): Promise<OAuthConnectionRecord> {
    const value = await this.#stores.connections.lookup(id);
    if (!value) throw new Error("connection not found");
    return value;
  }

  async connections(): Promise<OAuthConnectionRecord[]> { return values(this.#stores.connections); }
  async principals(): Promise<PrincipalRecord[]> { return values(this.#stores.principals); }
  async personas(): Promise<PersonaRecord[]> { return values(this.#stores.personas); }

  async audit(input: Omit<GovernanceAuditEvent, "id" | "at" | "correlationId"> & { correlationId?: string }): Promise<GovernanceAuditEvent> {
    const event: GovernanceAuditEvent = { ...input, id: randomUUID(), at: new Date().toISOString(), correlationId: input.correlationId ?? randomUUID() };
    await this.#stores.events.register(event.id, event);
    return event;
  }

  async #validatePersona(persona: PersonaRecord): Promise<void> {
    if (persona.actorPolicy.servicePrincipalId) {
      const service = await this.requirePrincipal(persona.actorPolicy.servicePrincipalId);
      if (service.kind !== "service") throw new Error("persona service actor must be a service principal");
    }
    for (const skillId of persona.skillIds) {
      const skill = await this.#stores.skills.lookup(skillId);
      if (!skill || skill.status !== "approved") throw new Error(`persona skill is not approved: ${skillId}`);
    }
  }

  async requireConfirmation(id: string): Promise<ConfirmationRecord> {
    const value = await this.#stores.confirmations.lookup(id);
    if (!value) throw new Error("confirmation not found");
    return value;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => this.#stores.transaction ? this.#stores.transaction(operation) : operation();
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

async function values<T>(store: StateStore<T>, sort?: (a: T, b: T) => number): Promise<T[]> {
  const list = (await store.entries()).map((entry) => entry.value);
  return sort ? list.sort(sort) : list;
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim(), "utf8") > max) throw new Error(`${label} is invalid`);
  return value.trim();
}

function unique(values: unknown, label: string, max: number): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > max) throw new Error(`${label} must contain between 1 and ${max} entries`);
  const result = values.map((value) => requireText(value, label, 120));
  if (new Set(result).size !== result.length) throw new Error(`${label} must be unique`);
  return result;
}
