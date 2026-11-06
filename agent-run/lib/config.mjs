import { homedir } from "node:os";
import { join } from "node:path";

// Fleet defaults. Each one has an environment override so the code stays
// generic; none of these values is a secret.
export function loadConfig(env = process.env) {
  const home = env.HOME || homedir();
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
    // On serve leases a raw ssh session closes at the lease's idle timeout
    // even while "crabbox heartbeat" refreshes it (observed 2026-11-06), so
    // the idle timeout is the run budget. agent-run stops the lease itself;
    // these bound a lease left behind by a killed agent-run.
    leaseIdleTimeout: env.AGENT_RUN_LEASE_IDLE_TIMEOUT || "75m",
    leaseTtl: env.AGENT_RUN_LEASE_TTL || "90m",
    cacheDir: env.AGENT_RUN_CACHE_DIR || join(home, ".cache/agent-run"),
    stateDir: env.AGENT_RUN_STATE_DIR || join(home, ".local/state/agent-run"),
    piModelsFile: env.AGENT_RUN_PI_MODELS || join(home, ".pi/agent/models.json"),
    piProvider: env.AGENT_RUN_PI_PROVIDER || "clawrouter",
  };
}
