import { clawCredentialsGeneration } from "./domain.js";
import { operationalError } from "./errors.js";
import type {
  ClawRecord,
  ClawRouterFleetPolicy,
  InferenceObservation,
  InferenceUsageSummary,
} from "./types.js";

const encoder = new TextEncoder();
const maxResponseBytes = 512 * 1024;
const requestTimeoutMs = 10_000;
const cacheMs = 30_000;

export type ClawRouterEnvironment = {
  CRABHELM_CLAWROUTER?: string;
  CLAWROUTER_BASE_URL?: string;
  CLAWROUTER_TENANT_ID?: string;
  CLAWROUTER_ALLOWED_PROVIDERS?: string;
  CLAWROUTER_MODEL_PROVIDER_MAP?: string;
  CLAWROUTER_DEFAULT_MODEL?: string;
  CLAWROUTER_ADMIN_TOKEN?: string;
  CLAWROUTER_CREDENTIAL_SECRET?: string;
  CLAWROUTER_ACCESS_CLIENT_ID?: string;
  CLAWROUTER_ACCESS_CLIENT_SECRET?: string;
};

export type ClawRouterConfig = ClawRouterFleetPolicy & {
  adminToken: string;
  credentialSecret: string;
  accessClientId?: string;
  accessClientSecret?: string;
};

export function clawRouterEnabled(env: ClawRouterEnvironment): boolean {
  const mode = env.CRABHELM_CLAWROUTER ?? "off";
  if (mode !== "on" && mode !== "off") {
    throw new Error("CRABHELM_CLAWROUTER must be on or off");
  }
  return mode === "on";
}

export function resolveClawRouterConfig(env: ClawRouterEnvironment): ClawRouterConfig | undefined {
  if (!clawRouterEnabled(env)) return undefined;
  const rawBaseUrl = required(env.CLAWROUTER_BASE_URL, "CLAWROUTER_BASE_URL");
  const url = new URL(rawBaseUrl);
  if (
    url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
    url.search || url.hash
  ) {
    throw new Error("CLAWROUTER_BASE_URL must be an exact HTTPS origin");
  }
  const tenantId = required(env.CLAWROUTER_TENANT_ID, "CLAWROUTER_TENANT_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/u.test(tenantId)) {
    throw new Error("CLAWROUTER_TENANT_ID is invalid");
  }
  const allowedProviders = [...new Set(
    required(env.CLAWROUTER_ALLOWED_PROVIDERS, "CLAWROUTER_ALLOWED_PROVIDERS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )].sort();
  if (
    allowedProviders.length < 1 || allowedProviders.length > 32 ||
    allowedProviders.some((value) => !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value))
  ) {
    throw new Error("CLAWROUTER_ALLOWED_PROVIDERS must contain 1 to 32 provider ids");
  }
  const modelProviders = parseModelProviderMap(
    env.CLAWROUTER_MODEL_PROVIDER_MAP,
    allowedProviders,
  );
  const defaultModel = required(env.CLAWROUTER_DEFAULT_MODEL, "CLAWROUTER_DEFAULT_MODEL");
  if (
    !/^clawrouter\/[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.:\-/]{0,199}$/u.test(defaultModel) ||
    !modelProviders[defaultModel]
  ) {
    throw new Error("CLAWROUTER_DEFAULT_MODEL must have an explicit model-to-provider mapping");
  }
  const credentialSecret = required(env.CLAWROUTER_CREDENTIAL_SECRET, "CLAWROUTER_CREDENTIAL_SECRET");
  if (encoder.encode(credentialSecret).byteLength < 32) {
    throw new Error("CLAWROUTER_CREDENTIAL_SECRET must contain at least 32 bytes");
  }
  const accessClientId = optional(env.CLAWROUTER_ACCESS_CLIENT_ID);
  const accessClientSecret = optional(env.CLAWROUTER_ACCESS_CLIENT_SECRET);
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw new Error("CLAWROUTER_ACCESS_CLIENT_ID and CLAWROUTER_ACCESS_CLIENT_SECRET must be configured together");
  }
  return {
    baseUrl: url.origin,
    tenantId,
    allowedProviders,
    modelProviders,
    defaultModel,
    adminToken: required(env.CLAWROUTER_ADMIN_TOKEN, "CLAWROUTER_ADMIN_TOKEN"),
    credentialSecret,
    ...(accessClientId && accessClientSecret ? { accessClientId, accessClientSecret } : {}),
  };
}

export class ClawRouterControl {
  readonly #config: ClawRouterConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #cache = new Map<string, { fingerprint: string; at: number; value: InferenceObservation }>();

  constructor(config: ClawRouterConfig, options: { fetch?: typeof globalThis.fetch } = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  fleetPolicy(): ClawRouterFleetPolicy {
    const { baseUrl, tenantId, allowedProviders, modelProviders, defaultModel } = this.#config;
    return {
      baseUrl,
      tenantId,
      allowedProviders: [...allowedProviders],
      modelProviders: { ...modelProviders },
      defaultModel,
    };
  }

  async credentials(claw: ClawRecord, expectedGeneration: number): Promise<Array<[string, string]>> {
    const router = claw.desired.inference.router;
    const generation = clawCredentialsGeneration(claw);
    if (router.kind !== "clawrouter" || expectedGeneration !== generation) {
      throw operationalError("CLAWROUTER_STATUS_INVALID", "ClawRouter credential request does not match desired state");
    }
    assertDesiredRouter(this.#config, claw, router);
    const { token } = await this.#credential(router.credentialId, claw.id, generation);
    return [
      ["CLAWROUTER_API_KEY", token],
      ["CRABHELM_ROUTER_BASE_URL", router.baseUrl],
    ];
  }

  async reconcile(claw: ClawRecord): Promise<InferenceObservation> {
    const router = claw.desired.inference.router;
    if (router.kind !== "clawrouter") {
      throw operationalError("CLAWROUTER_STATUS_INVALID", "Claw does not have ClawRouter desired state");
    }
    assertDesiredRouter(this.#config, claw, router);
    const credentialsGeneration = clawCredentialsGeneration(claw);
    const fingerprint = JSON.stringify({
      enabled: claw.desired.enabled,
      model: claw.desired.inference.model,
      fallbackModels: claw.desired.inference.fallbackModels,
      monthlyBudgetUsd: claw.desired.inference.monthlyBudgetUsd ?? null,
      router,
      credentialsGeneration,
    });
    const cached = this.#cache.get(claw.id);
    if (cached?.fingerprint === fingerprint && Date.now() - cached.at < cacheMs) return cached.value;

    const { token, secretSha256 } = await this.#credential(
      router.credentialId,
      claw.id,
      credentialsGeneration,
    );
    const monthlyBudgetMicros = claw.desired.inference.monthlyBudgetUsd === undefined
      ? null
      : Math.round(claw.desired.inference.monthlyBudgetUsd * 1_000_000);
    const policy = asRecord(await this.#admin(`/v1/admin/policies/${encodeURIComponent(router.policyId)}`, {
      enabled: claw.desired.enabled,
      providers: router.providers,
      tenantId: router.tenantId,
      tokenRole: "service",
      monthlyBudgetMicros,
      retainRequestContent: false,
    }));
    if (
      policy.policyId !== router.policyId ||
      policy.enabled !== claw.desired.enabled ||
      policy.tenantId !== router.tenantId ||
      policy.tokenRole !== "service" ||
      policy.monthlyBudgetMicros !== monthlyBudgetMicros ||
      policy.retainRequestContent !== false ||
      !sameStrings(stringArray(policy.providers), router.providers)
    ) {
      throw operationalError("CLAWROUTER_STATUS_INVALID", "ClawRouter policy did not converge");
    }
    const credential = asRecord(await this.#admin(
      `/v1/admin/credentials/${encodeURIComponent(router.credentialId)}`,
      {
        enabled: claw.desired.enabled,
        policyId: router.policyId,
        secretSha256,
      },
    ));
    if (
      credential.credentialId !== router.credentialId ||
      credential.policyId !== router.policyId ||
      credential.enabled !== claw.desired.enabled ||
      credential.policyEnabled !== claw.desired.enabled ||
      credential.generationMatches !== true ||
      credential.active !== claw.desired.enabled
    ) {
      throw operationalError("CLAWROUTER_STATUS_INVALID", "ClawRouter returned mismatched credential metadata");
    }

    const checkedAt = new Date().toISOString();
    if (!claw.desired.enabled) {
      const health = await this.#client("/v1/health", undefined, false).catch(() => undefined);
      const value: InferenceObservation = {
        kind: "clawrouter",
        checkedAt,
        baseUrl: router.baseUrl,
        model: claw.desired.inference.model,
        providers: [...router.providers],
        policyId: router.policyId,
        credentialId: router.credentialId,
        credentialsGeneration,
        policyActive: false,
        credentialActive: false,
        routerHealthy: asRecord(health).ok === true,
        catalogReady: false,
        routeVerified: false,
        budget: budgetFrom(monthlyBudgetMicros),
      };
      this.#cache.set(claw.id, { fingerprint, at: Date.now(), value });
      return value;
    }

    const [health, key, catalog, usage] = await Promise.all([
      this.#client("/v1/health", undefined, false),
      this.#client("/v1/key/inspect", token),
      this.#client("/v1/catalog", token),
      this.#client("/v1/usage", token).catch(() => undefined),
    ]);
    const inspected = asRecord(key);
    const active = inspected.verified === true && inspected.kid === router.credentialId && inspected.enabled === true;
    const observedProviders = stringArray(inspected.providers);
    if (!active || !sameStrings(observedProviders, router.providers)) {
      throw operationalError("CLAWROUTER_STATUS_INVALID", "ClawRouter credential scope did not converge");
    }
    const usageRecord = asRecord(usage);
    const value: InferenceObservation = {
      kind: "clawrouter",
      checkedAt,
      baseUrl: router.baseUrl,
      model: claw.desired.inference.model,
      providers: observedProviders,
      policyId: router.policyId,
      credentialId: router.credentialId,
      credentialsGeneration,
      policyActive: active,
      credentialActive: active,
      routerHealthy: asRecord(health).ok === true,
      catalogReady: [
        claw.desired.inference.model,
        ...claw.desired.inference.fallbackModels,
      ].every((model) => {
        const providerId = router.modelProviders[model];
        return Boolean(providerId) && catalogContains(catalog, model, providerId);
      }),
      routeVerified: false,
      budget: budgetObservation(usageRecord.budget, monthlyBudgetMicros),
      ...(usageRecord.usage ? { usage: usageSummary(usageRecord.usage) } : {}),
    };
    if (!value.routerHealthy || !value.catalogReady) {
      throw operationalError("CLAWROUTER_STATUS_INVALID", "ClawRouter health or model catalog is not ready");
    }
    this.#cache.set(claw.id, { fingerprint, at: Date.now(), value });
    return value;
  }

  async #credential(
    credentialId: string,
    clawId: string,
    generation: number,
  ): Promise<{ token: string; secretSha256: string }> {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.#config.credentialSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`crabhelm-clawrouter:v1:${clawId}:${generation}`),
    ));
    const secret = base64Url(signature);
    return {
      token: `clawrouter-live-${credentialId}-${secret}`,
      secretSha256: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)))),
    };
  }

  #admin(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.#request(path, {
      method: "PUT",
      headers: this.#headers(this.#config.adminToken, true),
      body: JSON.stringify(body),
    });
  }

  #client(path: string, token?: string, authenticate = true): Promise<unknown> {
    return this.#request(path, {
      method: "GET",
      headers: authenticate ? this.#headers(token ?? "", false) : { accept: "application/json" },
    });
  }

  #headers(token: string, admin: boolean): HeadersInit {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    if (admin && this.#config.accessClientId && this.#config.accessClientSecret) {
      headers["cf-access-client-id"] = this.#config.accessClientId;
      headers["cf-access-client-secret"] = this.#config.accessClientSecret;
    }
    return headers;
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#config.baseUrl}${path}`, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw operationalError("CLAWROUTER_UNREACHABLE", "ClawRouter is unreachable", error);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw operationalError(
        "CLAWROUTER_REJECTED",
        `ClawRouter rejected a control-plane request (HTTP ${response.status})`,
      );
    }
    return readBoundedJson(response);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel("response too large").catch(() => undefined);
      throw operationalError("CLAWROUTER_STATUS_INVALID", "ClawRouter metadata response exceeded the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return total ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  } catch (error) {
    throw operationalError("CLAWROUTER_STATUS_INVALID", "ClawRouter returned invalid metadata", error);
  }
}

function catalogContains(value: unknown, model: string, providerId: string): boolean {
  const expectedModel = model.startsWith("clawrouter/")
    ? model.slice("clawrouter/".length)
    : "";
  const providers = asRecord(value).providers;
  if (!expectedModel || !Array.isArray(providers)) return false;
  let matches = 0;
  for (const provider of providers) {
    const row = asRecord(provider);
    if (row.id !== providerId || row.executable !== true || !Array.isArray(row.models)) continue;
    matches += row.models.filter((candidate) => asRecord(candidate).id === expectedModel).length;
  }
  return matches === 1;
}

function budgetFrom(limit: number | null): InferenceObservation["budget"] {
  return limit === null ? { configured: false } : { configured: true, limitMicros: limit };
}

function budgetObservation(value: unknown, desiredLimit: number | null): InferenceObservation["budget"] {
  const budget = asRecord(value);
  const configured = budget.configured === true;
  const limitMicros = safeInteger(budget.limitMicros);
  if (configured !== (desiredLimit !== null) || (desiredLimit !== null && limitMicros !== desiredLimit)) {
    throw operationalError("CLAWROUTER_STATUS_INVALID", "ClawRouter budget metadata did not converge");
  }
  return {
    configured,
    ...(limitMicros !== undefined ? { limitMicros } : {}),
    ...(safeInteger(budget.spentMicros) !== undefined ? { spentMicros: safeInteger(budget.spentMicros) } : {}),
    ...(safeInteger(budget.remainingMicros) !== undefined ? { remainingMicros: safeInteger(budget.remainingMicros) } : {}),
  };
}

function usageSummary(value: unknown): InferenceUsageSummary {
  const summary = asRecord(asRecord(value).summary);
  return {
    requestCount: safeInteger(summary.requestCount) ?? 0,
    successCount: safeInteger(summary.successCount) ?? 0,
    errorCount: safeInteger(summary.errorCount) ?? 0,
    inputTokens: safeInteger(summary.inputTokens) ?? 0,
    outputTokens: safeInteger(summary.outputTokens) ?? 0,
    totalTokens: safeInteger(summary.totalTokens) ?? 0,
    actualCostMicros: safeInteger(summary.actualCostMicros) ?? 0,
  };
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...new Set(value)].sort()
    : [];
}

function sameStrings(a: string[], b: string[]): boolean {
  const expected = [...b].sort();
  return a.length === expected.length && a.every((value, index) => value === expected[index]);
}

function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const left = Object.entries(asRecord(a));
  if (left.some(([, value]) => typeof value !== "string")) return false;
  const sortedLeft = left.sort(([first], [second]) => first.localeCompare(second));
  const right = Object.entries(b).sort(([first], [second]) => first.localeCompare(second));
  return JSON.stringify(sortedLeft) === JSON.stringify(right);
}

function assertDesiredRouter(
  config: ClawRouterConfig,
  claw: ClawRecord,
  router: Extract<ClawRecord["desired"]["inference"]["router"], { kind: "clawrouter" }>,
): void {
  const expectedId = `crabhelm_${claw.id.replaceAll("-", "").toLowerCase()}`;
  const expectedProviders = [
    claw.desired.inference.model,
    ...claw.desired.inference.fallbackModels,
  ].map((model) => config.modelProviders[model]);
  if (
    router.baseUrl !== config.baseUrl ||
    router.tenantId !== config.tenantId ||
    router.policyId !== expectedId ||
    router.credentialId !== expectedId ||
    !sameStrings(router.allowedProviders, config.allowedProviders) ||
    !sameStringRecord(router.modelProviders, config.modelProviders) ||
    expectedProviders.some((provider) => !provider) ||
    !sameStrings(
      router.providers,
      expectedProviders.filter(
        (provider, index, providers): provider is string =>
          Boolean(provider) && providers.indexOf(provider) === index,
      ),
    )
  ) {
    throw operationalError("CLAWROUTER_STATUS_INVALID", "ClawRouter desired state does not match fleet configuration");
  }
}

function parseModelProviderMap(
  value: string | undefined,
  allowedProviders: string[],
): Record<string, string> {
  const entries = required(value, "CLAWROUTER_MODEL_PROVIDER_MAP")
    .split(",")
    .map((entry) => entry.trim());
  if (entries.length < 1 || entries.length > 128 || entries.some((entry) => !entry)) {
    throw new Error("CLAWROUTER_MODEL_PROVIDER_MAP must contain 1 to 128 mappings");
  }
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.lastIndexOf("=");
    const model = separator > 0 ? entry.slice(0, separator).trim() : "";
    const provider = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!/^clawrouter\/[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.:\-/]{0,199}$/u.test(model)) {
      throw new Error("CLAWROUTER_MODEL_PROVIDER_MAP contains an invalid ClawRouter model");
    }
    if (!allowedProviders.includes(provider)) {
      throw new Error("CLAWROUTER_MODEL_PROVIDER_MAP contains a provider outside the fleet allowlist");
    }
    if (Object.hasOwn(result, model)) {
      throw new Error("CLAWROUTER_MODEL_PROVIDER_MAP contains a duplicate model");
    }
    result[model] = provider;
  }
  return Object.fromEntries(Object.entries(result).sort(([first], [second]) => first.localeCompare(second)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function required(value: string | undefined, name: string): string {
  const clean = value?.trim();
  if (!clean || /[\r\n\u0000]/u.test(clean)) throw new Error(`${name} is required`);
  return clean;
}

function optional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  if (!clean) return undefined;
  if (/[\r\n\u0000]/u.test(clean)) throw new Error("ClawRouter access service credential is invalid");
  return clean;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
