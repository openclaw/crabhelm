import assert from "node:assert/strict";
import test from "node:test";
import { SimulatorChildCoreProvider, type ChildCoreProvider } from "../src/providers.js";
import { operationalError } from "../src/errors.js";
import { CrabhelmReconciler } from "../src/reconciler.js";
import { CrabhelmRegistry } from "../src/registry.js";
import { createMemoryStateStore } from "../src/state.js";
import type { AuditEvent, ClawRecord } from "../src/types.js";

function fixture() {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  return {
    registry,
    reconciler: new CrabhelmReconciler(registry, new SimulatorChildCoreProvider()),
  };
}

test("provisions one child Gateway and pairs the parent control identity", async () => {
  const { registry, reconciler } = fixture();
  const created = await registry.create(
    {
      name: "Mina",
      owner: { subject: "github:mina", label: "@mina", source: "github" },
    },
    "test-admin",
  );

  const ready = await reconciler.reconcileOne(created.id);
  assert.equal(ready.observed.phase, "ready");
  assert.equal(ready.observed.generation, ready.desired.generation);
  assert.equal(ready.observed.controlLink.status, "paired");
  assert.equal(ready.observed.probes?.model.authReady, true);
  assert.equal(ready.observed.probes?.diagnostics.contentCaptured, false);
  assert.match(ready.observed.lifecycle?.workspaceId ?? "", /^crabhelm-/);
  assert.equal((await registry.snapshot()).summary.ready, 1);
});

test("disable retains provider identity and removal requires typed confirmation", async () => {
  const { registry, reconciler } = fixture();
  const created = await registry.create(
    {
      name: "Ops Claw",
      owner: { subject: "github:ops", label: "@ops", source: "github" },
    },
    "test-admin",
  );
  const ready = await reconciler.reconcileOne(created.id);
  await registry.setEnabled(ready.id, false, "test-admin");
  const disabled = await reconciler.reconcileOne(ready.id);
  assert.equal(disabled.observed.phase, "disabled");
  assert.ok(disabled.observed.lifecycle);

  await assert.rejects(
    registry.requestRemoval(ready.id, "test-admin", "wrong-name"),
    /typed confirmation/,
  );
  await registry.requestRemoval(ready.id, "test-admin", "Ops Claw");
  const duplicateRemoval = await registry.requestRemoval(ready.id, "test-admin", "Ops Claw");
  assert.equal(duplicateRemoval.desired.generation, ready.desired.generation + 2);
  const staged = await reconciler.reconcileOne(ready.id);
  assert.equal(staged.observed.phase, "deleting");
  assert.equal(staged.observed.deletion?.stage, "drain");
  const drainStarted = await reconciler.reconcileOne(ready.id);
  assert.equal(drainStarted.observed.deletion?.stage, "drain");
  assert.ok(drainStarted.observed.deletion?.drainedAt);
  await registry.writeObserved(ready.id, {
    ...drainStarted.observed,
    deletion: {
      ...drainStarted.observed.deletion!,
      drainedAt: new Date(Date.now() - 6_000).toISOString(),
    },
  });
  const releaseReady = await reconciler.reconcileOne(ready.id);
  assert.equal(releaseReady.observed.deletion?.stage, "release");
  const providerAbsent = await reconciler.reconcileOne(ready.id);
  assert.equal(providerAbsent.observed.deletion?.stage, "revoke");
  const deleted = await reconciler.reconcileOne(ready.id);
  assert.equal(deleted.observed.phase, "deleted");
  assert.equal(deleted.observed.controlLink.status, "revoked");
});

test("duplicate active slugs fail without overwriting the first child", async () => {
  const { registry } = fixture();
  const input = {
    name: "Same Name",
    owner: { subject: "github:first", label: "@first", source: "github" as const },
  };
  await registry.create(input, "test-admin");
  await assert.rejects(
    registry.create(
      { ...input, owner: { subject: "github:second", label: "@second", source: "github" } },
      "test-admin",
    ),
    /already exists/,
  );
  assert.equal((await registry.list()).length, 1);
});

test("registry no-op updates do not churn generation or audit", async () => {
  const { registry } = fixture();
  const created = await registry.create(
    {
      name: "Stable",
      owner: { subject: "github:stable", label: "@stable", source: "github" },
    },
    "test-admin",
  );
  const before = await registry.snapshot();
  const updated = await registry.update(created.id, { name: "Stable" }, "test-admin");
  const after = await registry.snapshot();
  assert.equal(updated.desired.generation, 1);
  assert.equal(after.events.length, before.events.length);
});

test("deployment placement is immutable after provider allocation", async () => {
  const { registry, reconciler } = fixture();
  const created = await registry.create(
    {
      name: "Placed",
      owner: { subject: "github:placed", label: "@placed", source: "github" },
    },
    "test-admin",
  );
  await reconciler.reconcileOne(created.id);
  await assert.rejects(
    registry.update(
      created.id,
      { deployment: { profile: "openclaw-core-large" } },
      "test-admin",
    ),
    /immutable/,
  );
});

test("registry placement fence rejects unreviewed target tuples before persistence", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
    {
      deploymentTargets: { default: { profile: "openclaw-core", region: "us-west" } },
      defaultDeployment: { target: "default", profile: "openclaw-core", region: "us-west" },
    },
  );
  await assert.rejects(
    registry.create(
      {
        name: "Unreviewed",
        owner: { subject: "github:unreviewed", label: "@unreviewed", source: "github" },
        deployment: { target: "default", profile: "other-profile", region: "us-west" },
      },
      "test-admin",
    ),
    /must be openclaw-core/,
  );
  assert.equal((await registry.list()).length, 0);
  const allowed = await registry.create(
    {
      name: "Reviewed",
      owner: { subject: "github:reviewed", label: "@reviewed", source: "github" },
    },
    "test-admin",
  );
  assert.deepEqual(allowed.desired.deployment, {
    target: "default",
    profile: "openclaw-core",
    region: "us-west",
  });
  await assert.rejects(
    registry.update(
      allowed.id,
      { deployment: { profile: "other-profile" } },
      "test-admin",
    ),
    /must be openclaw-core/,
  );
});

test("removal never releases a provider resource when child disable is unproven", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const simulator = new SimulatorChildCoreProvider();
  let removeCalls = 0;
  const provider: ChildCoreProvider = {
    provision: (claw) => simulator.provision(claw),
    inspect: (claw) => simulator.inspect(claw),
    async disable(claw) {
      return {
        applied: false,
        health: "unknown",
        message: "No enrolled control link",
        lifecycle: claw.observed.lifecycle,
      };
    },
    async drain() {
      return {
        drained: true,
        activeRuns: 0,
        checkedAt: new Date().toISOString(),
        message: "drained",
      };
    },
    async remove() {
      removeCalls += 1;
      return { absent: true, message: "removed" };
    },
    async revokeControl() {
      return {
        removedPairedDevice: true,
        rejectedPendingRequest: false,
        alreadyAbsent: false,
        message: "revoked",
      };
    },
  };
  const reconciler = new CrabhelmReconciler(registry, provider);
  const created = await registry.create(
    {
      name: "Guarded",
      owner: { subject: "github:guarded", label: "@guarded", source: "github" },
    },
    "test-admin",
  );
  await reconciler.reconcileOne(created.id);
  await registry.requestRemoval(created.id, "test-admin", "Guarded");

  const result = await reconciler.reconcileOne(created.id);
  assert.equal(result.observed.phase, "attention");
  assert.equal(result.observed.deletion?.stage, "disable");
  assert.equal(removeCalls, 0);
});

test("removal never releases a provider resource while child runs are active", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const simulator = new SimulatorChildCoreProvider();
  let removeCalls = 0;
  const provider: ChildCoreProvider = {
    provision: (claw) => simulator.provision(claw),
    inspect: (claw) => simulator.inspect(claw),
    disable: (claw) => simulator.disable(claw),
    async drain() {
      return {
        drained: false,
        activeRuns: 1,
        checkedAt: new Date().toISOString(),
        message: "Waiting for 1 active child agent run",
      };
    },
    async remove() {
      removeCalls += 1;
      return { absent: true, message: "removed" };
    },
    revokeControl: (claw) => simulator.revokeControl(claw),
  };
  const reconciler = new CrabhelmReconciler(registry, provider);
  const created = await registry.create(
    {
      name: "Busy",
      owner: { subject: "github:busy", label: "@busy", source: "github" },
    },
    "test-admin",
  );
  await reconciler.reconcileOne(created.id);
  await registry.requestRemoval(created.id, "test-admin", "Busy");
  await reconciler.reconcileOne(created.id);

  const waiting = await reconciler.reconcileOne(created.id);
  assert.equal(waiting.observed.phase, "deleting");
  assert.equal(waiting.observed.deletion?.stage, "drain");
  assert.equal(waiting.observed.deletion?.drainedAt, undefined);
  assert.equal(removeCalls, 0);
});

test("quiet drain period starts only after a slow first zero-run probe completes", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const simulator = new SimulatorChildCoreProvider();
  let firstDrain = true;
  let nowMs = 0;
  const provider: ChildCoreProvider = {
    provision: (claw) => simulator.provision(claw),
    inspect: (claw) => simulator.inspect(claw),
    disable: (claw) => simulator.disable(claw),
    async drain(claw) {
      if (firstDrain) {
        firstDrain = false;
        nowMs = 10_000;
      }
      return simulator.drain(claw);
    },
    remove: (claw) => simulator.remove(claw),
    revokeControl: (claw) => simulator.revokeControl(claw),
  };
  const reconciler = new CrabhelmReconciler(registry, provider, {
    drainQuietPeriodMs: 5_000,
    now: () => new Date(nowMs),
  });
  const created = await registry.create(
    {
      name: "Slow drain",
      owner: { subject: "github:slow-drain", label: "@slow", source: "github" },
    },
    "test-admin",
  );
  await reconciler.reconcileOne(created.id);
  await registry.requestRemoval(created.id, "test-admin", "Slow drain");
  await reconciler.reconcileOne(created.id);

  const firstZero = await reconciler.reconcileOne(created.id);
  assert.equal(firstZero.observed.deletion?.stage, "drain");
  const immediateSecondZero = await reconciler.reconcileOne(created.id);
  assert.equal(immediateSecondZero.observed.deletion?.stage, "drain");
  assert.match(immediateSecondZero.observed.message, /quiet drain period is still in progress/);
});

test("concurrent reconciliation serializes destructive stages per claw", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const simulator = new SimulatorChildCoreProvider();
  let disableCalls = 0;
  const provider: ChildCoreProvider = {
    provision: (claw) => simulator.provision(claw),
    inspect: (claw) => simulator.inspect(claw),
    async disable(claw) {
      disableCalls += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return simulator.disable(claw);
    },
    drain: (claw) => simulator.drain(claw),
    remove: (claw) => simulator.remove(claw),
    revokeControl: (claw) => simulator.revokeControl(claw),
  };
  const reconciler = new CrabhelmReconciler(registry, provider);
  const created = await registry.create(
    {
      name: "Serialized",
      owner: { subject: "github:serialized", label: "@serialized", source: "github" },
    },
    "test-admin",
  );
  await reconciler.reconcileOne(created.id);
  await registry.requestRemoval(created.id, "test-admin", "Serialized");

  const [disabled, draining] = await Promise.all([
    reconciler.reconcileOne(created.id),
    reconciler.reconcileOne(created.id),
  ]);
  assert.equal(disableCalls, 1);
  assert.equal(disabled.observed.deletion?.stage, "drain");
  assert.equal(draining.observed.deletion?.stage, "drain");
  assert.ok(draining.observed.deletion?.drainedAt);
});

test("stale reconciliation cannot erase a concurrent removal request", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const simulator = new SimulatorChildCoreProvider();
  let releaseInspect!: () => void;
  let inspectStarted!: () => void;
  const inspectGate = new Promise<void>((resolve) => { releaseInspect = resolve; });
  const started = new Promise<void>((resolve) => { inspectStarted = resolve; });
  let pauseInspect = false;
  const provider: ChildCoreProvider = {
    provision: (claw) => simulator.provision(claw),
    async inspect(claw) {
      if (pauseInspect) {
        inspectStarted();
        await inspectGate;
      }
      return simulator.inspect(claw);
    },
    disable: (claw) => simulator.disable(claw),
    drain: (claw) => simulator.drain(claw),
    remove: (claw) => simulator.remove(claw),
    revokeControl: (claw) => simulator.revokeControl(claw),
  };
  const reconciler = new CrabhelmReconciler(registry, provider);
  const created = await registry.create(
    {
      name: "CAS guarded",
      owner: { subject: "github:cas", label: "@cas", source: "github" },
    },
    "test-admin",
  );
  await reconciler.reconcileOne(created.id);
  pauseInspect = true;
  const staleReconcile = reconciler.reconcileOne(created.id);
  await started;
  const removal = await registry.requestRemoval(created.id, "test-admin", "CAS guarded");
  releaseInspect();

  const result = await staleReconcile;
  assert.equal(result.revision, removal.revision);
  assert.equal(result.observed.phase, "deleting");
  assert.equal(result.observed.deletion?.stage, "disable");
});

test("provider expiry during drain advances to retryable native pairing cleanup", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const simulator = new SimulatorChildCoreProvider();
  let absent = false;
  let drainCalls = 0;
  const provider: ChildCoreProvider = {
    provision: (claw) => simulator.provision(claw),
    inspect: (claw) => absent
      ? Promise.resolve({ absent: true, message: "Lease expired" })
      : simulator.inspect(claw),
    disable: (claw) => simulator.disable(claw),
    async drain(claw) {
      drainCalls += 1;
      return simulator.drain(claw);
    },
    remove: (claw) => simulator.remove(claw),
    revokeControl: (claw) => simulator.revokeControl(claw),
  };
  const reconciler = new CrabhelmReconciler(registry, provider);
  const created = await registry.create(
    {
      name: "Expired while draining",
      owner: { subject: "github:expired-drain", label: "@expired", source: "github" },
    },
    "test-admin",
  );
  await reconciler.reconcileOne(created.id);
  await registry.requestRemoval(created.id, "test-admin", "Expired while draining");
  const draining = await reconciler.reconcileOne(created.id);
  assert.equal(draining.observed.deletion?.stage, "drain");
  absent = true;

  const revoke = await reconciler.reconcileOne(created.id);
  assert.equal(revoke.observed.deletion?.stage, "revoke");
  assert.equal(drainCalls, 0);
  const deleted = await reconciler.reconcileOne(created.id);
  assert.equal(deleted.observed.phase, "deleted");
});

test("terminal provider absence completes removal without a live child node", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const simulator = new SimulatorChildCoreProvider();
  let absent = false;
  let disableCalls = 0;
  let revokeCalls = 0;
  const provider: ChildCoreProvider = {
    provision: (claw) => simulator.provision(claw),
    async inspect(claw) {
      return absent ? { absent: true, message: "Provider already absent" } : simulator.inspect(claw);
    },
    async disable() {
      disableCalls += 1;
      throw new Error("node offline");
    },
    async drain() {
      throw new Error("not used");
    },
    async remove() {
      return { absent: true, message: "already absent" };
    },
    async revokeControl() {
      revokeCalls += 1;
      return {
        removedPairedDevice: false,
        rejectedPendingRequest: false,
        alreadyAbsent: true,
        message: "Native parent pairing already absent",
      };
    },
  };
  const reconciler = new CrabhelmReconciler(registry, provider);
  const created = await registry.create(
    {
      name: "Expired",
      owner: { subject: "github:expired", label: "@expired", source: "github" },
    },
    "test-admin",
  );
  await reconciler.reconcileOne(created.id);
  await registry.requestRemoval(created.id, "test-admin", "Expired");
  absent = true;

  const providerAbsent = await reconciler.reconcileOne(created.id);
  assert.equal(providerAbsent.observed.phase, "deleting");
  assert.equal(providerAbsent.observed.deletion?.stage, "revoke");
  const deleted = await reconciler.reconcileOne(created.id);
  assert.equal(deleted.observed.phase, "deleted");
  assert.equal(disableCalls, 0);
  assert.equal(revokeCalls, 1);
});

test("removal stays retryable when native pairing cleanup returns no absence evidence", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const simulator = new SimulatorChildCoreProvider();
  const provider: ChildCoreProvider = {
    provision: (claw) => simulator.provision(claw),
    async inspect() {
      return { absent: true, message: "Provider absent" };
    },
    disable: (claw) => simulator.disable(claw),
    drain: (claw) => simulator.drain(claw),
    remove: (claw) => simulator.remove(claw),
    async revokeControl() {
      return {
        removedPairedDevice: false,
        rejectedPendingRequest: false,
        alreadyAbsent: false,
        message: "No evidence",
      };
    },
  };
  const reconciler = new CrabhelmReconciler(registry, provider);
  const created = await registry.create(
    {
      name: "Unproven revoke",
      owner: { subject: "github:unproven", label: "@unproven", source: "github" },
    },
    "test-admin",
  );
  await reconciler.reconcileOne(created.id);
  await registry.requestRemoval(created.id, "test-admin", "Unproven revoke");
  await reconciler.reconcileOne(created.id);

  const result = await reconciler.reconcileOne(created.id);
  assert.equal(result.observed.phase, "attention");
  assert.equal(result.observed.deletion?.stage, "revoke");
  assert.match(result.observed.message, /CHILD_REMOVAL_FAILED/);
});

test("reconciler persists allowlisted operator diagnostics without opaque causes", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const provider: ChildCoreProvider = {
    async provision() {
      throw operationalError(
        "CRABBOX_CREATE_HTTP",
        "Crabbox create failed (HTTP 503)",
        new Error("authorization=secret-value"),
      );
    },
    async inspect() {
      return { absent: true };
    },
    async disable() {
      throw new Error("not used");
    },
    async drain() {
      throw new Error("not used");
    },
    async remove() {
      return { absent: true, message: "not used" };
    },
    async revokeControl() {
      throw new Error("not used");
    },
  };
  const reconciler = new CrabhelmReconciler(registry, provider);
  const created = await registry.create(
    {
      name: "Safe diagnostics",
      owner: { subject: "manual:safe", label: "Safe", source: "manual" },
    },
    "test-admin",
  );

  const result = await reconciler.reconcileOne(created.id);
  assert.equal(
    result.observed.message,
    "Crabbox create failed (HTTP 503) [CRABBOX_CREATE_HTTP]",
  );
  assert.equal(result.observed.message.includes("secret-value"), false);
  const failure = (await registry.snapshot()).events.find(
    (event) => event.action === "claw.reconcile" && event.outcome === "failed",
  );
  assert.deepEqual(failure?.details, { code: "CRABBOX_CREATE_HTTP" });
});
