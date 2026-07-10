import type { CrabhelmRuntime, DeploymentRuntimeTarget } from "../src/config.js";
import {
  clawRouterEnabled,
  ClawRouterControl,
  resolveClawRouterConfig,
} from "../src/clawrouter.js";
import { clawCredentialsGeneration } from "../src/domain.js";
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
import {
  CrabboxWorkspaceBootstrap,
  normalizeEgressLockdownMode,
  type TerminalDialer,
} from "./bootstrap.js";
import type { StateStore, StateTransaction } from "../src/state.js";
import { GovernanceController } from "./governance-controller.js";
import { signClaims } from "./security.js";

const maxBodyBytes = 64 * 1024;

export type ControlPlaneStateDatabase = {
  store<T>(
    namespace: string,
    maxEntries: number,
    options?: { overflow?: "error" | "evict-oldest" },
  ): StateStore<T>;
  transaction: StateTransaction;
};

export type ControlPlanePlatform = {
  schedule(at: number): Promise<void>;
  restart(): never;
  terminalDialer?: TerminalDialer;
  accessConfigured?: boolean;
};

export class CrabhelmControlPlaneService {
  readonly #registry: CrabhelmRegistry;
  readonly #reconciler: CrabhelmReconciler;
  readonly #runtime: CrabhelmRuntime;
  readonly #governance: GovernanceRegistry;
  readonly #governanceController: GovernanceController;
  readonly #provider: CrabboxChildCoreProvider;
  readonly #releaseIdentity: { archiveId: string; releaseId: string };
  readonly #env: Env;
  readonly #platform: ControlPlanePlatform;
  readonly #clawRouter?: ClawRouterControl;

  constructor(state: ControlPlaneStateDatabase, env: Env, platform: ControlPlanePlatform) {
    this.#env = env;
    this.#platform = platform;
    const target = deploymentTarget(env);
    let clawRouter: ClawRouterControl | undefined;
    let routedInference = false;
    let inferenceModeValid = false;
    try {
      routedInference = clawRouterEnabled(env);
      const config = resolveClawRouterConfig(env);
      if (config) clawRouter = new ClawRouterControl(config);
      inferenceModeValid = true;
    } catch {
      // Admission remains closed below; never project secret-bearing config errors.
    }
    this.#clawRouter = clawRouter;
    const inferenceReady = inferenceModeValid && (
      routedInference ? Boolean(clawRouter) : Boolean(env.OPENAI_API_KEY?.trim())
    );
    const admissionOpen = Boolean(
      env.CRABBOX_URL?.trim() &&
      env.CRABBOX_TOKEN?.trim() &&
      validSigningSecret(env.BOOTSTRAP_SIGNING_SECRET) &&
      validSigningSecret(env.SESSION_SIGNING_SECRET) &&
      validSigningSecret(env.INVOCATION_SIGNING_SECRET) &&
      validSigningSecret(env.RUNTIME_SIGNING_SECRET) &&
      validVaultKey(env.VAULT_MASTER_KEY) &&
      inferenceReady,
    );
    const runtimeTarget: DeploymentRuntimeTarget = {
      ...target,
      admissionOpen,
      ...(admissionOpen ? {} : { message: "Crabbox, signing, vault, or inference secrets are not configured" }),
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
        ...(platform.terminalDialer ? { terminalDialer: platform.terminalDialer } : {}),
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
        ...(clawRouter ? { clawRouter: clawRouter.fleetPolicy() } : {}),
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
      clawRouter ? { inference: clawRouter } : {},
    );
    this.#runtime = {
      mode: admissionOpen ? "crabbox" : "unconfigured",
      defaultTarget: target.id,
      targets: [runtimeTarget],
      githubImport: false,
      inference: clawRouter
        ? {
            kind: "clawrouter",
            defaultModel: clawRouter.fleetPolicy().defaultModel,
            baseUrl: clawRouter.fleetPolicy().baseUrl,
            tenantId: clawRouter.fleetPolicy().tenantId,
            allowedProviders: clawRouter.fleetPolicy().allowedProviders,
            modelProviders: clawRouter.fleetPolicy().modelProviders,
            metadataOnly: true,
          }
        : routedInference
          ? {
              kind: "clawrouter",
              defaultModel: "clawrouter/unconfigured/unconfigured",
              metadataOnly: true,
            }
          : { kind: "direct", defaultModel: "openai/gpt-5.5", metadataOnly: true },
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
    return this.#platform.restart();
  }

  async alarm(): Promise<void> {
    await this.#reconciler.reconcileAll();
    if ((await this.#registry.list()).some((claw) => claw.observed.phase !== "deleted")) {
      await this.#platform.schedule(Date.now() + 15_000);
    }
  }

  async managedSpec(clawId: string): Promise<Response> {
    return this.#governanceController.managedSpec(clawId);
  }

  async bootstrapInference(clawId: string): Promise<{
    model: string;
    router: ClawRecord["desired"]["inference"]["router"];
    credentialsGeneration: number;
  }> {
    const claw = await this.#registry.get(clawId);
    return {
      model: claw.desired.inference.model,
      router: claw.desired.inference.router,
      credentialsGeneration: clawCredentialsGeneration(claw),
    };
  }

  async inferenceCredentials(clawId: string, credentialsGeneration: number): Promise<Array<[string, string]>> {
    const claw = await this.#registry.get(clawId);
    if (this.#clawRouter) return this.#clawRouter.credentials(claw, credentialsGeneration);
    if (claw.desired.inference.router.kind !== "direct" || credentialsGeneration !== clawCredentialsGeneration(claw)) {
      throw new Error("inference credential request does not match desired state");
    }
    const key = this.#env.OPENAI_API_KEY?.trim();
    if (!key) throw new Error("direct inference credential is unavailable");
    return [["OPENAI_API_KEY", key]];
  }

  async prometheusMetrics(): Promise<Response> {
    const claws = (await this.#registry.list()).filter((claw) => claw.observed.phase !== "deleted");
    const phases = ["requested", "provisioning", "enrolling", "ready", "disabled", "deleting", "attention"];
    const router = claws.map((claw) => claw.observed.inference).filter((value) => value?.kind === "clawrouter");
    const usage = router.flatMap((value) => value?.usage ? [value.usage] : []);
    const lines = [
      "# HELP crabhelm_claws Current claws by lifecycle phase.",
      "# TYPE crabhelm_claws gauge",
      ...phases.map((phase) => `crabhelm_claws{phase="${phase}"} ${claws.filter((claw) => claw.observed.phase === phase).length}`),
      "# HELP crabhelm_gateways_ready Claws with healthy gateway readiness.",
      "# TYPE crabhelm_gateways_ready gauge",
      `crabhelm_gateways_ready ${claws.filter((claw) => claw.observed.gatewayVersion && claw.observed.health === "healthy").length}`,
      "# HELP crabhelm_clawrouter_routes_verified Claws with live inference proof through desired ClawRouter configuration.",
      "# TYPE crabhelm_clawrouter_routes_verified gauge",
      `crabhelm_clawrouter_routes_verified ${router.filter((value) => value?.routeVerified).length}`,
      "# HELP crabhelm_clawrouter_usage_requests Bounded aggregate request count reported by ClawRouter.",
      "# TYPE crabhelm_clawrouter_usage_requests gauge",
      `crabhelm_clawrouter_usage_requests ${usage.reduce((sum, value) => sum + value.requestCount, 0)}`,
      "# HELP crabhelm_clawrouter_usage_tokens Bounded aggregate token count reported by ClawRouter.",
      "# TYPE crabhelm_clawrouter_usage_tokens gauge",
      `crabhelm_clawrouter_usage_tokens ${usage.reduce((sum, value) => sum + value.totalTokens, 0)}`,
      "# HELP crabhelm_clawrouter_usage_cost_micros Bounded aggregate model cost in microdollars reported by ClawRouter.",
      "# TYPE crabhelm_clawrouter_usage_cost_micros gauge",
      `crabhelm_clawrouter_usage_cost_micros ${usage.reduce((sum, value) => sum + value.actualCostMicros, 0)}`,
      "",
    ];
    return new Response(lines.join("\n"), {
      headers: {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
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
    const turnToken = await signClaims<import("../src/governance-types.js").TurnClaims>(this.#env.RUNTIME_SIGNING_SECRET, {
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
      const runtimeStatuses = Object.fromEntries(await Promise.all(fleet.claws.filter((claw) => claw.observed.phase !== "deleted").map(async (claw) => [claw.id, await this.#env.CLAW_COORDINATOR.getByName(claw.id).runtimeStatus()])));
      return json({
        ...fleet,
        ...(await this.#governance.snapshot()),
        runtime: this.#runtime,
        runtimeStatuses,
        integrations: {
          operatorAccess: this.#platform.accessConfigured ?? Boolean(
            this.#env.CF_ACCESS_AUD?.trim() &&
            this.#env.CF_ACCESS_AUD !== "configure-after-access-app-creation"
          ),
          cloudflareAccess: Boolean(this.#env.CF_ACCESS_AUD?.trim() && this.#env.CF_ACCESS_AUD !== "configure-after-access-app-creation"),
          slack: Boolean(this.#env.SLACK_SIGNING_SECRET?.trim() && this.#env.SLACK_BOT_TOKEN?.trim()),
          githubOAuth: Boolean(this.#env.GITHUB_OAUTH_CLIENT_ID?.trim() && this.#env.GITHUB_OAUTH_CLIENT_SECRET?.trim()),
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
      return json({ clawId: id, disconnected: await this.#env.CLAW_COORDINATOR.getByName(id).restartRuntimeConnections() });
    }
    if (request.method === "POST" && action === "runtime-reset") {
      const claw = await this.#registry.get(id);
      if (claw.observed.phase === "deleted") throw new Error("deleted claws have no runtime state");
      const coordinator = this.#env.CLAW_COORDINATOR.getByName(id);
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
      if (action === "disable") await this.#env.CLAW_COORDINATOR.getByName(id).cancelPending();
      return json(await this.#reconciler.reconcileOne(claw.id), 202);
    }
    if (request.method === "DELETE" && !action) {
      const body = record(await readJson(request));
      const claw = await this.#registry.requestRemoval(
        id,
        actor(request),
        typeof body.confirmation === "string" ? body.confirmation : "",
      );
      await this.#env.CLAW_COORDINATOR.getByName(id).prepareForRemoval();
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
    await this.#platform.schedule(Date.now() + 10_000);
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
