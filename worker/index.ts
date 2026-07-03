import { bootstrapTokenClaims } from "./bootstrap.js";
import { signClaims, verifyClaims } from "./security.js";
import type { GovernanceAuditEvent, RuntimeClaims, RuntimeTicketClaims, SessionClaims } from "../src/governance-types.js";
import { verifyAccessIdentity } from "./access.js";
import { handleSlackRequest } from "./slack.js";
export { CrabhelmControlPlane } from "./control-plane.js";
export { CrabhelmClawCoordinator } from "./claw-coordinator.js";
export { CrabhelmAdmin } from "./admin-entrypoint.js";

const childIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "crabhelm", runtime: "cloudflare-workers" });
    }
    if (url.pathname === "/slack/events" || url.pathname === "/slack/interactions") {
      if (!isRuntimeHost(url, env)) return new Response("not found", { status: 404 });
      return handleSlackRequest(request, env, ctx);
    }
    if (url.pathname === "/api/runtime/connect") {
      if (!isRuntimeHost(url, env)) return new Response("not found", { status: 404 });
      return handleRuntimeConnect(request, env, url);
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
      const auth = await authorize(request, env);
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
    if (isRuntimeHost(url, env)) return new Response("not found", { status: 404 });
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
  async queue(batch: MessageBatch<GovernanceAuditEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const event = message.body;
      if (!event?.id || !event.at) { message.ack(); continue; }
      const date = event.at.slice(0, 10);
      await env.AUDIT_ARCHIVE.put(`${date}/${event.at}-${event.id}.json`, JSON.stringify(event), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { classification: "audit-metadata", correlationId: event.correlationId },
      });
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, GovernanceAuditEvent>;

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
  if (file === "bundle.tgz") {
    const object = await env.APPLIANCES.get(`releases/${release.archiveId}.tgz`);
    if (!object) return new Response("appliance unavailable", { status: 503, headers });
    return new Response(object.body, {
      headers: { ...headers, "content-type": "application/gzip", etag: object.httpEtag },
    });
  }
  if (file === "managed-spec.json") {
    return env.CONTROL_PLANE.getByName("openclaw-org").managedSpec(childId);
  }
  if (file === "credentials.env") {
    const runtimeToken = await signClaims<RuntimeClaims>(env.RUNTIME_SIGNING_SECRET, {
      typ: "runtime", aud: "crabhelm-runtime", clawId: childId, runtimeId: `crabbox:${childId}`,
    }, 10 * 60);
    const claims = await verifyClaims<RuntimeClaims>(env.RUNTIME_SIGNING_SECRET, runtimeToken, { typ: "runtime", aud: "crabhelm-runtime" });
    await env.CLAW_COORDINATOR.getByName(childId).registerRuntimeRefresh({ jti: claims.jti, expiresAt: claims.exp * 1000 });
    const values = [
      `OPENAI_API_KEY=${shellValue(env.OPENAI_API_KEY)}`,
      `CRABHELM_CONTROL_URL=${shellValue(env.RUNTIME_URL)}`,
      `CRABHELM_RUNTIME_TOKEN=${shellValue(runtimeToken)}`,
      `CRABHELM_CHILD_ID=${shellValue(childId)}`,
    ];
    return new Response(`${values.join("\n")}\n`, {
      headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
    });
  }
  const model = url.searchParams.get("model") ?? "openai/gpt-5.5";
  const slack = url.searchParams.get("slack") ?? "false";
  if (!/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(model)) {
    return new Response("invalid model", { status: 400, headers });
  }
  if (slack !== "true" && slack !== "false") {
    return new Response("invalid Slack desired state", { status: 400, headers });
  }
  const base = `${url.origin}/bootstrap/${encodeURIComponent(childId)}`;
  const script = `#!/usr/bin/env bash
set -euo pipefail
umask 077
: "\${CRABHELM_BOOTSTRAP_TOKEN:?missing bootstrap token}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
auth=(--header "Authorization: Bearer $CRABHELM_BOOTSTRAP_TOKEN")
curl --fail --silent --show-error --location "\${auth[@]}" ${shellValue(`${base}/bundle.tgz`)} -o "$work/bundle.tgz"
actual_archive_sha256="$(sha256sum "$work/bundle.tgz")"
actual_archive_sha256="\${actual_archive_sha256%% *}"
[[ "$actual_archive_sha256" = ${shellValue(release.archiveId)} ]] || { printf '%s\n' 'crabhelm bootstrap: appliance archive digest mismatch' >&2; exit 1; }
tar -xzf "$work/bundle.tgz" -C "$work"
curl --fail --silent --show-error --location "\${auth[@]}" ${shellValue(`${base}/credentials.env`)} -o "$work/credentials.env"
chmod 0600 "$work/credentials.env"
curl --fail --silent --show-error --location "\${auth[@]}" ${shellValue(`${base}/managed-spec.json`)} -o "$work/managed-spec.json"
chmod 0600 "$work/managed-spec.json"
export CRABHELM_BUNDLE_MANIFEST_SHA256=${shellValue(release.releaseId)}
export CRABHELM_NODE_SHA256=${shellValue(env.NODE_RUNTIME_SHA256)}
export CRABHELM_CREDENTIAL_FILE="$work/credentials.env"
export CRABHELM_CREDENTIAL_REFRESH_URL=${shellValue(`${base}/credentials.env`)}
export CRABHELM_MANAGED_SPEC_FILE="$work/managed-spec.json"
export CRABBOX_ADAPTER_ROOT_SESSION_ID=${shellValue(childId)}
export CRABHELM_STANDALONE=true
export CRABHELM_MODEL=${shellValue(model)}
export CRABHELM_SLACK_ENABLED=${shellValue(slack)}
/bin/bash "$work/bundle/guest-install.sh"
`;
  return new Response(script, {
    headers: { ...headers, "content-type": "text/x-shellscript; charset=utf-8" },
  });
}

async function authorize(request: Request, env: Env): Promise<{ principalId: string; roles: string[] } | undefined> {
  const candidate = bearer(request);
  if (candidate) {
    try {
      const claims = await verifyClaims<SessionClaims>(env.SESSION_SIGNING_SECRET, candidate, { typ: "session", aud: "crabhelm-control-plane" });
      return { principalId: claims.principalId, roles: claims.roles };
    } catch { /* Access may still authenticate this request. */ }
  }
  let identity;
  try { identity = await verifyAccessIdentity(request, env); }
  catch { return undefined; }
  if (!identity) return undefined;
  return env.CONTROL_PLANE.getByName("openclaw-org").resolveAccessIdentity(identity);
}

async function handleRuntimeConnect(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("websocket required", { status: 426 });
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
  const credential = protocols.find((value) => value.startsWith("crabhelm.ticket."))?.slice("crabhelm.ticket.".length) ?? "";
  if (!protocols.includes("crabhelm.runtime.v1") || !credential) return new Response("runtime authentication required", { status: 401 });
  let claims: RuntimeTicketClaims;
  try { claims = await verifyClaims<RuntimeTicketClaims>(env.RUNTIME_SIGNING_SECRET, credential, { typ: "runtime-ticket", aud: "crabhelm-runtime-connect" }); }
  catch { return new Response("runtime authentication required", { status: 401 }); }
  const clawId = url.searchParams.get("clawId") ?? "";
  if (clawId !== claims.clawId || !childIdPattern.test(clawId)) return new Response("runtime audience mismatch", { status: 403 });
  if (!await env.CLAW_COORDINATOR.getByName(claims.clawId).consumeRuntimeTicket({ jti: claims.jti, now: Date.now() })) {
    return new Response("runtime ticket was already used", { status: 401 });
  }
  const headers = new Headers(request.headers);
  headers.set("x-crabhelm-runtime-id", claims.runtimeId);
  headers.set("x-crabhelm-claw-id", claims.clawId);
  headers.set("x-crabhelm-refresh-jti", claims.refreshJti);
  headers.set("sec-websocket-protocol", "crabhelm.runtime.v1");
  return env.CLAW_COORDINATOR.getByName(claims.clawId).fetch(new Request(request, { headers, redirect: "manual" }));
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
  try { return url.host === new URL(env.RUNTIME_URL).host; } catch { return false; }
}

function bearer(request: Request): string | undefined {
  const match = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u);
  return match?.[1];
}

function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
