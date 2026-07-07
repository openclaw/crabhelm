import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createCrabhelmApiHandler } from "../src/http.js";
import { SimulatorChildCoreProvider } from "../src/providers.js";
import { CrabhelmReconciler } from "../src/reconciler.js";
import { CrabhelmRegistry } from "../src/registry.js";
import { createMemoryStateStore } from "../src/state.js";
import type { AuditEvent, ClawRecord, PolicyTemplate } from "../src/types.js";

function createRegistry() {
  return new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
    { policies: createMemoryStateStore<PolicyTemplate>() },
  );
}

const policySpec = {
  inference: { model: "openai/gpt-5.4-mini", fallbackModels: ["openai/gpt-5.5"] },
  slackEnabled: true,
  access: { dmPolicy: "pairing" as const, groupPolicy: "disabled" as const },
  observability: { logLevel: "warn" as const },
};

test("versioned policy preview and generation CAS apply desired state atomically", async () => {
  const registry = createRegistry();
  const first = await registry.create({
    name: "First",
    owner: { subject: "manual:first", label: "First", source: "manual" },
  }, "operator");
  const second = await registry.create({
    name: "Second",
    owner: { subject: "manual:second", label: "Second", source: "manual" },
  }, "operator");
  const policy = await registry.createPolicy({
    name: "Maintainers",
    description: "Managed inference, native access, and logging.",
    spec: policySpec,
  }, "operator");

  const preview = await registry.previewPolicy(policy.id, 1, [first.id, second.id]);
  assert.equal(preview.targets.length, 2);
  assert.ok(preview.targets.every((target) => target.changes.length > 0));
  await registry.update(first.id, { name: "First changed elsewhere" }, "operator");
  await assert.rejects(
    registry.applyPolicy(
      policy.id,
      1,
      [first.id, second.id],
      Object.fromEntries(preview.targets.map((target) => [target.clawId, target.expectedGeneration])),
      "operator",
    ),
    /preview is stale/,
  );
  assert.equal((await registry.get(second.id)).desired.inference.model, "openai/gpt-5.5");

  const fresh = await registry.previewPolicy(policy.id, 1, [first.id, second.id]);
  const applied = await registry.applyPolicy(
    policy.id,
    1,
    [first.id, second.id],
    Object.fromEntries(fresh.targets.map((target) => [target.clawId, target.expectedGeneration])),
    "operator",
  );
  assert.equal(applied.updated.length, 2);
  for (const claw of applied.updated) {
    assert.equal(claw.desired.templateId, policy.id);
    assert.equal(claw.desired.templateVersion, 1);
    assert.equal(claw.desired.inference.model, "openai/gpt-5.4-mini");
    assert.deepEqual(claw.desired.inference.fallbackModels, ["openai/gpt-5.5"]);
    assert.equal(claw.desired.channels.slack.enabled, true);
    assert.equal(claw.desired.access.groupPolicy, "disabled");
    assert.equal(claw.desired.observability.logLevel, "warn");
  }

  const v2 = await registry.addPolicyVersion(policy.id, {
    description: "A second immutable version.",
    spec: { ...policySpec, observability: { logLevel: "error" } },
  }, "operator");
  assert.deepEqual(v2.versions.map((version) => version.version), [1, 2]);
  assert.equal(v2.versions[0]?.spec.observability.logLevel, "warn");
});

test("policy version equality ignores persisted JSON object key order", async () => {
  const policies = createMemoryStateStore<PolicyTemplate>();
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
    { policies },
  );
  const policy = await registry.createPolicy({
    name: "Canonical",
    spec: policySpec,
  }, "operator");
  const persisted = await policies.lookup(policy.id);
  assert.ok(persisted);
  const latest = persisted.versions[0]!;
  await policies.register(policy.id, {
    ...persisted,
    versions: [{
      ...latest,
      spec: {
        observability: { logLevel: latest.spec.observability.logLevel },
        access: {
          groupPolicy: latest.spec.access.groupPolicy,
          dmPolicy: latest.spec.access.dmPolicy,
        },
        slackEnabled: latest.spec.slackEnabled,
        inference: {
          fallbackModels: latest.spec.inference.fallbackModels,
          model: latest.spec.inference.model,
        },
      },
    }],
  });

  await assert.rejects(
    registry.addPolicyVersion(policy.id, { spec: policySpec }, "operator"),
    /must change at least one managed field/u,
  );
});

test("policy API requires and verifies a converged canary before applying the remainder", async () => {
  const registry = createRegistry();
  const reconciler = new CrabhelmReconciler(registry, new SimulatorChildCoreProvider());
  const claws = await Promise.all(["Canary", "Remainder"].map(async (name) => {
    const claw = await registry.create({
      name,
      owner: { subject: `manual:${name.toLowerCase()}`, label: name, source: "manual" },
    }, "operator");
    return reconciler.reconcileOne(claw.id);
  }));
  const policy = await registry.createPolicy({ name: "Fleet", spec: policySpec }, "operator");
  const handler = createCrabhelmApiHandler({
    registry,
    reconciler,
    runtime: {
      mode: "simulator",
      defaultTarget: "default",
      targets: [{
        id: "default",
        label: "Default",
        profile: "openclaw-core",
        ttlSeconds: 14_400,
        idleTimeoutSeconds: 14_400,
        admissionOpen: true,
      }],
      githubImport: false,
    },
  });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/plugins/crabhelm/api/policies/${policy.id}`;
  try {
    const clawIds = claws.map((claw) => claw.id);
    const previewResponse = await fetch(`${base}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, clawIds }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as {
      targets: Array<{ clawId: string; expectedGeneration: number }>;
    };
    const expectedGenerations = Object.fromEntries(
      preview.targets.map((target) => [target.clawId, target.expectedGeneration]),
    );
    const missingCanary = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, clawIds, expectedGenerations }),
    });
    assert.equal(missingCanary.status, 422);
    assert.match((await missingCanary.json() as { error: string }).error, /canaryId is required/);

    const appliedResponse = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        clawIds,
        expectedGenerations,
        canaryId: clawIds[0],
      }),
    });
    assert.equal(appliedResponse.status, 202);
    const applied = await appliedResponse.json() as {
      aborted: boolean;
      results: Array<{ clawId: string; ok: boolean; canary: boolean }>;
    };
    assert.equal(applied.aborted, false);
    assert.equal(applied.results.length, 2);
    assert.deepEqual(applied.results.map((result) => result.ok), [true, true]);
    assert.equal(applied.results[0]?.canary, true);
    assert.equal((await registry.get(clawIds[1]!)).desired.templateVersion, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});
