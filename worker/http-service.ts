import { bootstrapInstallScript, bootstrapTokenClaims, normalizeEgressLockdownMode } from "./bootstrap.js";
import { signClaims, verifyClaims } from "./security.js";
import type { GovernanceAuditEvent, RuntimeClaims, RuntimeTicketClaims, SessionClaims } from "../src/governance-types.js";
import { verifyAccessIdentity, type AccessIdentity } from "./access.js";
import { handleSlackRequest } from "./slack.js";
import { slackIntegrationConfigured } from "./slack-config.js";
import { standaloneBootstrapHashFor } from "../src/domain.js";
import type { InferenceRouter, ObservabilityPolicy } from "../src/types.js";

const childIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const unsafeMutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type BackgroundContext = Pick<ExecutionContext, "waitUntil">;

export type HttpServiceOptions = {
  runtimeLabel: string;
  runtimeConnect?: (request: Request, env: Env, url: URL) => Promise<Response>;
  identityVerifier?: (request: Request, env: Env) => Promise<AccessIdentity | undefined>;
};

export type RuntimeConnectionIdentity = {
  runtimeId: string;
  clawId: string;
  refreshJti: string;
};

export type RuntimeConnectionAuthentication =
  | { ok: true; identity: RuntimeConnectionIdentity }
  | { ok: false; response: Response };

export async function handleCrabhelmRequest(
  request: Request,
  env: Env,
  ctx: BackgroundContext,
  options: HttpServiceOptions,
): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "crabhelm", runtime: options.runtimeLabel });
    }
    if (url.pathname === "/metrics") {
      if (!isRuntimeHost(url, env) || env.CRABHELM_PROMETHEUS !== "on") {
        return new Response("not found", { status: 404 });
      }
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (!await metricsAuthorized(request, env.METRICS_BEARER_TOKEN)) {
        return new Response("metrics authentication required", {
          status: 401,
          headers: { "www-authenticate": "Bearer", "cache-control": "no-store" },
        });
      }
      return env.CONTROL_PLANE.getByName("openclaw-org").prometheusMetrics();
    }
    if (url.pathname === "/model" || url.pathname.startsWith("/model/")) {
      return new Response("not found", { status: 404 });
    }
    if (url.pathname === "/slack/events" || url.pathname === "/slack/interactions") {
      if (!isRuntimeHost(url, env)) return new Response("not found", { status: 404 });
      if (!slackIntegrationConfigured(env)) {
        try { await request.body?.cancel("Slack ingress is not configured"); } catch { /* Best effort. */ }
        return new Response("not found", { status: 404 });
      }
      return handleSlackRequest(request, env, ctx);
    }
    if (url.pathname === "/api/runtime/connect") {
      if (!isRuntimeHost(url, env)) return new Response("not found", { status: 404 });
      return (options.runtimeConnect ?? handleCloudflareRuntimeConnect)(request, env, url);
    }
    if (url.pathname === "/api/runtime/ticket") {
      if (!isRuntimeHost(url, env)) return new Response("not found", { status: 404 });
      return handleRuntimeTicket(request, env);
    }
    if (url.pathname.startsWith("/api/runtime/")) {
      if (!isRuntimeHost(url, env)) return new Response("not found", { status: 404 });
      return env.CONTROL_PLANE.getByName("openclaw-org").fetch(request);
    }
    if (url.pathname.startsWith("/bootstrap/")) {
      if (!isRuntimeHost(url, env)) return new Response("not found", { status: 404 });
      return handleBootstrap(request, env, url);
    }
    if (url.pathname.startsWith("/api/")) {
      const stub = env.CONTROL_PLANE.getByName("openclaw-org");
      if (url.pathname === "/api/tools/github/execute" && isRuntimeHost(url, env)) return stub.fetch(request);
      if (!isConsoleHost(url, env)) return new Response("not found", { status: 404 });
      if (isCrossSiteMutation(request, env)) {
        return Response.json(
          { error: "cross-site mutation rejected" },
          { status: 403, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
        );
      }
      const auth = await authorize(request, env, options.identityVerifier ?? verifyAccessIdentity);
      if (!auth) {
        return Response.json(
          { error: "authentication required" },
          { status: 401, headers: { "www-authenticate": "Bearer", "cache-control": "no-store" } },
        );
      }
      const headers = new Headers(request.headers);
      headers.delete("x-crabhelm-principal-id");
      headers.delete("x-crabhelm-roles");
      headers.set("x-crabhelm-principal-id", auth.principalId);
      headers.set("x-crabhelm-roles", auth.roles.join(","));
      return stub.fetch(new Request(request, { headers, redirect: "manual" }));
    }
    if (!isConsoleHost(url, env)) return new Response("not found", { status: 404 });
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

export async function archiveAuditEvent(event: GovernanceAuditEvent, env: Env): Promise<boolean> {
  if (!event?.id || !event.at) return false;
  const date = event.at.slice(0, 10);
  await env.AUDIT_ARCHIVE.put(`${date}/${event.at}-${event.id}.json`, JSON.stringify(event), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { classification: "audit-metadata", correlationId: event.correlationId },
  });
  return true;
}

async function handleBootstrap(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  const match = url.pathname.match(/^\/bootstrap\/([^/]+)\/(install\.sh|bundle\.tgz|credentials\.env|managed-spec\.json)$/u);
  const childId = match?.[1] ?? "";
  const file = match?.[2] ?? "";
  if (!childIdPattern.test(childId)) return new Response("not found", { status: 404 });
  const token = bearer(request);
  const release = token ? await bootstrapTokenClaims(env.BOOTSTRAP_SIGNING_SECRET, childId, token) : undefined;
  if (!release) {
    return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  }
  const headers = { "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" };
  let desired;
  try {
    desired = await env.CONTROL_PLANE.getByName("openclaw-org").bootstrapInference(childId);
  } catch {
    return new Response("bootstrap desired state unavailable", { status: 409, headers });
  }
  const model = url.searchParams.get("model") ?? desired.model;
  const slack = url.searchParams.get("slack") ?? "false";
  const policyHash = url.searchParams.get("policyHash") ?? "";
  const credentials = url.searchParams.get("credentials") ?? String(desired.credentialsGeneration);
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)+$/u.test(model)) {
    return new Response("invalid model", { status: 400, headers });
  }
  if (slack !== "true" && slack !== "false") {
    return new Response("invalid Slack desired state", { status: 400, headers });
  }
  if (model !== desired.model) {
    return new Response("managed inference model changed", { status: 409, headers });
  }
  if (!/^[1-9][0-9]{0,8}$/u.test(credentials) || Number(credentials) !== desired.credentialsGeneration) {
    return new Response("managed credentials generation changed", { status: 409, headers });
  }
  if (file === "bundle.tgz") {
    const object = await env.APPLIANCES.get(`releases/${release.archiveId}.tgz`);
    if (!object) return new Response("appliance unavailable", { status: 503, headers });
    return new Response(object.body, {
      headers: { ...headers, "content-type": "application/gzip", etag: object.httpEtag },
    });
  }
  if (file === "managed-spec.json") {
    if (!/^[0-9a-f]{64}$/u.test(policyHash)) {
      return new Response("invalid managed policy hash", { status: 400, headers });
    }
    const response = await env.CONTROL_PLANE.getByName("openclaw-org").managedSpec(childId);
    if (!response.ok) return response;
    const spec = await response.json() as { observability?: ObservabilityPolicy };
    if (
      !spec.observability ||
      standaloneBootstrapHashFor(model, spec.observability, desired.router) !== policyHash
    ) {
      return new Response("managed policy changed", { status: 409, headers });
    }
    return Response.json(spec, { headers });
  }
  if (file === "credentials.env") {
    let modelEntries: Array<[string, string]>;
    try {
      const entries = await env.CONTROL_PLANE.getByName("openclaw-org").inferenceCredentials(
        childId,
        Number(credentials),
      );
      modelEntries = validateInferenceCredentialEntries(entries, desired.router);
    } catch {
      return new Response("inference credential unavailable", { status: 503, headers });
    }
    const runtimeToken = await signClaims<RuntimeClaims>(env.RUNTIME_SIGNING_SECRET, {
      typ: "runtime", aud: "crabhelm-runtime", clawId: childId, runtimeId: `crabbox:${childId}`,
    }, 10 * 60);
    const claims = await verifyClaims<RuntimeClaims>(env.RUNTIME_SIGNING_SECRET, runtimeToken, { typ: "runtime", aud: "crabhelm-runtime" });
    await env.CLAW_COORDINATOR.getByName(childId).registerRuntimeRefresh({ jti: claims.jti, expiresAt: claims.exp * 1000 });
    const values = [
      ...modelEntries.map(([key, value]) => `${key}=${shellValue(value)}`),
      `CRABHELM_CONTROL_URL=${shellValue(env.RUNTIME_URL)}`,
      `CRABHELM_RUNTIME_TOKEN=${shellValue(runtimeToken)}`,
      `CRABHELM_CHILD_ID=${shellValue(childId)}`,
    ];
    return new Response(`${values.join("\n")}\n`, {
      headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (!/^[0-9a-f]{64}$/u.test(policyHash)) {
    return new Response("invalid managed policy hash", { status: 400, headers });
  }
  const script = bootstrapInstallScript({
    base: `${url.origin}/bootstrap/${encodeURIComponent(childId)}`,
    archiveId: release.archiveId,
    releaseId: release.releaseId,
    nodeSha256: release.nodeId,
    childId,
    model,
    slack,
    credentialsGeneration: Number(credentials),
    policyHash,
    egressLockdown: normalizeEgressLockdownMode(env.CRABHELM_EGRESS_LOCKDOWN),
    ...(desired.router.kind === "clawrouter" ? { routerBaseUrl: desired.router.baseUrl } : {}),
  });
  return new Response(script, {
    headers: { ...headers, "content-type": "text/x-shellscript; charset=utf-8" },
  });
}

async function authorize(
  request: Request,
  env: Env,
  identityVerifier: (request: Request, env: Env) => Promise<AccessIdentity | undefined>,
): Promise<{ principalId: string; roles: string[] } | undefined> {
  const candidate = bearer(request);
  if (candidate) {
    try {
      const claims = await verifyClaims<SessionClaims>(env.SESSION_SIGNING_SECRET, candidate, { typ: "session", aud: "crabhelm-control-plane" });
      return { principalId: claims.principalId, roles: claims.roles };
    } catch { /* Access may still authenticate this request. */ }
  }
  let identity;
  try { identity = await identityVerifier(request, env); }
  catch { return undefined; }
  if (!identity) return undefined;
  return env.CONTROL_PLANE.getByName("openclaw-org").resolveAccessIdentity(identity);
}

export async function handleCloudflareRuntimeConnect(request: Request, env: Env, url: URL): Promise<Response> {
  const authentication = await authenticateRuntimeConnect(request, env, url);
  if (!authentication.ok) return authentication.response;
  const { identity } = authentication;
  const headers = new Headers(request.headers);
  headers.set("x-crabhelm-runtime-id", identity.runtimeId);
  headers.set("x-crabhelm-claw-id", identity.clawId);
  headers.set("x-crabhelm-refresh-jti", identity.refreshJti);
  headers.set("sec-websocket-protocol", "crabhelm.runtime.v1");
  return env.CLAW_COORDINATOR.getByName(identity.clawId).fetch(new Request(request, { headers, redirect: "manual" }));
}

export async function authenticateRuntimeConnect(
  request: Request,
  env: Env,
  url = new URL(request.url),
): Promise<RuntimeConnectionAuthentication> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return { ok: false, response: new Response("websocket required", { status: 426 }) };
  }
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
  const credential = protocols.find((value) => value.startsWith("crabhelm.ticket."))?.slice("crabhelm.ticket.".length) ?? "";
  if (!protocols.includes("crabhelm.runtime.v1") || !credential) {
    return { ok: false, response: new Response("runtime authentication required", { status: 401 }) };
  }
  let claims: RuntimeTicketClaims;
  try { claims = await verifyClaims<RuntimeTicketClaims>(env.RUNTIME_SIGNING_SECRET, credential, { typ: "runtime-ticket", aud: "crabhelm-runtime-connect" }); }
  catch {
    return { ok: false, response: new Response("runtime authentication required", { status: 401 }) };
  }
  const clawId = url.searchParams.get("clawId") ?? "";
  if (clawId !== claims.clawId || !childIdPattern.test(clawId)) {
    return { ok: false, response: new Response("runtime audience mismatch", { status: 403 }) };
  }
  if (!await env.CLAW_COORDINATOR.getByName(claims.clawId).consumeRuntimeTicket({ jti: claims.jti, now: Date.now() })) {
    return { ok: false, response: new Response("runtime ticket was already used", { status: 401 }) };
  }
  return {
    ok: true,
    identity: { runtimeId: claims.runtimeId, clawId: claims.clawId, refreshJti: claims.refreshJti },
  };
}

async function handleRuntimeTicket(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const token = bearer(request);
  if (!token) return new Response("runtime authentication required", { status: 401 });
  let runtime: RuntimeClaims;
  try { runtime = await verifyClaims<RuntimeClaims>(env.RUNTIME_SIGNING_SECRET, token, { typ: "runtime", aud: "crabhelm-runtime" }); }
  catch { return new Response("runtime authentication required", { status: 401 }); }
  const ticket = await signClaims<RuntimeTicketClaims>(env.RUNTIME_SIGNING_SECRET, {
    typ: "runtime-ticket",
    aud: "crabhelm-runtime-connect",
    clawId: runtime.clawId,
    runtimeId: runtime.runtimeId,
    refreshJti: runtime.jti,
  }, 30);
  const claims = await verifyClaims<RuntimeTicketClaims>(env.RUNTIME_SIGNING_SECRET, ticket, { typ: "runtime-ticket", aud: "crabhelm-runtime-connect" });
  await env.CLAW_COORDINATOR.getByName(runtime.clawId).registerRuntimeTicket({ jti: claims.jti, expiresAt: claims.exp * 1000 });
  return Response.json({ ticket, expiresInSeconds: 30 }, { headers: { "cache-control": "no-store" } });
}

function isRuntimeHost(url: URL, env: Env): boolean {
  try { return url.origin === new URL(env.RUNTIME_URL).origin; } catch { return false; }
}

function isConsoleHost(url: URL, env: Env): boolean {
  try { return url.origin === new URL(env.PUBLIC_URL).origin; } catch { return false; }
}

function isCrossSiteMutation(request: Request, env: Env): boolean {
  if (!unsafeMutationMethods.has(request.method.toUpperCase())) return false;
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).origin !== new URL(env.PUBLIC_URL).origin; }
  catch { return true; }
}

function bearer(request: Request): string | undefined {
  const match = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u);
  return match?.[1];
}

function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateInferenceCredentialEntries(
  value: unknown,
  router: InferenceRouter,
): Array<[string, string]> {
  if (!Array.isArray(value)) throw new Error("invalid inference credential projection");
  const entries = value.map((entry) => {
    if (
      !Array.isArray(entry) || entry.length !== 2 ||
      entry.some((item) => typeof item !== "string" || /[\r\n\u0000]/u.test(item) || item.length > 16_384)
    ) {
      throw new Error("invalid inference credential projection");
    }
    return [entry[0], entry[1]] as [string, string];
  });
  const keys = new Set(entries.map(([key]) => key));
  if (keys.size !== entries.length) throw new Error("invalid inference credential projection");
  if (router.kind === "direct") {
    if (entries.length !== 1 || entries[0]?.[0] !== "OPENAI_API_KEY" || !entries[0][1]) {
      throw new Error("invalid direct inference credential projection");
    }
    return entries;
  }
  const values = Object.fromEntries(entries);
  const prefix = `clawrouter-live-${router.credentialId}-`;
  if (
    entries.length !== 2 ||
    !keys.has("CLAWROUTER_API_KEY") ||
    !keys.has("CRABHELM_ROUTER_BASE_URL") ||
    values.CRABHELM_ROUTER_BASE_URL !== router.baseUrl ||
    !values.CLAWROUTER_API_KEY?.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]{8,}$/u.test(values.CLAWROUTER_API_KEY.slice(prefix.length))
  ) {
    throw new Error("invalid ClawRouter credential projection");
  }
  return entries;
}

async function metricsAuthorized(request: Request, expected: string | undefined): Promise<boolean> {
  const candidate = bearer(request);
  if (!candidate || !expected || new TextEncoder().encode(expected).byteLength < 32) return false;
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(candidate)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const actual = new Uint8Array(actualDigest);
  const wanted = new Uint8Array(expectedDigest);
  let difference = actual.byteLength ^ wanted.byteLength;
  for (let index = 0; index < Math.max(actual.byteLength, wanted.byteLength); index += 1) {
    difference |= (actual[index] ?? 0) ^ (wanted[index] ?? 0);
  }
  return difference === 0;
}
