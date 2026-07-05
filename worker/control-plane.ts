import { DurableObject } from "cloudflare:workers";
import type { CrabhelmRuntime, DeploymentRuntimeTarget } from "../src/config.js";
import { CrabboxChildCoreProvider, RoutedChildCoreProvider } from "../src/providers.js";
import { CrabhelmReconciler } from "../src/reconciler.js";
import { CrabhelmRegistry } from "../src/registry.js";
import { GovernanceRegistry } from "../src/governance-registry.js";
import { selectSlackPersona } from "../src/governance.js";
import type {
  ConfirmationRecord,
  GovernanceAuditEvent,
  InvocationRecord,
  OAuthConnectionRecord,
  OAuthStateRecord,
  PersonaRecord,
  PrincipalRecord,
  SkillRecord,
} from "../src/governance-types.js";
import type {
  AuditEvent,
  ClawRecord,
  CreateClawInput,
  CreatePolicyInput,
  PolicyTemplate,
  UpdateClawInput,
} from "../src/types.js";
import { CrabboxWorkspaceBootstrap, normalizeEgressLockdownMode } from "./bootstrap.js";
import { DurableObjectStateDatabase } from "./state.js";
import { GovernanceController } from "./governance-controller.js";
import { modelProxyAdmissionReady } from "./model-proxy.js";
import { signClaims } from "./security.js";

const maxBodyBytes = 64 * 1024;

export class CrabhelmControlPlane extends DurableObject<Env> {
  readonly #registry: CrabhelmRegistry;
  readonly #reconciler: CrabhelmReconciler;
  readonly #runtime: CrabhelmRuntime;
  readonly #governance: GovernanceRegistry;
  readonly #governanceController: GovernanceController;
  readonly #provider: CrabboxChildCoreProvider;
  readonly #releaseIdentity: { archiveId: string; releaseId: string };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const state = new DurableObjectStateDatabase(ctx.storage);
    const target = deploymentTarget(env);
    const admissionOpen = Boolean(
      env.CRABBOX_URL?.trim() &&
      env.CRABBOX_TOKEN?.trim() &&
      validSigningSecret(env.BOOTSTRAP_SIGNING_SECRET) &&
      validSigningSecret(env.SESSION_SIGNING_SECRET) &&
      validSigningSecret(env.INVOCATION_SIGNING_SECRET) &&
      validSigningSecret(env.RUNTIME_SIGNING_SECRET) &&
      validVaultKey(env.VAULT_MASTER_KEY) &&
      modelProxyAdmissionReady(env),
    );
    const runtimeTarget: DeploymentRuntimeTarget = {
      ...target,
      admissionOpen,
      ...(admissionOpen ? {} : { message: "Crabbox, signing, vault, or enabled model-proxy secrets are not configured" }),
    };
    const provider = new CrabboxChildCoreProvider({
      baseUrl: env.CRABBOX_URL,
      token: env.CRABBOX_TOKEN,
      profile: target.profile,
      ttlSeconds: target.ttlSeconds,
      idleTimeoutSeconds: target.idleTimeoutSeconds,
      workspaceBootstrap: new CrabboxWorkspaceBootstrap({
        brokerToken: env.CRABBOX_TOKEN,
        publicUrl: env.RUNTIME_URL,
        releaseId: env.APPLIANCE_MANIFEST_SHA256,
        archiveId: env.APPLIANCE_ARCHIVE_SHA256,
        nodeId: env.NODE_RUNTIME_SHA256,
        signingSecret: env.BOOTSTRAP_SIGNING_SECRET,
        egressLockdown: normalizeEgressLockdownMode(env.CRABHELM_EGRESS_LOCKDOWN),
        coordinators: env.CLAW_COORDINATOR,
      }),
    });
    this.#provider = provider;
    this.#releaseIdentity = {
      archiveId: env.APPLIANCE_ARCHIVE_SHA256,
      releaseId: env.APPLIANCE_MANIFEST_SHA256,
    };
    this.#registry = new CrabhelmRegistry(
      state.store<ClawRecord>("claws-v1", 10_000),
      state.store<AuditEvent>("audit-v1", 50_000, { overflow: "evict-oldest" }),
      {
        deploymentTargets: {
          [target.id]: { profile: target.profile, ...(target.region ? { region: target.region } : {}) },
        },
        defaultDeployment: {
          target: target.id,
          profile: target.profile,
          ...(target.region ? { region: target.region } : {}),
        },
        policies: state.store<PolicyTemplate>("policies-v1", 1_000),
        transaction: state.transaction,
      },
    );
    this.#governance = new GovernanceRegistry({
      principals: state.store<PrincipalRecord>("principals-v1", 10_000),
      personas: state.store<PersonaRecord>("personas-v1", 10_000),
      skills: state.store<SkillRecord>("skills-v1", 10_000),
      connections: state.store<OAuthConnectionRecord>("oauth-connections-v1", 20_000),
      oauthStates: state.store<OAuthStateRecord>("oauth-states-v1", 10_000, { overflow: "evict-oldest" }),
      confirmations: state.store<ConfirmationRecord>("confirmations-v1", 50_000, { overflow: "evict-oldest" }),
      invocations: state.store<InvocationRecord>("invocations-v1", 50_000, { overflow: "evict-oldest" }),
      events: state.store<GovernanceAuditEvent>("governance-audit-v1", 50_000, { overflow: "evict-oldest" }),
      transaction: state.transaction,
    });
    this.#governanceController = new GovernanceController(this.#governance, this.#registry, env);
    this.#reconciler = new CrabhelmReconciler(
      this.#registry,
      new RoutedChildCoreProvider({
        [target.id]: {
          profile: target.profile,
          ...(target.region ? { region: target.region } : {}),
          provider,
        },
      }),
    );
    this.#runtime = {
      mode: admissionOpen ? "crabbox" : "unconfigured",
      defaultTarget: target.id,
      targets: [runtimeTarget],
      githubImport: false,
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.#route(request);
    } catch (error) {
      console.error(JSON.stringify({
        event: "control_plane_request_failed",
        method: request.method,
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        error instanceof SyntaxError ? 400 : 422,
      );
    }
  }

  deploymentIdentity(): { archiveId: string; releaseId: string } {
    return this.#releaseIdentity;
  }

  restartForDeployment(): never {
    this.ctx.abort("Crabhelm deployment requested a control-plane isolate restart");
    throw new Error("control-plane isolate restart did not abort execution");
  }

  async alarm(): Promise<void> {
    await this.#reconciler.reconcileAll();
    if ((await this.#registry.list()).some((claw) => claw.observed.phase !== "deleted")) {
      await this.ctx.storage.setAlarm(Date.now() + 15_000);
    }
  }

  async managedSpec(clawId: string): Promise<Response> {
    return this.#governanceController.managedSpec(clawId);
  }

  async resolveAccessIdentity(identity: { subject: string; email: string; roles: Array<"administrator" | "member">; groups: string[] }): Promise<{ principalId: string; roles: Array<"administrator" | "member"> }> {
    const principal = await this.#governance.ensureExternalPrincipal({
      subject: identity.subject,
      label: identity.email,
      source: "oidc",
      roles: identity.roles,
      departments: identity.groups,
    });
    return { principalId: principal.id, roles: principal.roles };
  }

  async routeSlackTurn(input: {
    jobId: string;
    workspaceId: string;
    channelId: string;
    threadTs: string;
    userId: string;
    email?: string;
    label: string;
  }): Promise<{ clawId: string; requesterId: string; personaId: string; turnToken: string }> {
    const subject = input.email?.trim()
      ? `email:${input.email.trim().toLowerCase()}`
      : `slack:${input.workspaceId}:${input.userId}`;
    const principal = await this.#governance.ensureExternalPrincipal({
      subject,
      label: input.email?.trim().toLowerCase() || input.label,
      source: "slack",
      roles: ["member"],
    });
    const persona = selectSlackPersona(await this.#governance.personas(), input.workspaceId, input.channelId);
    if (!persona) throw new Error("No Crabhelm persona is bound to this Slack conversation");
    const claw = await this.#registry.get(persona.clawId);
    if (!claw.desired.enabled || claw.observed.phase !== "ready") throw new Error("The assigned Crabhelm teammate is not ready");
    const turnToken = await signClaims<import("../src/governance-types.js").TurnClaims>(this.env.RUNTIME_SIGNING_SECRET, {
      typ: "turn",
      aud: "crabhelm-runtime-turn",
      jobId: input.jobId,
      clawId: persona.clawId,
      requesterId: principal.id,
      personaId: persona.id,
      surface: "slack",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      threadTs: input.threadTs,
    }, 30 * 60);
    return { clawId: persona.clawId, requesterId: principal.id, personaId: persona.id, turnToken };
  }

  async decideSlackConfirmation(input: { workspaceId: string; userId: string; email?: string; confirmationId: string; approve: boolean }): Promise<{ status: string; summary: string }> {
    const subject = input.email?.trim()
      ? `email:${input.email.trim().toLowerCase()}`
      : `slack:${input.workspaceId}:${input.userId}`;
    const principal = await this.#governance.principalBySubject(subject);
    if (!principal) throw new Error("Slack requester is not linked to a Crabhelm principal");
    const confirmation = await this.#governance.decideConfirmation(input.confirmationId, principal.id, input.approve);
    return { status: confirmation.status, summary: confirmation.summary };
  }

  async #route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const governanceResponse = await this.#governanceController.route(request);
    if (governanceResponse) return governanceResponse;
    requireAdministrator(request);
    if (request.method === "GET" && url.pathname === "/api/state") {
      const fleet = await this.#registry.snapshot();
      await Promise.all(fleet.claws.filter((claw) => claw.observed.phase !== "deleted").map((claw) => this.#governance.ensurePersonaForClaw(claw)));
      const runtimeStatuses = Object.fromEntries(await Promise.all(fleet.claws.filter((claw) => claw.observed.phase !== "deleted").map(async (claw) => [claw.id, await this.env.CLAW_COORDINATOR.getByName(claw.id).runtimeStatus()])));
      return json({
        ...fleet,
        ...(await this.#governance.snapshot()),
        runtime: this.#runtime,
        runtimeStatuses,
        integrations: {
          cloudflareAccess: Boolean(this.env.CF_ACCESS_AUD?.trim() && this.env.CF_ACCESS_AUD !== "configure-after-access-app-creation"),
          slack: Boolean(this.env.SLACK_SIGNING_SECRET?.trim() && this.env.SLACK_BOT_TOKEN?.trim()),
          githubOAuth: Boolean(this.env.GITHUB_OAUTH_CLIENT_ID?.trim() && this.env.GITHUB_OAUTH_CLIENT_SECRET?.trim()),
          runtimeBridge: fleet.claws.some((claw) => (runtimeStatuses[claw.id]?.connected ?? 0) > 0),
        },
        viewer: {
          principalId: actor(request),
          roles: (request.headers.get("x-crabhelm-roles") ?? "").split(",").filter(Boolean),
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/policies") {
      return json(
        await this.#registry.createPolicy(
          (await readJson(request)) as CreatePolicyInput,
          actor(request),
        ),
        201,
      );
    }
    const policyMatch = url.pathname.match(/^\/api\/policies\/([^/]+)\/(versions|preview|apply)$/u);
    if (request.method === "POST" && policyMatch) {
      const policyId = decodeURIComponent(policyMatch[1] ?? "");
      const action = policyMatch[2];
      const body = record(await readJson(request));
      if (action === "versions") {
        return json(await this.#registry.addPolicyVersion(
          policyId,
          body as Pick<CreatePolicyInput, "description" | "spec">,
          actor(request),
        ), 201);
      }
      const version = positiveInteger(body.version, "policy version");
      const clawIds = clawIdsFrom(body.clawIds);
      if (action === "preview") {
        return json(await this.#registry.previewPolicy(policyId, version, clawIds));
      }
      const expectedGenerations = generationMap(body.expectedGenerations, clawIds);
      const canaryId = typeof body.canaryId === "string" && body.canaryId.trim()
        ? body.canaryId.trim()
        : undefined;
      if (clawIds.length > 1 && (!canaryId || !clawIds.includes(canaryId))) {
        throw new Error("a selected canaryId is required for multi-claw policy application");
      }
      const results: Array<{ clawId: string; ok: boolean; canary: boolean; claw?: ClawRecord; error?: string }> = [];
      if (canaryId) {
        await this.#registry.applyPolicy(
          policyId,
          version,
          [canaryId],
          expectedGenerations,
          actor(request),
        );
        const claw = await this.#reconciler.reconcileOne(canaryId);
        const ok = claw.observed.phase === "ready" || claw.observed.phase === "disabled";
        results.push({
          clawId: canaryId,
          ok,
          canary: true,
          claw,
          ...(ok ? {} : { error: claw.observed.message }),
        });
        if (!ok) {
          await this.#schedule();
          return json({
            policyId,
            version,
            canaryId,
            aborted: true,
            remainingNotApplied: clawIds.filter((id) => id !== canaryId),
            requested: results.length,
            succeeded: 0,
            failed: 1,
            results,
          }, 207);
        }
      }
      const remaining = clawIds.filter((id) => id !== canaryId);
      if (remaining.length) {
        await this.#registry.applyPolicy(
          policyId,
          version,
          remaining,
          expectedGenerations,
          actor(request),
        );
        for (const clawId of remaining) {
          const claw = await this.#reconciler.reconcileOne(clawId);
          const ok = claw.observed.phase === "ready" || claw.observed.phase === "disabled";
          results.push({
            clawId,
            ok,
            canary: false,
            claw,
            ...(ok ? {} : { error: claw.observed.message }),
          });
        }
      }
      await this.#schedule();
      const succeeded = results.filter((result) => result.ok).length;
      return json({
        policyId,
        version,
        canaryId,
        aborted: Boolean(canaryId && results[0] && !results[0].ok),
        requested: results.length,
        succeeded,
        failed: results.length - succeeded,
        results,
      }, succeeded === results.length ? 202 : 207);
    }
    if (request.method === "POST" && url.pathname === "/api/claws") {
      this.#assertCanCreate();
      const claw = await this.#registry.create(
        (await readJson(request)) as CreateClawInput,
        actor(request),
      );
      await this.#governance.ensurePersonaForClaw(claw);
      const result = await this.#reconciler.reconcileOne(claw.id);
      await this.#schedule();
      return json(result, 202);
    }
    if (request.method === "POST" && url.pathname === "/api/claws/batch") {
      this.#assertCanCreate();
      const items = record(await readJson(request)).items;
      if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
        throw new Error("batch items must contain between 1 and 50 claws");
      }
      const results = [];
      for (const item of items) {
        try {
          const claw = await this.#registry.create(item as CreateClawInput, actor(request));
          await this.#governance.ensurePersonaForClaw(claw);
          results.push({ ok: true, claw: await this.#reconciler.reconcileOne(claw.id) });
        } catch (error) {
          results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      await this.#schedule();
      const succeeded = results.filter((result) => result.ok).length;
      return json({
        requested: results.length,
        succeeded,
        failed: results.length - succeeded,
        results,
      }, succeeded === results.length ? 202 : 207);
    }
    if (url.pathname.startsWith("/api/import/github")) {
      throw new Error("GitHub organization import is not configured");
    }
    const clawMatch = url.pathname.match(/^\/api\/claws\/([^/]+)(?:\/(.+))?$/u);
    if (!clawMatch) return json({ error: "not found" }, 404);
    const id = decodeURIComponent(clawMatch[1] ?? "");
    const action = clawMatch[2];
    if (action?.startsWith("pairing")) {
      throw new Error("Slack pairing control is unavailable for standalone workspace agents");
    }
    if (request.method === "POST" && action === "runtime-reconnect") {
      const claw = await this.#registry.get(id);
      if (claw.observed.phase === "deleted") throw new Error("deleted claws have no runtime connection");
      return json({ clawId: id, disconnected: await this.env.CLAW_COORDINATOR.getByName(id).restartRuntimeConnections() });
    }
    if (request.method === "POST" && action === "runtime-reset") {
      const claw = await this.#registry.get(id);
      if (claw.observed.phase === "deleted") throw new Error("deleted claws have no runtime state");
      const coordinator = this.env.CLAW_COORDINATOR.getByName(id);
      const canceled = await coordinator.cancelActiveTurns();
      const disconnected = await coordinator.restartRuntimeConnections();
      return json({ clawId: id, canceled, disconnected });
    }
    if (request.method === "GET" && action === "runtime-diagnostics") {
      return json(await this.#provider.runtimeDiagnostics(await this.#registry.get(id)));
    }
    if (request.method === "GET" && !action) return json(await this.#registry.get(id));
    if (request.method === "PATCH" && !action) {
      const claw = await this.#registry.update(
        id,
        (await readJson(request)) as UpdateClawInput,
        actor(request),
      );
      await this.#schedule();
      return json(await this.#reconciler.reconcileOne(claw.id), 202);
    }
    if (request.method === "POST" && action === "reconcile") {
      const result = await this.#reconciler.reconcileOne(id);
      await this.#schedule();
      return json(result);
    }
    if (request.method === "POST" && action === "rotate-credentials") {
      const claw = await this.#registry.rotateCredentials(id, actor(request));
      await this.#schedule();
      return json(await this.#reconciler.reconcileOne(claw.id), 202);
    }
    if (request.method === "POST" && (action === "disable" || action === "enable")) {
      const claw = await this.#registry.setEnabled(
        id,
        action === "enable",
        actor(request),
      );
      await this.#schedule();
      if (action === "disable") await this.env.CLAW_COORDINATOR.getByName(id).cancelPending();
      return json(await this.#reconciler.reconcileOne(claw.id), 202);
    }
    if (request.method === "DELETE" && !action) {
      const body = record(await readJson(request));
      const claw = await this.#registry.requestRemoval(
        id,
        actor(request),
        typeof body.confirmation === "string" ? body.confirmation : "",
      );
      await this.env.CLAW_COORDINATOR.getByName(id).prepareForRemoval();
      await this.#schedule();
      return json(await this.#reconciler.reconcileOne(claw.id), 202);
    }
    return json({ error: "method not allowed" }, 405);
  }

  #assertCanCreate(): void {
    const target = this.#runtime.targets[0];
    if (!target?.admissionOpen) throw new Error(target?.message ?? "deployment is unavailable");
  }

  async #schedule(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 10_000);
  }
}

function deploymentTarget(env: Env): DeploymentRuntimeTarget {
  return {
    id: env.CRABBOX_TARGET_ID,
    label: env.CRABBOX_TARGET_LABEL,
    region: env.CRABBOX_TARGET_REGION,
    profile: env.CRABBOX_PROFILE,
    ttlSeconds: Number(env.CRABBOX_TTL_SECONDS),
    idleTimeoutSeconds: Number(env.CRABBOX_IDLE_TIMEOUT_SECONDS),
    admissionOpen: true,
  };
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBodyBytes) throw new Error("request body exceeds 64 KiB");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel();
      throw new Error("request body exceeds 64 KiB");
    }
    chunks.push(value);
  }
  if (size === 0) return {};
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be positive`);
  return Number(value);
}

function clawIdsFrom(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error("clawIds must contain between 1 and 100 ids");
  }
  const ids = value.map((id) => typeof id === "string" ? id.trim() : "");
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("clawIds must contain unique non-empty ids");
  }
  return ids;
}

function generationMap(value: unknown, ids: string[]): Record<string, number> {
  const input = record(value);
  return Object.fromEntries(ids.map((id) => {
    const generation = input[id];
    if (!Number.isInteger(generation) || Number(generation) < 0) {
      throw new Error(`expected generation is required for claw ${id}`);
    }
    return [id, Number(generation)];
  }));
}

function actor(request: Request): string {
  return request.headers.get("x-crabhelm-principal-id") ?? "principal:operator";
}

function requireAdministrator(request: Request): void {
  if (!(request.headers.get("x-crabhelm-roles") ?? "").split(",").includes("administrator")) {
    throw new Error("administrator role required");
  }
}

function validSigningSecret(value: string | undefined): boolean {
  return typeof value === "string" && new TextEncoder().encode(value).byteLength >= 32;
}

function validVaultKey(value: string | undefined): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try { return Buffer.from(value, "base64url").byteLength === 32; } catch { return false; }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}
