import type { ModelClaims } from "../src/governance-types.js";
import { signClaims, verifyClaims } from "./security.js";

// The child Gateway calls the model provider through this edge proxy instead of
// holding the raw provider key. The child presents a per-claw, audience-bound
// model token; the Worker verifies it, strips any caller-supplied auth, injects
// the real OPENAI_API_KEY, and forwards to a single fixed upstream. The raw
// provider key never leaves Cloudflare.

// Structural subset of the Worker Env this module needs. Declared locally (not
// the ambient `Env` global) so the Node test suite can import this file under a
// tsconfig that does not include worker-configuration.d.ts. The real Env
// satisfies it.
export type ModelProxyEnv = {
  CRABHELM_MODEL_PROXY?: string;
  MODEL_SIGNING_SECRET?: string;
  OPENAI_API_KEY: string;
  RUNTIME_URL: string;
  CRABBOX_TTL_SECONDS?: string;
};

const UPSTREAM_ORIGIN = "https://api.openai.com";

// Only the OpenAI-compatible endpoints the OpenClaw agent runtime needs. Keeps
// the proxy from being turned into a general-purpose egress for api.openai.com.
const ALLOWED_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/v1/chat/completions" },
  { method: "POST", path: "/v1/responses" },
  { method: "POST", path: "/v1/responses/compact" },
  { method: "POST", path: "/v1/embeddings" },
  { method: "GET", path: "/v1/models" },
];

// Match Cloudflare's lowest request-body ceiling. Enforce it again while
// streaming because higher account plans accept larger bodies at the edge.
const MAX_REQUEST_BYTES = 100 * 1024 * 1024;
// Runtime turns may run for 840 seconds; keep a small delivery margin while
// still bounding stalled upstream requests.
const UPSTREAM_TIMEOUT_MS = 15 * 60 * 1000;

export function modelProxyEnabled(env: ModelProxyEnv): boolean {
  return env.CRABHELM_MODEL_PROXY === "on";
}

// The model credential entries delivered to a child in credentials.env. With
// the proxy off (default) this is the raw provider key, exactly as before. With
// it on, the child receives a per-claw model token plus the edge base URL and
// never the raw key.
export async function modelCredentialEntries(env: ModelProxyEnv, clawId: string): Promise<Array<[string, string]>> {
  if (!modelProxyEnabled(env)) {
    return [["OPENAI_API_KEY", env.OPENAI_API_KEY]];
  }
  if (typeof env.MODEL_SIGNING_SECRET !== "string" || new TextEncoder().encode(env.MODEL_SIGNING_SECRET).byteLength < 32) {
    throw new Error("model proxy is enabled but MODEL_SIGNING_SECRET is not configured");
  }
  // The token outlives one substrate lifetime; each substrate recreation
  // re-fetches credentials.env and mints a fresh one.
  const ttlSeconds = Math.min(Math.max(Number(env.CRABBOX_TTL_SECONDS) || 14_400, 1_800), 86_400);
  const modelToken = await signClaims<ModelClaims>(env.MODEL_SIGNING_SECRET, {
    typ: "model", aud: "crabhelm-model", clawId,
  }, ttlSeconds);
  const baseUrl = `${new URL(env.RUNTIME_URL).origin}/model/v1`;
  return [
    ["OPENAI_API_KEY", modelToken],
    ["OPENAI_BASE_URL", baseUrl],
    ["CRABHELM_MODEL_BASE_URL", baseUrl],
  ];
}

export function modelProxyReady(env: ModelProxyEnv): boolean {
  return modelProxyEnabled(env) && modelProxyConfigured(env);
}

function modelProxyConfigured(env: ModelProxyEnv): boolean {
  return typeof env.MODEL_SIGNING_SECRET === "string" &&
    new TextEncoder().encode(env.MODEL_SIGNING_SECRET).byteLength >= 32 &&
    Boolean(env.OPENAI_API_KEY?.trim());
}

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "crabhelm_model_proxy" } }), {
    status: 401,
    headers: { "content-type": "application/json", "cache-control": "no-store", "www-authenticate": "Bearer" },
  });
}

function requestTooLarge(): Response {
  return new Response(JSON.stringify({ error: { message: "request body too large", type: "crabhelm_model_proxy" } }), {
    status: 413,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function limitedRequestBody(body: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  exceeded: () => boolean;
} {
  const reader = body.getReader();
  let total = 0;
  let tooLarge = false;
  return {
    exceeded: () => tooLarge,
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          total += value.byteLength;
          if (total > MAX_REQUEST_BYTES) {
            tooLarge = true;
            await reader.cancel("request body too large").catch(() => undefined);
            controller.error(new Error("request body too large"));
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      },
    }),
  };
}

export async function handleModelProxy(request: Request, env: ModelProxyEnv, url: URL): Promise<Response> {
  // Keep verifying already-issued tokens while issuance is disabled so an
  // operator can roll claws back to direct provider access without an outage.
  if (!modelProxyConfigured(env)) {
    return new Response(JSON.stringify({ error: { message: "model proxy is not configured", type: "crabhelm_model_proxy" } }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  // Path after the /model prefix must be an exact allowlisted route.
  const suffix = url.pathname.slice("/model".length);
  const route = ALLOWED_ROUTES.find((entry) => entry.path === suffix);
  if (!route) return new Response(JSON.stringify({ error: { message: "unsupported model route", type: "crabhelm_model_proxy" } }), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
  if (request.method !== route.method) return new Response("method not allowed", { status: 405, headers: { allow: route.method } });
  if (url.search) return new Response(JSON.stringify({ error: { message: "query parameters are not permitted", type: "crabhelm_model_proxy" } }), {
    status: 400,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

  const bearer = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!bearer) return unauthorized("model token required");
  let claims: ModelClaims;
  try {
    claims = await verifyClaims<ModelClaims>(env.MODEL_SIGNING_SECRET!, bearer, { typ: "model", aud: "crabhelm-model" });
  } catch {
    return unauthorized("model token is invalid");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return requestTooLarge();
  }
  const limitedBody = route.method === "GET" || !request.body ? undefined : limitedRequestBody(request.body);
  const body = limitedBody?.stream;

  // Build the upstream request against a fixed origin/path — never a
  // caller-influenced host — with a freshly minted Authorization header.
  const upstream = new URL(route.path, UPSTREAM_ORIGIN);
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  headers.set("authorization", `Bearer ${env.OPENAI_API_KEY}`);
  headers.set("x-crabhelm-claw", claims.clawId);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream, {
      method: route.method,
      headers,
      body: body as BodyInit | undefined,
      redirect: "manual",
      // Streaming request body pass-through requires half-duplex.
      ...(route.method === "GET" ? {} : { duplex: "half" } as { duplex: "half" }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    if (limitedBody?.exceeded()) return requestTooLarge();
    return new Response(JSON.stringify({ error: { message: "model upstream is unreachable", type: "crabhelm_model_proxy" } }), {
      status: 502,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  // Pass the upstream response (including SSE streams) straight back, keeping
  // only content framing headers. Never echo upstream auth or set-cookie.
  const responseHeaders = new Headers();
  for (const key of ["content-type", "cache-control"]) {
    const value = upstreamResponse.headers.get(key);
    if (value) responseHeaders.set(key, value);
  }
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
