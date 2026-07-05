import assert from "node:assert/strict";
import test from "node:test";
import { childPolicyHash, createClawRecord, updateClawRecord } from "../src/domain.js";

test("creates an independent child-core desired state with safe defaults", () => {
  const claw = createClawRecord({
    name: "Ada's Maintainer Claw",
    owner: { subject: "github:ada", label: "@ada", source: "github" },
  });

  assert.equal(claw.desired.slug, "ada-s-maintainer-claw");
  assert.equal(claw.desired.access.dmPolicy, "pairing");
  assert.equal(claw.desired.channels.slack.enabled, false);
  assert.equal(claw.desired.channels.slack.mode, "socket");
  assert.equal(claw.desired.observability.metadataOnly, true);
  assert.equal(claw.desired.observability.logLevel, "info");
  assert.equal(claw.desired.observability.otel.enabled, false);
  assert.equal(claw.desired.observability.otel.serviceName, "crabhelm-ada-s-maintainer-claw");
  assert.equal(claw.observed.controlLink.status, "pending");
  assert.equal(claw.observed.controlLink.transport, "openclaw-node");
  assert.equal(claw.observed.controlLink.command, "crabhelm.child.status");
});

test("child policy hash covers managed access and logging policy", () => {
  const claw = createClawRecord({
    name: "Governed",
    owner: { subject: "github:governed", label: "@governed", source: "github" },
  });
  const updated = updateClawRecord(claw, {
    access: { groupPolicy: "disabled" },
    observability: { logLevel: "debug" },
  });
  assert.notEqual(childPolicyHash(updated), childPolicyHash(claw));
});

test("validates and hashes managed OpenTelemetry policy", () => {
  const claw = createClawRecord({
    name: "Observed",
    owner: { subject: "github:observed", label: "@observed", source: "github" },
  });
  const enabled = updateClawRecord(claw, {
    observability: {
      otel: {
        enabled: true,
        endpoint: "https://otel.example.test/v1",
        traces: true,
        metrics: true,
        logs: false,
        sampleRate: 0.2,
      },
    },
  });
  assert.equal(enabled.desired.observability.otel.endpoint, "https://otel.example.test/v1");
  assert.notEqual(childPolicyHash(enabled), childPolicyHash(claw));
  assert.throws(
    () => updateClawRecord(claw, { observability: { otel: { enabled: true, endpoint: "http://collector.test:4318" } } }),
    /HTTPS URL/,
  );
  for (const field of ["enabled", "traces", "metrics"] as const) {
    assert.throws(
      () => updateClawRecord(claw, {
        observability: { otel: { [field]: "false" as unknown as boolean } },
      }),
      new RegExp(`${field} must be a boolean`),
    );
  }
});

test("desired updates advance generation and preserve identity", () => {
  const claw = createClawRecord({
    name: "Release Claw",
    owner: { subject: "github:release", label: "@release", source: "github" },
  });
  const updated = updateClawRecord(claw, {
    inference: { model: "anthropic/claude-sonnet-4.6" },
  });

  assert.equal(updated.id, claw.id);
  assert.equal(updated.revision, claw.revision + 1);
  assert.equal(updated.desired.slug, claw.desired.slug);
  assert.equal(updated.desired.generation, 2);
  assert.equal(updated.desired.inference.model, "anthropic/claude-sonnet-4.6");
  assert.equal(updated.desired.inference.provider, "anthropic");
  assert.notEqual(childPolicyHash(updated), childPolicyHash(claw));
});

test("semantic no-op updates do not advance generation", () => {
  const claw = createClawRecord({
    name: "Release Claw",
    owner: { subject: "github:release", label: "@release", source: "github" },
  });
  const updated = updateClawRecord(claw, { name: "Release Claw" });
  assert.equal(updated, claw);
  assert.equal(updated.revision, claw.revision);
});

test("rejects an inference provider that disagrees with the model", () => {
  assert.throws(
    () =>
      createClawRecord({
        name: "Mismatch",
        owner: { subject: "manual:mismatch", label: "Mismatch", source: "manual" },
        inference: { provider: "openai", model: "anthropic/claude-sonnet-4.6" },
      }),
    /does not match/,
  );
});

test("rejects non provider/model inference identifiers", () => {
  assert.throws(
    () =>
      createClawRecord({
        name: "Unsafe",
        owner: { subject: "manual:unsafe", label: "Unsafe", source: "manual" },
        inference: { model: "gpt-5.5" },
      }),
    /provider\/model/,
  );
});
