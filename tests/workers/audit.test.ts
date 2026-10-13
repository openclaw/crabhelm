import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GovernanceAuditEvent } from "../../src/governance-types.js";
import worker from "../../worker/index.js";

afterEach(() => vi.restoreAllMocks());

function auditEnv(): Env {
  return { ...env, GITHUB_OAUTH_CLIENT_SECRET: "test-only-unused" };
}

function auditEvent(id: string): GovernanceAuditEvent {
  return {
    id,
    at: "2026-07-07T00:00:00.000Z",
    correlationId: `correlation-${id}`,
    action: "test.audit",
    outcome: "succeeded",
    summary: "metadata only — unchanged",
    details: { count: 2 },
  };
}

function batchOf(messages: Array<[string, unknown]>) {
  return createMessageBatch("crabhelm-audit-example", messages.map(([id, body]) => ({
    id, body, timestamp: new Date(0), attempts: 1,
  })));
}

function keyFor(event: GovernanceAuditEvent): string {
  return `${event.at.slice(0, 10)}/${event.at}-${event.id}.json`;
}

describe("audit queue consumer in workerd", () => {
  it("retries malformed and failed writes without skipping valid batch siblings", async () => {
    const first = auditEvent("first");
    const retry = auditEvent("retry");
    const last = auditEvent("last");
    const put = env.AUDIT_ARCHIVE.put.bind(env.AUDIT_ARCHIVE);
    vi.spyOn(env.AUDIT_ARCHIVE, "put").mockImplementation(async (key, body, options) => {
      if (key === keyFor(retry)) throw new Error("archive unavailable");
      return put(key, body, options);
    });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const batch = batchOf([
      ["first", first], ["missing", {}], ["retry", retry],
      ["wrong-type", { ...retry, at: 42 }], ["last", last],
    ]);
    const ctx = createExecutionContext();

    await worker.queue(batch, auditEnv());

    expect(await getQueueResult(batch, ctx)).toMatchObject({
      ackAll: false,
      retryBatch: { retry: false },
      explicitAcks: ["first", "last"],
      retryMessages: [{ msgId: "missing" }, { msgId: "retry" }, { msgId: "wrong-type" }],
    });
    expect(await (await env.AUDIT_ARCHIVE.get(keyFor(first)))?.text()).toBe(JSON.stringify(first));
    expect(await (await env.AUDIT_ARCHIVE.get(keyFor(last)))?.text()).toBe(JSON.stringify(last));
    expect(await env.AUDIT_ARCHIVE.get(keyFor(retry))).toBeNull();
    expect(diagnostic.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { event: "audit_archive_failed", messageId: "missing", attempts: 1 },
      { event: "audit_archive_failed", messageId: "retry", attempts: 1 },
      { event: "audit_archive_failed", messageId: "wrong-type", attempts: 1 },
    ]);
  });

  it("does not acknowledge until the archive write resolves", async () => {
    const event = auditEvent("pending");
    const put = env.AUDIT_ARCHIVE.put.bind(env.AUDIT_ARCHIVE);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(env.AUDIT_ARCHIVE, "put").mockImplementation(async (key, body, options) => {
      started.resolve();
      await release.promise;
      return put(key, body, options);
    });
    const batch = batchOf([["pending", event]]);
    const ctx = createExecutionContext();
    const running = worker.queue(batch, auditEnv());
    await started.promise;
    try {
      expect(await getQueueResult(batch, ctx)).toMatchObject({ explicitAcks: [], retryMessages: [] });
    } finally {
      release.resolve();
      await running;
    }
    expect(await getQueueResult(batch, ctx)).toMatchObject({ explicitAcks: ["pending"], retryMessages: [] });
    expect(await (await env.AUDIT_ARCHIVE.get(keyFor(event)))?.text()).toBe(JSON.stringify(event));
  });

  it("replays to the same R2 key with unchanged JSON and metadata", async () => {
    const event = auditEvent("replay");
    for (const id of ["delivery-1", "delivery-2"]) {
      const batch = batchOf([[id, event]]);
      await worker.queue(batch, auditEnv());
      expect(await getQueueResult(batch, createExecutionContext())).toMatchObject({
        explicitAcks: [id], retryMessages: [],
      });
    }
    const key = keyFor(event);
    expect((await env.AUDIT_ARCHIVE.list({ prefix: key })).objects.map((object) => object.key)).toEqual([key]);
    const object = await env.AUDIT_ARCHIVE.get(key);
    expect(await object?.text()).toBe(JSON.stringify(event));
    expect(object?.httpMetadata?.contentType).toBe("application/json");
    expect(object?.customMetadata).toEqual({
      classification: "audit-metadata", correlationId: event.correlationId,
    });
  });
});
