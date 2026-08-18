import assert from "node:assert/strict";
import test from "node:test";
import { waitForConfirmation } from "../src/governed-confirmation.js";

test("waitForConfirmation aborts during poll sleep instead of waiting to expire", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  let polls = 0;
  globalThis.fetch = (async () => {
    polls += 1;
    return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
  }) as typeof fetch;

  const controller = new AbortController();
  const pending = waitForConfirmation(
    "https://crabhelm.example.test",
    "turn-token",
    "confirmation-1",
    controller.signal,
  );

  let outcome: { settled: "fulfilled"; status: string } | { settled: "rejected"; error: unknown } | undefined;
  pending.then(
    (status) => {
      outcome = { settled: "fulfilled", status };
    },
    (error) => {
      outcome = { settled: "rejected", error };
    },
  );

  for (let i = 0; i < 20 && polls < 1; i += 1) await Promise.resolve();
  assert.equal(polls, 1);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();

  controller.abort();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();

  assert.ok(outcome, "expected confirmation wait to settle when aborted during sleep");
  assert.notEqual(outcome.settled === "fulfilled" ? outcome.status : undefined, "expired");
  assert.equal(outcome.settled, "rejected");
  assert.ok(outcome.error instanceof Error);
  assert.equal(outcome.error.name, "AbortError");
});
