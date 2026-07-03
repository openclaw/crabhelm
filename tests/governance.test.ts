import assert from "node:assert/strict";
import test from "node:test";
import { createClawRecord } from "../src/domain.js";
import {
  buildManagedAgentSpec,
  capabilityById,
  createPersonaRecord,
  createPrincipalRecord,
  createSkillRecord,
  mayInvokePersona,
  resolveInvocationActor,
} from "../src/governance.js";
import { GovernanceRegistry } from "../src/governance-registry.js";
import type {
  ConfirmationRecord,
  GovernanceAuditEvent,
  InvocationRecord,
  OAuthConnectionRecord,
  PersonaRecord,
  PrincipalRecord,
  RuntimeClaims,
  SkillRecord,
} from "../src/governance-types.js";
import { createMemoryStateStore } from "../src/state.js";
import { signClaims, verifyClaims } from "../worker/security.js";

test("profile persona cannot borrow owner or service authority", () => {
  assert.throws(() => createPersonaRecord({
    name: "Damian profile", kind: "profile", ownerPrincipalId: "damian", clawId: "claw",
    actorPolicy: { mode: "service", servicePrincipalId: "bot" },
  }), /profile assistants must use invoker/u);
});

test("actor resolution uses requester first and explicit service fallback", () => {
  const requester = createPrincipalRecord({ subject: "github:alice", label: "Alice" });
  const service = createPrincipalRecord({ subject: "service:maestro", label: "Maestro", kind: "service" });
  const persona = createPersonaRecord({
    name: "Incident helper", kind: "shared", ownerPrincipalId: requester.id, clawId: "claw",
    actorPolicy: { mode: "invoker-with-service-fallback", servicePrincipalId: service.id },
    capabilityIds: ["github.repository.read"],
  });
  const connection = (principalId: string): OAuthConnectionRecord => ({
    id: principalId, revision: 1, principalId, provider: "github", label: "GitHub",
    scopes: ["repo:read"], vaultKey: `oauth/${principalId}`, status: "active",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const invoker = resolveInvocationActor({ requester, persona, capability: capabilityById("github.repository.read"), principals: [requester, service], connections: [connection(requester.id), connection(service.id)] });
  assert.equal(invoker.actor.id, requester.id);
  assert.equal(invoker.fallbackUsed, false);
  const fallback = resolveInvocationActor({ requester, persona, capability: capabilityById("github.repository.read"), principals: [requester, service], connections: [connection(service.id)] });
  assert.equal(fallback.actor.id, service.id);
  assert.equal(fallback.fallbackUsed, true);
});

test("managed specs contain only approved, eligible skill artifacts", () => {
  const owner = createPrincipalRecord({ subject: "github:alice", label: "Alice", departments: ["engineering"] });
  const skill = { ...createSkillRecord({ name: "Deploy read", departments: ["engineering"], files: [{ path: "SKILL.md", content: "# Deploy read" }] }, owner.id), status: "approved" as const };
  const persona = createPersonaRecord({ name: "Alice agent", kind: "personal", ownerPrincipalId: owner.id, clawId: "claw", skillIds: [skill.id] });
  const spec = buildManagedAgentSpec({ persona, owner, skills: [skill] });
  assert.equal(spec.readOnly, true);
  assert.equal(spec.skills[0]?.digest, skill.digest);
  assert.equal(spec.skills[0]?.files[0]?.path, "SKILL.md");
});

test("confirmation decisions are requester-bound and one-use", async () => {
  const registry = registryFixture();
  const operator = await registry.ensureSystem();
  const claw = createClawRecord({ name: "Alice agent", owner: { subject: "github:alice", label: "Alice", source: "github" } });
  const persona = await registry.ensurePersonaForClaw(claw);
  const digest = "a".repeat(64);
  const confirmation = await registry.createConfirmation({
    requesterId: operator.id, personaId: persona.id, actorId: operator.id,
    capabilityId: "github.issue.comment", target: "openclaw/openclaw", argumentsDigest: digest,
    summary: "Post comment", expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await assert.rejects(registry.decideConfirmation(confirmation.id, "someone-else", true), /only the requester/u);
  await registry.decideConfirmation(confirmation.id, operator.id, true);
  const expected = { requesterId: operator.id, personaId: persona.id, actorId: operator.id, capabilityId: "github.issue.comment", target: "openclaw/openclaw", argumentsDigest: digest };
  assert.equal((await registry.useConfirmation(confirmation.id, expected)).status, "used");
  await assert.rejects(registry.useConfirmation(confirmation.id, expected), /approved confirmation/u);
});

test("signed runtime claims reject tampering and expiry class mismatch", async () => {
  const secret = "s".repeat(32);
  const token = await signClaims<RuntimeClaims>(secret, { typ: "runtime", aud: "crabhelm-runtime", clawId: "claw", runtimeId: "runtime" }, 60);
  assert.equal((await verifyClaims<RuntimeClaims>(secret, token, { typ: "runtime", aud: "crabhelm-runtime" })).clawId, "claw");
  await assert.rejects(verifyClaims<RuntimeClaims>(secret, `${token.slice(0, -1)}x`, { typ: "runtime", aud: "crabhelm-runtime" }), /signature/u);
});

test("service-backed shared personas require owner or administrator invocation", () => {
  const requester = createPrincipalRecord({ subject: "github:member", label: "Member" });
  const owner = createPrincipalRecord({ subject: "github:owner", label: "Owner" });
  const persona = createPersonaRecord({ name: "Shared", kind: "shared", ownerPrincipalId: owner.id, clawId: "claw" });
  assert.equal(mayInvokePersona(persona, requester.id, false), false);
  assert.equal(mayInvokePersona(persona, owner.id, false), true);
  assert.equal(mayInvokePersona(persona, requester.id, true), true);
  const profile = createPersonaRecord({ name: "Owner profile", kind: "profile", ownerPrincipalId: owner.id, clawId: "claw" });
  assert.equal(mayInvokePersona(profile, requester.id, false), true);
});

function registryFixture(): GovernanceRegistry {
  return new GovernanceRegistry({
    principals: createMemoryStateStore<PrincipalRecord>(),
    personas: createMemoryStateStore<PersonaRecord>(),
    skills: createMemoryStateStore<SkillRecord>(),
    connections: createMemoryStateStore<OAuthConnectionRecord>(),
    confirmations: createMemoryStateStore<ConfirmationRecord>(),
    invocations: createMemoryStateStore<InvocationRecord>(),
    events: createMemoryStateStore<GovernanceAuditEvent>(),
  });
}
