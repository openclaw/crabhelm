import { createHash, randomBytes } from "node:crypto";
import { run } from "./proc.mjs";

export const KEY_PREFIX = "agentrun_";
const NAME = /^agentrun_[A-Za-z0-9_]{4,110}$/;

// Runs inside the ClawRouter pod. It reads the admin token from the pod's own
// environment, calls the loopback admin API, and prints only non-secret
// credential metadata. The body for "put" is the body "clawctl device add"
// sends with no flags: the default device policy, no budget, no request cap.
export const IN_POD_SCRIPT = String.raw`
const [op, name, sha] = process.argv.slice(1);
const token = process.env.CLAWROUTER_ADMIN_TOKEN;
const out = (value, code = 0) => { console.log(JSON.stringify(value)); process.exit(code); };
if (!token) out({ ok: false, op, error: "admin-access:absent" }, 2);
if (op !== "list" && !/^agentrun_[A-Za-z0-9_]{4,110}$/.test(name ?? "")) out({ ok: false, op, error: "invalid key name" }, 2);
async function call(method, path, body) {
  const res = await fetch("http://127.0.0.1:8789" + path, {
    method,
    headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = JSON.parse(await res.text()); } catch {}
  if (!res.ok) throw new Error(method + " " + path.split("/").slice(0, 4).join("/") + " -> " + res.status + " " + String(json?.error?.code ?? json?.error ?? "").slice(0, 80));
  return json;
}
try {
  if (op === "put") {
    if (!/^[0-9a-f]{64}$/.test(sha ?? "")) out({ ok: false, op, error: "invalid sha256" }, 2);
    await call("PUT", "/v1/admin/keys/" + name, {
      secretSha256: sha, providers: ["openai", "anthropic"], tenantId: "default",
      tokenRole: "service", retainRequestContent: false,
    });
  } else if (op === "revoke") {
    await call("POST", "/v1/admin/credentials/" + name + "/revoke");
  } else if (op !== "get" && op !== "list") {
    out({ ok: false, op, error: "unknown op" }, 2);
  }
  const all = (await call("GET", "/v1/admin/credentials")).credentials ?? [];
  const credentials = all
    .filter((c) => String(c.credentialId).startsWith("agentrun_"))
    .filter((c) => op === "list" || c.credentialId === name)
    .map((c) => ({ credentialId: c.credentialId, policyId: c.policyId, enabled: c.enabled === true, active: c.active === true }));
  out({ ok: true, op, credentials });
} catch (error) {
  out({ ok: false, op, error: String(error?.message ?? error) }, 1);
}
`;

export function newKeyName(now = new Date(), random = randomBytes(3).toString("hex")) {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return KEY_PREFIX + stamp + "_" + random;
}

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

export class ClawRouterAdmin {
  #config;
  #run;
  #fetch;

  constructor(config, { runner = run, fetcher = globalThis.fetch } = {}) {
    this.#config = config;
    this.#run = runner;
    this.#fetch = fetcher;
  }

  async #pod(op, name = "", sha = "") {
    const c = this.#config;
    const args = [
      "--context", c.kubeContext, "-n", c.routerNamespace, "exec", "deploy/" + c.routerDeployment,
      "-c", c.routerContainer, "--", "node", "--input-type=module", "-e", IN_POD_SCRIPT, op,
      ...(name ? [name] : []), ...(sha ? [sha] : []),
    ];
    const result = await this.#run("kubectl", args);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    let parsed;
    try { parsed = JSON.parse(line); } catch { parsed = undefined; }
    if (!parsed?.ok) {
      const reason = parsed?.error ?? ("kubectl exit " + result.code);
      throw new Error("ClawRouter " + op + " failed: " + reason);
    }
    return parsed.credentials;
  }

  // Returns { name, token }. The token exists only in this process's memory.
  async mint(name) {
    if (!NAME.test(name)) throw new Error("invalid key name");
    const secret = randomBytes(24).toString("hex");
    try {
      const credentials = await this.#pod("put", name, sha256Hex(secret));
      const entry = credentials.find((c) => c.credentialId === name);
      if (!entry?.enabled) throw new Error("ClawRouter did not report the new key as enabled");
    } catch (error) {
      // The put may have landed even when its reply failed; never leave the key enabled.
      await this.revoke(name).catch((revokeError) => {
        error.message += "; revoke after failed mint also failed: " + revokeError.message;
      });
      throw error;
    }
    return { name, token: "clawrouter-live-" + name + "-" + secret };
  }

  async revoke(name) {
    if (!NAME.test(name)) throw new Error("invalid key name");
    return this.#pod("revoke", name);
  }

  async get(name) {
    return (await this.#pod("get", name)).find((c) => c.credentialId === name);
  }

  async list() {
    return this.#pod("list");
  }

  // Status code of /v1/key/inspect for a key: 200 while live, 401/403 once
  // revoked. The key goes only in the Authorization header.
  async inspectStatus(token) {
    const response = await this.#fetch(this.#config.routerOrigin + "/v1/key/inspect", {
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.status;
  }

  // Revoke, then prove it twice: the device list says disabled, and the
  // router refuses the old key.
  async revokeAndProve(name, token) {
    const proof = { name, revoked: false, listEnabled: null, inspectStatus: null, error: null };
    try {
      await this.revoke(name);
      proof.revoked = true;
      const entry = await this.get(name);
      proof.listEnabled = entry ? entry.enabled : null;
      if (token) proof.inspectStatus = await this.inspectStatus(token);
    } catch (error) {
      proof.error = String(error?.message ?? error);
    }
    proof.ok = proof.revoked && proof.listEnabled === false &&
      (token ? proof.inspectStatus === 401 || proof.inspectStatus === 403 : true);
    return proof;
  }
}
