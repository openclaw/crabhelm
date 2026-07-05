import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { slackIdentity } from "../src/slack-identity.js";
import { verifySlackRequest } from "../worker/slack-signature.js";
import { slackDeliveryRetryable } from "../worker/slack-delivery.js";
import { decryptTurnPayload, encryptTurnPayload } from "../worker/turn-envelope.js";

test("Slack request verification binds body, timestamp, and signing secret", async () => {
  const secret = "slack-signing-secret";
  const timestamp = 1_750_000_000;
  const body = new TextEncoder().encode('{"type":"url_verification","challenge":"proof"}');
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${new TextDecoder().decode(body)}`).digest("hex")}`;
  const headers = new Headers({ "x-slack-request-timestamp": String(timestamp), "x-slack-signature": signature });
  assert.equal(await verifySlackRequest(headers, body, secret, timestamp * 1000), true);
  assert.equal(await verifySlackRequest(headers, new TextEncoder().encode("tampered"), secret, timestamp * 1000), false);
  assert.equal(await verifySlackRequest(headers, body, "wrong-secret", timestamp * 1000), false);
  assert.equal(await verifySlackRequest(headers, body, secret, (timestamp + 301) * 1000), false);
});

test("turn payload encryption binds ciphertext to one job", async () => {
  const key = randomBytes(32).toString("base64url");
  const envelope = await encryptTurnPayload(key, "job-1", { prompt: "private prompt" });
  assert.doesNotMatch(envelope, /private prompt/u);
  assert.deepEqual(await decryptTurnPayload(key, "job-1", envelope), { prompt: "private prompt" });
  await assert.rejects(decryptTurnPayload(key, "job-2", envelope), /could not be decrypted/u);
});

test("Slack identity falls back to the signed workspace user without profile enrichment", () => {
  assert.deepEqual(slackIdentity("U012345"), { label: "U012345" });
});

test("Slack delivery retry policy terminates permanent errors", () => {
  assert.equal(slackDeliveryRetryable(429, "ratelimited"), true);
  assert.equal(slackDeliveryRetryable(503), true);
  assert.equal(slackDeliveryRetryable(200, "internal_error"), true);
  assert.equal(slackDeliveryRetryable(200, "channel_not_found"), false);
  assert.equal(slackDeliveryRetryable(401, "invalid_auth"), false);
});

// Runtime reconnect behaviour (stale socket evicted with close 4001 instead of
// rejecting the new bridge) is verified against the real Durable Object in
// workerd — see tests/workers/runtime-reconnect.test.ts.
