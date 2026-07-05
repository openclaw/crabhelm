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
  await claws.register(legacy.id, legacy);

  const restored = await registry.get(legacy.id);
  assert.deepEqual(restored.desired.observability.otel, current.desired.observability.otel);
  assert.equal(childPolicyHash(restored), childPolicyHash(current));
  assert.deepEqual((await registry.list())[0]?.desired.observability.otel, current.desired.observability.otel);
});
