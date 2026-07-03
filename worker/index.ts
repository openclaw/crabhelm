import { validBootstrapToken } from "./bootstrap.js";
import { timingSafeEqual } from "node:crypto";
import { signClaims, verifyClaims } from "./security.js";
import type { GovernanceAuditEvent, RuntimeClaims, SessionClaims } from "../src/governance-types.js";
export { CrabhelmControlPlane } from "./control-plane.js";
export { CrabhelmClawCoordinator } from "./claw-coordinator.js";

const childIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "crabhelm", runtime: "cloudflare-workers" });
    }
    if (url.pathname.startsWith("/bootstrap/")) {
      return handleBootstrap(request, env, url);
    }
    if (url.pathname.startsWith("/api/")) {
      const stub = env.CONTROL_PLANE.getByName("openclaw-org");
      if (url.pathname === "/api/tools/github/execute") return stub.fetch(request);
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
      return stub.fetch(new Request(request, { headers }));
    }
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
  if (!token || !await validBootstrapToken(
    env.BOOTSTRAP_SIGNING_SECRET,
    childId,
    env.APPLIANCE_MANIFEST_SHA256,
    token,
  )) {
    return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  }
  const headers = { "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" };
  if (file === "bundle.tgz") {
    const object = await env.APPLIANCES.get("openclaw-core/bundle.tgz");
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
    }, 24 * 60 * 60);
    const values = [
      `OPENAI_API_KEY=${shellValue(env.OPENAI_API_KEY)}`,
      `CRABHELM_CONTROL_URL=${shellValue(env.PUBLIC_URL)}`,
      `CRABHELM_RUNTIME_TOKEN=${shellValue(runtimeToken)}`,
    ];
    if (env.SLACK_BOT_TOKEN?.trim() && env.SLACK_APP_TOKEN?.trim()) {
      values.push(`SLACK_BOT_TOKEN=${shellValue(env.SLACK_BOT_TOKEN)}`);
      values.push(`SLACK_APP_TOKEN=${shellValue(env.SLACK_APP_TOKEN)}`);
    }
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
[[ "$actual_archive_sha256" = ${shellValue(env.APPLIANCE_ARCHIVE_SHA256)} ]] || { printf '%s\n' 'crabhelm bootstrap: appliance archive digest mismatch' >&2; exit 1; }
tar -xzf "$work/bundle.tgz" -C "$work"
curl --fail --silent --show-error --location "\${auth[@]}" ${shellValue(`${base}/credentials.env`)} -o "$work/credentials.env"
chmod 0600 "$work/credentials.env"
curl --fail --silent --show-error --location "\${auth[@]}" ${shellValue(`${base}/managed-spec.json`)} -o "$work/managed-spec.json"
chmod 0600 "$work/managed-spec.json"
export CRABHELM_BUNDLE_MANIFEST_SHA256=${shellValue(env.APPLIANCE_MANIFEST_SHA256)}
export CRABHELM_NODE_SHA256=${shellValue(env.NODE_RUNTIME_SHA256)}
export CRABHELM_CREDENTIAL_FILE="$work/credentials.env"
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
  if (!candidate) return undefined;
  const encoder = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(candidate)));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(env.OPERATOR_TOKEN)));
  if (timingSafeEqual(a, b)) return { principalId: "principal:operator", roles: ["administrator", "member"] };
  try {
    const claims = await verifyClaims<SessionClaims>(env.SESSION_SIGNING_SECRET, candidate, { typ: "session", aud: "crabhelm-control-plane" });
    return { principalId: claims.principalId, roles: claims.roles };
  } catch { return undefined; }
}

function bearer(request: Request): string | undefined {
  const match = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u);
  return match?.[1];
}

function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
