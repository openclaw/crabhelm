import { randomUUID } from "node:crypto";
import { capabilityById, invocationArgumentsDigest, mayInvokePersona, normalizeGithubTarget, normalizeInvocationArguments, resolveInvocationActor, SYSTEM_OPERATOR_PRINCIPAL_ID } from "../src/governance.js";
import { GovernanceRegistry } from "../src/governance-registry.js";
import type { CreateInvocationInput, CreatePersonaInput, CreatePrincipalInput, CreateSkillInput, GovernanceAuditEvent, InvocationGrantClaims, InvocationRecord, TurnClaims, UpdatePersonaInput } from "../src/governance-types.js";
import type { CrabhelmRegistry } from "../src/registry.js";
import { signClaims, verifyClaims } from "./security.js";
import { OAuthVault } from "./vault.js";
import { postSlackConfirmation } from "./slack.js";

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
      throw new Error("direct credential upload is disabled; connect GitHub with OAuth");
    }
    if (request.method === "GET" && url.pathname === "/api/oauth/github/start") {
      const state = await this.#governance.createOAuthState(principalId);
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", this.#env.GITHUB_OAUTH_CLIENT_ID);
      authorize.searchParams.set("redirect_uri", `${this.#env.PUBLIC_URL}/api/oauth/github/callback`);
      authorize.searchParams.set("scope", "repo read:org user:email");
      authorize.searchParams.set("state", state.id);
      return oauthRedirect(authorize.toString());
    }
    if (request.method === "GET" && url.pathname === "/api/oauth/github/callback") {
      const code = text(url.searchParams.get("code"), "OAuth code", 500);
      const stateId = text(url.searchParams.get("state"), "OAuth state", 200);
      await this.#governance.consumeOAuthState(stateId, principalId);
      const credential = await exchangeGithubCode(this.#env, code);
      const profile = await githubProfile(credential.token);
      const id = randomUUID();
      const vaultKey = await this.#vault.put(id, principalId, "github", credential.token);
      try {
        await this.#governance.registerConnection({
          principalId,
          provider: "github",
          label: `GitHub @${profile.login}`,
          scopes: logicalGithubScopes(credential.scopes),
          secret: "oauth-callback",
        }, vaultKey, principalId, id);
      } catch (error) {
        await this.#vault.delete(vaultKey);
        throw error;
      }
      return oauthRedirect(`${this.#env.PUBLIC_URL}/#access`);
    }
    const connectionRevoke = url.pathname.match(/^\/api\/connections\/([^/]+)\/revoke$/u);
    if (request.method === "POST" && connectionRevoke) {
      const current = await this.#governance.requireConnection(decodeURIComponent(connectionRevoke[1]!));
      if (!isAdmin && current.principalId !== principalId) throw new Error("cannot revoke credentials for another principal");
      const credential = await this.#vault.get(current.vaultKey, current.id, current.principalId, current.provider);
      await revokeGithubCredential(this.#env, credential);
      const revoked = await this.#governance.revokeConnection(current.id, principalId);
      await this.#vault.delete(current.vaultKey);
      return json(revoked);
    }
    if (request.method === "POST" && url.pathname === "/api/invocations/issue") {
      return this.#issueInvocation(principalId, isAdmin, await readJson(request) as CreateInvocationInput);
    }
    if (request.method === "POST" && url.pathname === "/api/runtime/invocations/issue") {
      const turn = await this.#runtimeTurn(request);
      const input = await readJson(request) as Omit<CreateInvocationInput, "personaId">;
      const response = await this.#issueInvocation(turn.requesterId, false, { ...input, personaId: turn.personaId }, true);
      if (response.status === 202 && turn.surface === "slack") {
        const body = await response.clone().json() as { confirmation?: import("../src/governance-types.js").ConfirmationRecord };
        if (body.confirmation) await postSlackConfirmation(this.#env, turn, body.confirmation);
      }
      await this.#emit(await this.#governance.audit({ correlationId: turn.jobId, clawId: turn.clawId, requesterId: turn.requesterId, personaId: turn.personaId, runtimeId: `claw:${turn.clawId}`, action: "runtime.invocation.request", outcome: "succeeded", summary: "Runtime requested a governed invocation" }));
      return response;
    }
    const runtimeConfirmation = url.pathname.match(/^\/api\/runtime\/confirmations\/([^/]+)$/u);
    if (request.method === "GET" && runtimeConfirmation) {
      const turn = await this.#runtimeTurn(request);
      const confirmation = await this.#governance.requireConfirmation(decodeURIComponent(runtimeConfirmation[1]!));
      if (confirmation.requesterId !== turn.requesterId || confirmation.personaId !== turn.personaId) throw new Error("confirmation does not belong to this turn");
      return json({ id: confirmation.id, status: confirmation.status, expiresAt: confirmation.expiresAt });
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

  async #issueInvocation(requesterId: string, isAdmin: boolean, raw: CreateInvocationInput, trustedIngress = false): Promise<Response> {
    const requester = await this.#governance.requirePrincipal(requesterId);
    const persona = await this.#governance.requirePersona(text(raw.personaId, "personaId", 200));
    if (!trustedIngress && !mayInvokePersona(persona, requesterId, isAdmin)) throw new Error("requester is not permitted to invoke this persona");
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
    return json({ invocation, grant, executeUrl: `${this.#env.RUNTIME_URL}/api/tools/github/execute`, arguments: args }, 201);
  }

  async #runtimeTurn(request: Request): Promise<TurnClaims> {
    const turnToken = bearer(request);
    if (!turnToken) throw new Error("turn authentication is required");
    const turn = await verifyClaims<TurnClaims>(this.#env.RUNTIME_SIGNING_SECRET, turnToken, { typ: "turn", aud: "crabhelm-runtime-turn" });
    const persona = await this.#governance.requirePersona(turn.personaId);
    if (persona.clawId !== turn.clawId) throw new Error("persona does not belong to this turn");
    return turn;
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

async function exchangeGithubCode(env: Env, code: string): Promise<{ token: string; scopes: string[] }> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "crabhelm.example.com" },
    body: new URLSearchParams({ client_id: env.GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET, code, redirect_uri: `${env.PUBLIC_URL}/api/oauth/github/callback` }),
  });
  const value = await boundedProviderJson(response);
  if (!response.ok || typeof value.access_token !== "string") throw new Error(`GitHub OAuth exchange failed (${response.status})`);
  const scopes = typeof value.scope === "string" ? value.scope.split(",").map((scope) => scope.trim()).filter(Boolean) : [];
  return { token: value.access_token, scopes };
}

async function githubProfile(token: string): Promise<{ login: string }> {
  const response = await fetch("https://api.github.com/user", {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "crabhelm.example.com", "x-github-api-version": "2022-11-28" },
  });
  const value = await boundedProviderJson(response);
  if (!response.ok || typeof value.login !== "string" || !value.login.trim()) throw new Error(`GitHub profile lookup failed (${response.status})`);
  return { login: value.login.trim() };
}

async function revokeGithubCredential(env: Env, token: string): Promise<void> {
  const response = await fetch(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_OAUTH_CLIENT_ID)}/token`, {
    method: "DELETE",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Basic ${Buffer.from(`${env.GITHUB_OAUTH_CLIENT_ID}:${env.GITHUB_OAUTH_CLIENT_SECRET}`).toString("base64")}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "crabhelm.example.com",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ access_token: token }),
  });
  if (response.status !== 204) throw new Error(`GitHub token revocation failed (${response.status})`);
}

async function boundedProviderJson(response: Response): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 128 * 1024) throw new Error("provider response is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 128 * 1024) throw new Error("provider response is too large");
  try { return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; }
  catch { throw new Error(`provider returned invalid JSON (${response.status})`); }
}

function logicalGithubScopes(scopes: string[]): string[] {
  if (scopes.includes("repo") || scopes.includes("public_repo")) return ["repo:read", "repo:write"];
  return ["repo:read"];
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
  const response = await fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${credential}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "crabhelm.example.com", "x-github-api-version": "2022-11-28" }, ...(body ? { body } : {}) });
  const data = await boundedProviderJson(response);
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
function oauthRedirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
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
