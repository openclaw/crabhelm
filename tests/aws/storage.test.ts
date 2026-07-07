import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { AuditQueuePoller } from "../../aws/audit-poller.js";
import { LocalAssetsFetcher } from "../../aws/local-assets.js";
import { AwsS3Bucket } from "../../aws/s3-bucket.js";
import { archiveAuditBatch, AwsSqsQueue } from "../../aws/sqs-queue.js";

test("S3 adapter preserves bodies and metadata", async () => {
  const client = new FakeS3Client();
  const bucket = new AwsS3Bucket(client as unknown as S3Client, "test-bucket", { kmsKeyId: "test-key" });

  await bucket.put("objects/one.txt", "hello", {
    httpMetadata: { contentType: "text/plain", cacheControl: "no-store" },
    customMetadata: { classification: "test" },
  });
  const object = await bucket.get("objects/one.txt");
  assert.ok(object);
  assert.equal(await object.text(), "hello");
  assert.equal(object.httpEtag, '"etag"');
  assert.equal(object.etag, "etag");
  assert.equal(object.httpMetadata.contentType, "text/plain");
  assert.deepEqual(object.customMetadata, { classification: "test" });

  const streamed = await bucket.get("objects/one.txt");
  assert.ok(streamed);
  assert.equal(await new Response(streamed.body).text(), "hello");

  await bucket.delete("objects/one.txt");
  assert.equal(await bucket.get("objects/one.txt"), null);
  assert.equal(client.lastPut?.ServerSideEncryption, "aws:kms");
});

test("SQS adapter serializes JSON and audit consumer reports partial failures", async () => {
  const client = new FakeSqsClient();
  const queue = new AwsSqsQueue(client as unknown as SQSClient, "https://sqs.example/test");
  await queue.send({ ok: true }, { contentType: "json", delaySeconds: 10 });
  assert.equal(client.messages[0]?.MessageBody, '{"ok":true}');
  assert.equal(client.messages[0]?.DelaySeconds, 10);

  const archived: string[] = [];
  const result = await archiveAuditBatch({ Records: [
    { messageId: "good", body: JSON.stringify(auditEvent("one")) },
    { messageId: "invalid", body: "not-json" },
    { messageId: "retry", body: JSON.stringify(auditEvent("two")) },
  ] }, {
    async put(key) {
      if (key.includes("-two.json")) throw new Error("S3 unavailable");
      archived.push(key);
    },
  });
  assert.equal(archived.length, 1);
  assert.deepEqual(result, { batchItemFailures: [
    { itemIdentifier: "invalid" },
    { itemIdentifier: "retry" },
  ] });
});

test("ECS audit poller retains malformed and archive-failed messages for DLQ redrive", async () => {
  const client = new FakeAuditPollClient([
    { MessageId: "good", ReceiptHandle: "receipt-good", Body: JSON.stringify(auditEvent("one")) },
    { MessageId: "invalid", ReceiptHandle: "receipt-invalid", Body: "not-json" },
    { MessageId: "retry", ReceiptHandle: "receipt-retry", Body: JSON.stringify(auditEvent("two")) },
  ]);
  const poller = new AuditQueuePoller(client as unknown as SQSClient, "https://sqs.example/audit", {
    async put(key) {
      if (key.includes("-two.json")) throw new Error("S3 unavailable");
    },
  });

  assert.deepEqual(await poller.pollOnce(), { received: 3, deleted: 1, retained: 2 });
  assert.deepEqual(client.deletedReceipts, ["receipt-good"]);
});

test("ECS audit poller stop aborts an active long poll", async () => {
  const client = new BlockingAuditPollClient();
  const poller = new AuditQueuePoller(client as unknown as SQSClient, "https://sqs.example/audit", {
    async put() {},
  });
  poller.start();
  assert.equal(poller.running, true);
  await poller.stop();
  assert.equal(poller.running, false);
});

test("local assets serve files, SPA fallback, HEAD, and reject traversal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crabhelm-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "index.html"), "<h1>console</h1>");
  await writeFile(path.join(root, "app.js"), "export {};");
  const assets = new LocalAssetsFetcher(root);

  const script = await assets.fetch(new Request("https://console.example/app.js"));
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await script.text(), "export {};");

  const fallback = await assets.fetch(new Request("https://console.example/settings/profile"));
  assert.equal(await fallback.text(), "<h1>console</h1>");

  const head = await assets.fetch(new Request("https://console.example/", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const traversal = await assets.fetch(new Request("https://console.example/%2e%2e%2f%2e%2e%2fetc/passwd"));
  assert.equal(traversal.status, 404);
});

function auditEvent(id: string) {
  return {
    id,
    at: "2026-07-07T00:00:00.000Z",
    correlationId: `correlation-${id}`,
    action: "test.audit",
    outcome: "succeeded",
    summary: "test event",
  };
}

class FakeS3Client {
  readonly objects = new Map<string, { bytes: Uint8Array; input: Record<string, unknown> }>();
  lastPut?: Record<string, unknown>;

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const key = String(command.input.Key ?? "");
    if (command.constructor.name === "PutObjectCommand") {
      const bytes = new TextEncoder().encode(String(command.input.Body ?? ""));
      this.lastPut = command.input;
      this.objects.set(key, { bytes, input: command.input });
      return { ETag: '"etag"' };
    }
    if (command.constructor.name === "DeleteObjectCommand") {
      this.objects.delete(key);
      return {};
    }
    const object = this.objects.get(key);
    if (!object) {
      const error = new Error("missing") as Error & { name: string; $metadata: { httpStatusCode: number } };
      error.name = "NoSuchKey";
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    return {
      Body: {
        transformToWebStream: () => new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(object.bytes);
            controller.close();
          },
        }),
      },
      ETag: '"etag"',
      ContentLength: object.bytes.byteLength,
      ContentType: object.input.ContentType,
      CacheControl: object.input.CacheControl,
      Metadata: object.input.Metadata,
    };
  }
}

class FakeSqsClient {
  readonly messages: Record<string, unknown>[] = [];

  async send(command: { input: Record<string, unknown> }): Promise<Record<string, unknown>> {
    this.messages.push(command.input);
    return { MessageId: "message-1" };
  }
}

class FakeAuditPollClient {
  readonly deletedReceipts: string[] = [];
  readonly #messages: Array<{ MessageId: string; ReceiptHandle: string; Body: string }>;

  constructor(messages: Array<{ MessageId: string; ReceiptHandle: string; Body: string }>) {
    this.#messages = messages;
  }

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>> {
    if (command.constructor.name === "ReceiveMessageCommand") return { Messages: this.#messages };
    const entries = command.input.Entries as Array<{ Id: string; ReceiptHandle: string }>;
    this.deletedReceipts.push(...entries.map((entry) => entry.ReceiptHandle));
    return { Successful: entries.map((entry) => ({ Id: entry.Id })) };
  }
}

class BlockingAuditPollClient {
  async send(
    command: { constructor: { name: string } },
    options?: { abortSignal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    assert.equal(command.constructor.name, "ReceiveMessageCommand");
    return new Promise((resolve, reject) => {
      const signal = options?.abortSignal;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  }
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
