import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createCrabhelmApiHandler } from "../src/http.js";
import { CrabboxChildCoreProvider, SimulatorChildCoreProvider } from "../src/providers.js";
import { CrabhelmReconciler } from "../src/reconciler.js";
import { CrabhelmRegistry } from "../src/registry.js";
import { createMemoryStateStore } from "../src/state.js";
import type { AuditEvent, ClawRecord } from "../src/types.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("reconcile API invalidates stored readiness when the workspace becomes inactive", async (t) => {
  const registry = new CrabhelmRegistry(createMemoryStateStore<ClawRecord>(), createMemoryStateStore<AuditEvent>());
  const created = await registry.create({ name: "Lifecycle proof", owner: { subject: "manual:proof", label: "Proof", source: "manual" } }, "test-admin");
  const evidence = await new SimulatorChildCoreProvider().provision(created);
  await registry.writeObserved(created.id, { ...created.observed, ...evidence, controlLink: evidence.controlLink! });
  let workspaceStatus: string | undefined = "ready";
  let nodeInspections = 0;
  const workspace = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: evidence.lifecycle.workspaceId, status: workspaceStatus }));
  });
  const workspaceUrl = await listen(workspace);
  const provider = new CrabboxChildCoreProvider({
    baseUrl: workspaceUrl,
    token: "synthetic-test-token",
    profile: created.desired.deployment.profile,
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 14_400,
    nodeControl: {
      async inspect() {
        nodeInspections++;
        return { ...evidence, status: "paired", gatewayReady: true, ingressDisabled: false };
      },
      async disable() { throw new Error("unexpected disable"); },
      async drain() { throw new Error("unexpected drain"); },
      async revokePairing() { throw new Error("unexpected revoke"); },
    },
  });
  const handler = createCrabhelmApiHandler({
    registry,
    reconciler: new CrabhelmReconciler(registry, provider),
    runtime: { mode: "crabbox", defaultTarget: "default", targets: [], githubImport: false, inference: { kind: "direct", defaultModel: created.desired.inference.model, metadataOnly: true } },
  });
  const api = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  try {
    const base = `${await listen(api)}/plugins/crabhelm/api`;
    for (const inactive of ["provisioning", "stopping", "expired", "unknown", "", undefined]) {
      workspaceStatus = "ready";
      const readyResponse = await fetch(`${base}/claws/${created.id}/reconcile`, { method: "POST" });
      assert.equal(readyResponse.status, 200);
      const ready = await readyResponse.json() as ClawRecord;
      assert.equal(ready.observed.phase, "ready");
      assert.equal(ready.observed.probes?.model.authReady, true);
      const before = nodeInspections;
      workspaceStatus = inactive;
      const response = await fetch(`${base}/claws/${created.id}/reconcile`, { method: "POST" });
      assert.equal(response.status, 200);
      const actual = await response.json() as ClawRecord;
      assert.equal(actual.observed.phase, "enrolling");
      assert.equal(actual.observed.health, "unknown");
      assert.equal(actual.observed.generation, 0);
      assert.equal(actual.observed.controlLink.status, "offline");
      assert.equal(actual.observed.controlLink.lastSeenAt, undefined);
      assert.equal(actual.observed.probes, undefined);
      assert.equal(actual.observed.configHash, undefined);
      assert.equal(actual.observed.gatewayVersion, undefined);
      assert.equal(actual.observed.lastSeenAt, undefined);
      assert.deepEqual(actual.observed.lifecycle, ready.observed.lifecycle);
      assert.equal(nodeInspections, before);
      const stateResponse = await fetch(`${base}/state`);
      const state = await stateResponse.json() as { claws: ClawRecord[]; summary: { ready: number } };
      assert.equal(state.summary.ready, 0);
      assert.deepEqual(state.claws[0].observed, actual.observed);
      t.diagnostic(`workspace=${JSON.stringify(inactive) ?? "missing"} phase=${actual.observed.phase} control=${actual.observed.controlLink.status} probes=absent generation=0 node-inspections-skipped=true`);
    }
    workspaceStatus = "running";
    const response = await fetch(`${base}/claws/${created.id}/reconcile`, { method: "POST" });
    const recovered = await response.json() as ClawRecord;
    assert.equal(recovered.observed.phase, "ready");
    assert.equal(recovered.observed.probes?.model.authReady, true);
  } finally {
    await close(api);
    await close(workspace);
  }
});
