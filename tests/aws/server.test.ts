import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { createAwsHttpServer } from "../../aws/server.js";

test("AWS HTTP server accepts ALB's bounded OIDC header envelope", async (t) => {
  const server = createAwsHttpServer((incoming, outgoing) => {
    assert.equal(incoming.headers["x-amzn-oidc-data"]?.length, 24 * 1024);
    outgoing.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port: address.port,
      path: "/api/state",
      headers: {
        "x-amzn-oidc-data": "d".repeat(24 * 1024),
        "x-amzn-oidc-accesstoken": "a".repeat(20 * 1024),
        cookie: `session=${"c".repeat(8 * 1024)}`,
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({
        status: incoming.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });

  assert.deepEqual(response, { status: 200, body: "ok" });
});
