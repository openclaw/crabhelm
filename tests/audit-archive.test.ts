import assert from "node:assert/strict";
import test from "node:test";
import { archiveAuditEvent } from "../src/audit-archive.js";

const event = {
  id: "event-1",
  at: "2026-07-07T00:00:00.000Z",
  correlationId: "correlation-1",
  action: "test.audit",
  outcome: "succeeded",
  summary: "test event",
};

test("audit validation rejects malformed bodies before writing", async () => {
  const invalid = [
    null, [], "event", {},
    { ...event, id: "../event" },
    { ...event, at: 42 },
    { ...event, at: "2026-07-07T../event" },
    { ...event, correlationId: "" },
    { ...event, action: null },
    { ...event, summary: null },
    { ...event, outcome: "unknown" },
    { ...event, outcome: ["succeeded"] },
  ];
  let writes = 0;
  for (const value of invalid) {
    await assert.rejects(archiveAuditEvent(value, {
      async put() { writes++; },
    }), /audit message is malformed/u);
  }
  assert.equal(writes, 0);
});

test("audit archive preserves the original event and propagates write failure", async () => {
  const failure = new Error("archive unavailable");
  const value = { ...event, details: { count: 2 }, summary: "metadata only — unchanged" };
  await assert.rejects(archiveAuditEvent(value, {
    async put(key, body, options) {
      assert.equal(key, "2026-07-07/2026-07-07T00:00:00.000Z-event-1.json");
      assert.equal(body, JSON.stringify(value));
      assert.deepEqual(options, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { classification: "audit-metadata", correlationId: "correlation-1" },
      });
      throw failure;
    },
  }), (error) => error === failure);
});
