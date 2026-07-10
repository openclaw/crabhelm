import assert from "node:assert/strict";
import test from "node:test";
import { childPolicyHash, createClawRecord } from "../src/domain.js";
import { CrabhelmRegistry } from "../src/registry.js";
import { createMemoryStateStore } from "../src/state.js";
import type { AuditEvent, ClawRecord } from "../src/types.js";

test("registry backfills disabled OpenTelemetry defaults on legacy claw records", async () => {
  const claws = createMemoryStateStore<ClawRecord>();
  const registry = new CrabhelmRegistry(claws, createMemoryStateStore<AuditEvent>());
  const current = createClawRecord({
    name: "Legacy child",
    owner: { subject: "github:legacy", label: "@legacy", source: "github" },
  });
  const legacy = structuredClone(current) as ClawRecord;
  delete (legacy.desired.observability as Partial<ClawRecord["desired"]["observability"]>).otel;
  delete (legacy.desired.inference as Partial<ClawRecord["desired"]["inference"]>).router;
  await claws.register(legacy.id, legacy);

  const restored = await registry.get(legacy.id);
  assert.deepEqual(restored.desired.observability.otel, current.desired.observability.otel);
  assert.deepEqual(restored.desired.inference.router, { kind: "direct" });
  assert.equal(childPolicyHash(restored), childPolicyHash(current));
  assert.deepEqual((await registry.list())[0]?.desired.observability.otel, current.desired.observability.otel);
});

test("registry backfills immutable project attribution on routed claw records", async () => {
  const claws = createMemoryStateStore<ClawRecord>();
  const registry = new CrabhelmRegistry(claws, createMemoryStateStore<AuditEvent>());
  const model = "clawrouter/openai/gpt-5.5";
  const current = createClawRecord({
    name: "Legacy routed child",
    owner: { subject: "github:legacy-router", label: "@legacy-router", source: "github" },
    inference: { model },
  }, new Date(), {
    clawRouter: {
      baseUrl: "https://clawrouter.example.test",
      tenantId: "fakeco",
      allowedProviders: ["openai"],
      modelProviders: { [model]: "openai" },
      defaultModel: model,
    },
  });
  const legacy = structuredClone(current);
  const router = legacy.desired.inference.router;
  assert.equal(router.kind, "clawrouter");
  if (router.kind !== "clawrouter") throw new Error("expected routed desired state");
  delete (router as Partial<typeof router>).projectId;
  await claws.register(legacy.id, legacy);

  const restored = await registry.get(legacy.id);
  assert.equal(restored.desired.inference.router.kind, "clawrouter");
  if (restored.desired.inference.router.kind !== "clawrouter") throw new Error("expected routed desired state");
  assert.equal(restored.desired.inference.router.projectId, legacy.id);
  assert.equal(childPolicyHash(restored), childPolicyHash(current));
  assert.equal((await registry.list())[0]?.desired.inference.router.kind, "clawrouter");
});
