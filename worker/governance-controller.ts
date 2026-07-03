import { randomUUID } from "node:crypto";
import { capabilityById, invocationArgumentsDigest, mayInvokePersona, normalizeGithubTarget, normalizeInvocationArguments, resolveInvocationActor, SYSTEM_OPERATOR_PRINCIPAL_ID } from "../src/governance.js";
import { GovernanceRegistry } from "../src/governance-registry.js";
import type { CreateInvocationInput, CreateOAuthConnectionInput, CreatePersonaInput, CreatePrincipalInput, CreateSkillInput, GovernanceAuditEvent, InvocationGrantClaims, InvocationRecord, UpdatePersonaInput } from "../src/governance-types.js";
import type { CrabhelmRegistry } from "../src/registry.js";
import { signClaims, verifyClaims } from "./security.js";
import { OAuthVault } from "./vault.js";

const maxBodyBytes = 64 * 1024;

export class GovernanceController {
  readonly #governance: GovernanceRegistry;
  readonly #fleet: CrabhelmRegistry;
  readonly #env: Env;
  readonly #vault: OAuthVault;

  constructor(governance: GovernanceRegistry, fleet: CrabhelmRegistry, env: Env) {
    this.#governance = governance;
    this.#fleet = fleet;
    this.#env = env;
    this.#vault = new OAuthVault(env.OAUTH_VAULT, env.VAULT_MASTER_KEY);
  }

  async route(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const principalId = request.headers.get("x-crabhelm-principal-id") || SYSTEM_OPERATOR_PRINCIPAL_ID;
    const isAdmin = (request.headers.get("x-crabhelm-roles") ?? "").split(",").includes("administrator");

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      requireAdmin(isAdmin);
      const body = record(await readJson(request));
      const principal = await this.#governance.requirePrincipal(text(body.principalId, "principalId", 200));
      const token = await signClaims<import("../src/governance-types.js").SessionClaims>(this.#env.SESSION_SIGNING_SECRET, { typ: "session", aud: "crabhelm-control-plane", principalId: principal.id, roles: principal.roles }, 8 * 60 * 60);
      return json({ token, expiresInSeconds: 8 * 60 * 60, principal: publicPrincipal(principal) }, 201);
    }
    if (request.method === "POST" && url.pathname === "/api/principals") {
      requireAdmin(isAdmin);
      return json(await this.#governance.createPrincipal(await readJson(request) as CreatePrincipalInput, principalId), 201);
    }
    if (request.method === "POST" && url.pathname === "/api/personas") {
      requireAdmin(isAdmin);
      return json(await this.#governance.createPersona(await readJson(request) as CreatePersonaInput, principalId), 201);
    }
    const persona = url.pathname.match(/^\/api\/personas\/([^/]+)$/u);
    if (request.method === "PATCH" && persona) {
      requireAdmin(isAdmin);
      return json(await this.#governance.updatePersona(decodeURIComponent(persona[1]!), await readJson(request) as UpdatePersonaInput, principalId));
    }
    if (request.method === "POST" && url.pathname === "/api/skills") {
      return json(await this.#governance.createSkill(await readJson(request) as CreateSkillInput, principalId), 201);
    }
    const skillApprove = url.pathname.match(/^\/api\/skills\/([^/]+)\/approve$/u);
    if (request.method === "POST" && skillApprove) {
      requireAdmin(isAdmin);
      return json(await this.#governance.approveSkill(decodeURIComponent(skillApprove[1]! ), principalId));
    }
    if (request.method === "POST" && url.pathname === "/api/connections") {
      const input = await readJson(request) as CreateOAuthConnectionInput;
      if (!isAdmin && input.principalId !== principalId) throw new Error("cannot connect credentials for another principal");
      if (input.provider !== "github") throw new Error("provider is not supported");
      const id = randomUUID();
      const vaultKey = await this.#vault.put(id, input.principalId, input.provider, text(input.secret, "OAuth secret", 16 * 1024));
      try {
        return json(await this.#governance.registerConnection(input, vaultKey, principalId, id), 201);
      } catch (error) {
        await this.#vault.delete(vaultKey);
        throw error;
      }
    }
    const connectionRevoke = url.pathname.match(/^\/api\/connections\/([^/]+)\/revoke$/u);
    if (request.method === "POST" && connectionRevoke) {
      const current = await this.#governance.requireConnection(decodeURIComponent(connectionRevoke[1]!));
      if (!isAdmin && current.principalId !== principalId) throw new Error("cannot revoke credentials for another principal");
      const revoked = await this.#governance.revokeConnection(current.id, principalId);
      await this.#vault.delete(current.vaultKey);
      return json(revoked);
    }
    if (request.method === "POST" && url.pathname === "/api/invocations/issue") {
      return this.#issueInvocation(principalId, isAdmin, await readJson(request) as CreateInvocationInput);
    }
    const confirmation = url.pathname.match(/^\/api\/confirmations\/([^/]+)\/(approve|deny)$/u);
    if (request.method === "POST" && confirmation) {
      return json(await this.#governance.decideConfirmation(decodeURIComponent(confirmation[1]!), principalId, confirmation[2] === "approve"));
    }
    if (request.method === "POST" && url.pathname === "/api/tools/github/execute") {
      return this.#executeGithub(request);
    }
    return undefined;
  }

  async managedSpec(clawId: string): Promise<Response> {
    return json(await this.#governance.managedSpecForClaw(await this.#fleet.get(clawId)));
  }

  async #issueInvocation(requesterId: string, isAdmin: boolean, raw: CreateInvocationInput): Promise<Response> {
    const requester = await this.#governance.requirePrincipal(requesterId);
    const persona = await this.#governance.requirePersona(text(raw.personaId, "personaId", 200));
    if (!mayInvokePersona(persona, requesterId, isAdmin)) throw new Error("requester is not permitted to invoke this persona");
    const capability = capabilityById(text(raw.capabilityId, "capabilityId", 120));
    const target = normalizeGithubTarget(raw.target);
    const args = normalizeInvocationArguments(raw.arguments);
    const argumentsDigest = invocationArgumentsDigest({ capabilityId: capability.id, target, arguments: args });
    const resolved = resolveInvocationActor({ requester, persona, capability, principals: await this.#governance.principals(), connections: await this.#governance.connections() });
    if (capability.confirmation === "always" && !raw.confirmationId) {
      const confirmation = await this.#governance.createConfirmation({
        requesterId, personaId: persona.id, actorId: resolved.actor.id, capabilityId: capability.id, target, argumentsDigest,
        summary: confirmationSummary(capability.id, target, args), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      await this.#emit(await this.#governance.audit({ clawId: persona.clawId, requesterId, personaId: persona.id, actorId: resolved.actor.id, actorMode: resolved.actorMode, fallbackUsed: resolved.fallbackUsed, capabilityId: capability.id, target, confirmationId: confirmation.id, action: "invocation.confirmation.request", outcome: "requested", summary: confirmation.summary }));
      return json({ confirmationRequired: true, confirmation }, 202);
    }
    if (capability.confirmation === "always") {
      await this.#governance.useConfirmation(text(raw.confirmationId, "confirmationId", 200), { requesterId, personaId: persona.id, actorId: resolved.actor.id, capabilityId: capability.id, target, argumentsDigest });
    }
    const now = Date.now();
    const invocationId = randomUUID();
    const expiresAt = now + 5 * 60 * 1000;
    const claimsBase = {
      typ: "invocation" as const, aud: "crabhelm-tool-wrapper" as const, clawId: persona.clawId, requesterId,
      personaId: persona.id, actorId: resolved.actor.id, actorMode: resolved.actorMode, fallbackUsed: resolved.fallbackUsed,
      capabilityId: capability.id, target, argumentsDigest, policyRevision: persona.revision, connectionId: resolved.connection.id,
      ...(raw.confirmationId ? { confirmationId: raw.confirmationId } : {}),
    };
    const grant = await signClaims<InvocationGrantClaims>(this.#env.INVOCATION_SIGNING_SECRET, claimsBase, 5 * 60);
    const claims = await verifyClaims<InvocationGrantClaims>(this.#env.INVOCATION_SIGNING_SECRET, grant, { typ: "invocation", aud: "crabhelm-tool-wrapper" });
    const invocation: InvocationRecord = {
      id: invocationId, clawId: persona.clawId, requesterId, personaId: persona.id, actorId: resolved.actor.id,
      actorMode: resolved.actorMode, fallbackUsed: resolved.fallbackUsed, capabilityId: capability.id, target, argumentsDigest,
      policyRevision: persona.revision, ...(raw.confirmationId ? { confirmationId: raw.confirmationId } : {}),
      status: "issued", issuedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
    };
    await this.#governance.saveInvocation(invocation);
    await this.#env.CLAW_COORDINATOR.getByName(persona.clawId).registerGrant({ invocationId, jti: claims.jti, argumentsDigest, expiresAt });
    await this.#emit(await this.#governance.audit({ correlationId: invocationId, clawId: persona.clawId, requesterId, personaId: persona.id, actorId: resolved.actor.id, actorMode: resolved.actorMode, fallbackUsed: resolved.fallbackUsed, capabilityId: capability.id, target, policyRevision: persona.revision, confirmationId: raw.confirmationId, action: "invocation.issue", outcome: "succeeded", summary: `Issued one-time grant for ${capability.label}` }));
    return json({ invocation, grant, executeUrl: `${this.#env.PUBLIC_URL}/api/tools/github/execute`, arguments: args }, 201);
  }

  async #executeGithub(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return json({ error: "invocation grant required" }, 401);
    const claims = await verifyClaims<InvocationGrantClaims>(this.#env.INVOCATION_SIGNING_SECRET, token, { typ: "invocation", aud: "crabhelm-tool-wrapper" });
    const body = record(await readJson(request));
    const invocationId = text(body.invocationId, "invocationId", 200);
    const args = normalizeInvocationArguments(body.arguments);
    const digest = invocationArgumentsDigest({ capabilityId: claims.capabilityId, target: claims.target, arguments: args });
    if (digest !== claims.argumentsDigest) throw new Error("tool arguments differ from the signed grant");
    const coordinator = this.#env.CLAW_COORDINATOR.getByName(claims.clawId);
    const consumed = await coordinator.consumeGrant({ invocationId, jti: claims.jti, argumentsDigest: digest, expiresAt: claims.exp * 1000 });
    if (!consumed) return json({ error: "invocation grant is expired, mismatched, or already used" }, 409);
    await coordinator.startRun(invocationId);
    await this.#governance.updateInvocation(invocationId, { status: "running" });
    try {
      const connection = await this.#governance.requireConnection(claims.connectionId);
      if (connection.status !== "active" || connection.principalId !== claims.actorId) throw new Error("actor connection is unavailable");
      const credential = await this.#vault.get(connection.vaultKey, connection.id, connection.principalId, connection.provider);
      const result = await githubRequest(claims, args, credential);
      await coordinator.finishRun(invocationId, true);
      await this.#governance.updateInvocation(invocationId, { status: "succeeded", completedAt: new Date().toISOString() });
      await this.#emit(await this.#governance.audit({ correlationId: invocationId, clawId: claims.clawId, requesterId: claims.requesterId, personaId: claims.personaId, actorId: claims.actorId, actorMode: claims.actorMode, fallbackUsed: claims.fallbackUsed, capabilityId: claims.capabilityId, target: claims.target, policyRevision: claims.policyRevision, confirmationId: claims.confirmationId, action: "tool.github.execute", outcome: "succeeded", summary: `Executed ${claims.capabilityId}` }));
      return json({ invocationId, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await coordinator.finishRun(invocationId, false, message);
      await this.#governance.updateInvocation(invocationId, { status: "failed", completedAt: new Date().toISOString() });
      await this.#emit(await this.#governance.audit({ correlationId: invocationId, clawId: claims.clawId, requesterId: claims.requesterId, personaId: claims.personaId, actorId: claims.actorId, actorMode: claims.actorMode, fallbackUsed: claims.fallbackUsed, capabilityId: claims.capabilityId, target: claims.target, policyRevision: claims.policyRevision, confirmationId: claims.confirmationId, action: "tool.github.execute", outcome: "failed", summary: message.slice(0, 240) }));
      throw error;
    }
  }

  async #emit(event: GovernanceAuditEvent): Promise<void> {
    await this.#env.AUDIT_QUEUE.send(event, { contentType: "json" });
  }
}

async function githubRequest(claims: InvocationGrantClaims, args: Record<string, string | number | boolean | null>, credential: string): Promise<unknown> {
  const target = normalizeGithubTarget(claims.target);
  const base = `https://api.github.com/repos/${target.split("/").map(encodeURIComponent).join("/")}`;
  let url = base, method = "GET", body: string | undefined;
  if (claims.capabilityId === "github.issue.read" || claims.capabilityId === "github.issue.comment") {
    const issueNumber = Number(args.issueNumber);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("issueNumber must be a positive integer");
    url += `/issues/${issueNumber}`;
  }
  if (claims.capabilityId === "github.issue.comment") {
    const comment = typeof args.body === "string" ? args.body.trim() : "";
    if (!comment || Buffer.byteLength(comment, "utf8") > 10 * 1024) throw new Error("comment body must be between 1 and 10240 bytes");
    url += "/comments"; method = "POST"; body = JSON.stringify({ body: comment });
  } else if (claims.capabilityId !== "github.repository.read" && claims.capabilityId !== "github.issue.read") {
    throw new Error("GitHub capability is unsupported");
  }
  const response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${credential}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "crabhelm.openclaw.ai", "x-github-api-version": "2022-11-28" }, ...(body ? { body } : {}) });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${typeof data.message === "string" ? data.message.slice(0, 200) : "provider error"}`);
  if (claims.capabilityId === "github.repository.read") return pick(data, ["id", "name", "full_name", "private", "html_url", "description", "default_branch", "archived"]);
  return pick(data, ["id", "number", "title", "state", "html_url", "body", "created_at", "updated_at"]);
}

function confirmationSummary(capability: string, target: string, args: Record<string, string | number | boolean | null>): string {
  if (capability === "github.issue.comment") return `Post a comment to ${target}#${String(args.issueNumber ?? "?")}`;
  return `Execute ${capability} against ${target}`;
}
function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> { return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]])); }
function publicPrincipal<T extends { id: string; label: string; kind: string; roles: unknown; departments: unknown }>(value: T) { return { id: value.id, label: value.label, kind: value.kind, roles: value.roles, departments: value.departments }; }
function requireAdmin(value: boolean): void { if (!value) throw new Error("administrator role required"); }
function bearer(request: Request): string | undefined { return request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u)?.[1]; }
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim(), "utf8") > max) throw new Error(`${label} is invalid`); return value.trim(); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBodyBytes) throw new Error("request body exceeds 64 KiB");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBodyBytes) throw new Error("request body exceeds 64 KiB");
  return bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {};
}
function json(body: unknown, status = 200): Response { return Response.json(body, { status, headers: { "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" } }); }
