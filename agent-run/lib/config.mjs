import { homedir } from "node:os";
import { join } from "node:path";
import { GRANT_REF } from "./clawrouter.mjs";

// Crabbox donors agent-run must never lease on. rp-kube-01 is a client
// production host (Luke, 2026-11-16: "ban it").
export const BANNED_CRABBOX_MACHINES = Object.freeze(["rp-kube-01"]);

// Fleet defaults. Each one has an environment override so the code stays
// generic; none of these values is a secret.
export function loadConfig(env = process.env) {
  const home = env.HOME || homedir();
  const commandTimeoutMs = Number(env.AGENT_RUN_COMMAND_TIMEOUT_MS || 75 * 60 * 1000);
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs <= 0) throw new Error("AGENT_RUN_COMMAND_TIMEOUT_MS must be a positive integer");
  // An empty but present value is refused: a missing variable must not silently drop the restriction.
  const openaiGrant = env.AGENT_RUN_OPENAI_GRANT;
  if (openaiGrant !== undefined && !GRANT_REF.test(openaiGrant)) throw new Error("AGENT_RUN_OPENAI_GRANT must be a ClawRouter token reference (1-256 characters, no '/' or control characters)");
  if (BANNED_CRABBOX_MACHINES.includes(env.AGENT_RUN_CRABBOX_MACHINE)) throw new Error("AGENT_RUN_CRABBOX_MACHINE=" + env.AGENT_RUN_CRABBOX_MACHINE + " is banned: it is a client production host");
  return {
    placementHelper: env.AGENT_RUN_PLACEMENT || join(home, "Projects/personal/harbor/bin/harbor-capacity-placement.mjs"),
    kubeContext: env.AGENT_RUN_KUBE_CONTEXT || "lue-kube",
    routerNamespace: env.AGENT_RUN_ROUTER_NAMESPACE || "clawrouter",
    routerDeployment: env.AGENT_RUN_ROUTER_DEPLOYMENT || "clawrouter",
    routerContainer: env.AGENT_RUN_ROUTER_CONTAINER || "clawrouter",
    // Laptop-reachable ClawRouter origin; the box reaches it only through
    // the SSH remote forward.
    routerOrigin: env.AGENT_RUN_ROUTER_ORIGIN || "http://clawrouter-lue.tail59faed.ts.net:8789",
    remotePort: Number(env.AGENT_RUN_REMOTE_PORT || 18789),
    crabboxProvider: env.AGENT_RUN_CRABBOX_PROVIDER || "serve",
    crabboxType: env.AGENT_RUN_CRABBOX_TYPE || "cpu2",
    crabboxMachine: env.AGENT_RUN_CRABBOX_MACHINE || undefined,
    serveProxyCommand: env.AGENT_RUN_SERVE_PROXY_COMMAND || undefined,
    commandTimeoutMs,
    // On serve leases a raw ssh session closes at the lease's idle timeout
    // even while "crabbox heartbeat" refreshes it (observed 2026-11-06), so
    // the idle timeout is the run budget. agent-run stops the lease itself;
    // these bound a lease left behind by a killed agent-run.
    leaseIdleTimeout: env.AGENT_RUN_LEASE_IDLE_TIMEOUT || "75m",
    leaseTtl: env.AGENT_RUN_LEASE_TTL || "90m",
    // Lease-side appliance cache, relative to the remote home. Crabbox serve
    // machines keep this directory between leases; "off" always uploads.
    remoteToolCache: env.AGENT_RUN_REMOTE_TOOL_CACHE === "off" ? undefined : env.AGENT_RUN_REMOTE_TOOL_CACHE || ".cache/crabbox-tools",
    cacheDir: env.AGENT_RUN_CACHE_DIR || join(home, ".cache/agent-run"),
    stateDir: env.AGENT_RUN_STATE_DIR || join(home, ".local/state/agent-run"),
    piModelsFile: env.AGENT_RUN_PI_MODELS || join(home, ".pi/agent/models.json"),
    piProvider: env.AGENT_RUN_PI_PROVIDER || "clawrouter",
    // Token reference of the only OpenAI grant the per-run key may bill.
    // Unset: the key may use any eligible grant, as before.
    openaiGrant,
  };
}
