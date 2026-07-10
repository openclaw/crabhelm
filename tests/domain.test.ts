import assert from "node:assert/strict";
import test from "node:test";
import {
  childPolicyHash,
  clawCredentialsGeneration,
  createClawRecord,
  normalizeManagedPolicySpec,
  rotateClawCredentials,
  updateClawRecord,
} from "../src/domain.js";
import type { ClawRecord } from "../src/types.js";

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
  assert.deepEqual(claw.desired.inference.router, { kind: "direct" });
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
  assert.throws(
    () => updateClawRecord(claw, { observability: { otel: { enabled: true, endpoint: "https://collector.test", traces: false, metrics: false } } }),
    /requires traces, metrics, or both/,
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

test("validates and hashes per-claw appliance release overrides", () => {
  const claw = createClawRecord({
    name: "Canary",
    owner: { subject: "github:canary", label: "@canary", source: "github" },
  });
  const canary = updateClawRecord(claw, {
    deployment: {
      appliance: { manifestSha256: "a".repeat(64), archiveSha256: "b".repeat(64), nodeSha256: "c".repeat(64) },
    },
  });
  assert.equal(canary.desired.deployment.appliance?.manifestSha256, "a".repeat(64));
  assert.notEqual(childPolicyHash(canary), childPolicyHash(claw));
  const reverted = updateClawRecord(canary, { deployment: { appliance: null } });
  assert.equal(reverted.desired.deployment.appliance, undefined);
  assert.notEqual(childPolicyHash(reverted), childPolicyHash(canary));
  assert.throws(
    () => updateClawRecord(claw, {
      deployment: { appliance: { manifestSha256: "not-a-digest", archiveSha256: "b".repeat(64), nodeSha256: "c".repeat(64) } },
    }),
    /lowercase SHA-256/,
  );
});

test("credential rotation advances the epoch, generation, and policy hash", () => {
  const claw = createClawRecord({
    name: "Rotated Claw",
    owner: { subject: "github:rotated", label: "@rotated", source: "github" },
  });
  assert.equal(clawCredentialsGeneration(claw), 1);
  const rotated = rotateClawCredentials(claw);
  assert.equal(clawCredentialsGeneration(rotated), 2);
  assert.equal(rotated.desired.generation, claw.desired.generation + 1);
  assert.equal(rotated.revision, claw.revision + 1);
  assert.notEqual(childPolicyHash(rotated), childPolicyHash(claw));
  const again = rotateClawCredentials(rotated);
  assert.equal(clawCredentialsGeneration(again), 3);
  assert.notEqual(childPolicyHash(again), childPolicyHash(rotated));
});

test("desired updates preserve the credential epoch", () => {
  const claw = rotateClawCredentials(createClawRecord({
    name: "Sticky Epoch",
    owner: { subject: "github:sticky", label: "@sticky", source: "github" },
  }));
  const updated = updateClawRecord(claw, {
    inference: { model: "anthropic/claude-sonnet-4.6" },
  });
  assert.equal(clawCredentialsGeneration(updated), 2);
});

test("records persisted before the credential epoch behave as epoch one", () => {
  const modern = createClawRecord({
    name: "Legacy Claw",
    owner: { subject: "github:legacy", label: "@legacy", source: "github" },
  });
  const { credentialsGeneration: _omitted, ...legacyDesired } = modern.desired;
  const legacy = { ...modern, desired: legacyDesired } as ClawRecord;
  assert.equal(clawCredentialsGeneration(legacy), 1);
  assert.equal(childPolicyHash(legacy), childPolicyHash(modern));
  const noop = updateClawRecord(legacy, { name: "Legacy Claw" });
  assert.equal(noop, legacy);
  const rotated = rotateClawCredentials(legacy);
  assert.equal(clawCredentialsGeneration(rotated), 2);
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
  assert.equal(
    createClawRecord({
      name: "Nested direct model",
      owner: { subject: "manual:segments", label: "Segments", source: "manual" },
      inference: { model: "openrouter/anthropic/claude-sonnet-4.6" },
    }).desired.inference.model,
    "openrouter/anthropic/claude-sonnet-4.6",
  );
  assert.throws(
    () => createClawRecord({
      name: "Router without fleet",
      owner: { subject: "manual:router", label: "Router", source: "manual" },
      inference: { model: "clawrouter/openai/gpt-5.5" },
    }),
    /provider\/model/u,
  );
});

test("creates per-claw ClawRouter desired state from fleet policy", () => {
  const claw = createClawRecord({
    name: "Routed",
    owner: { subject: "manual:routed", label: "Routed", source: "manual" },
    inference: {
      model: "clawrouter/openai/gpt-5.5",
      fallbackModels: ["clawrouter/anthropic/claude-sonnet-4.6"],
    },
  }, new Date(), {
    clawRouter: {
      baseUrl: "https://clawrouter.example.test",
      tenantId: "fakeco",
      allowedProviders: ["anthropic", "openai"],
      modelProviders: {
        "clawrouter/anthropic/claude-sonnet-4.6": "anthropic",
        "clawrouter/openai/gpt-5.5": "openai",
      },
      defaultModel: "clawrouter/openai/gpt-5.5",
    },
  });
  assert.equal(claw.desired.inference.provider, "clawrouter");
  assert.equal(claw.desired.inference.authRef?.startsWith("clawrouter:crabhelm_"), true);
  assert.deepEqual(claw.desired.inference.router, {
    kind: "clawrouter",
    baseUrl: "https://clawrouter.example.test",
    tenantId: "fakeco",
    policyId: `crabhelm_${claw.id.replaceAll("-", "")}`,
    credentialId: `crabhelm_${claw.id.replaceAll("-", "")}`,
    projectId: claw.id,
    allowedProviders: ["anthropic", "openai"],
    modelProviders: {
      "clawrouter/anthropic/claude-sonnet-4.6": "anthropic",
      "clawrouter/openai/gpt-5.5": "openai",
    },
    providers: ["anthropic", "openai"],
  });
  assert.throws(
    () => updateClawRecord(claw, { inference: { model: "clawrouter/google/gemini-2.5-pro" } }),
    /explicit fleet model-to-provider mapping/u,
  );
  assert.throws(
    () => createClawRecord({
      name: "Direct mismatch",
      owner: { subject: "manual:direct", label: "Direct", source: "manual" },
      inference: { model: "openai/gpt-5.5" },
    }, new Date(), {
      clawRouter: {
        baseUrl: "https://clawrouter.example.test",
        tenantId: "fakeco",
        allowedProviders: ["openai"],
        modelProviders: { "clawrouter/openai/gpt-5.5": "openai" },
        defaultModel: "clawrouter/openai/gpt-5.5",
      },
    }),
    /require clawrouter\/provider\/model/u,
  );
  assert.equal(normalizeManagedPolicySpec({
    inference: {
      model: "clawrouter/openai/gpt-5.5",
      fallbackModels: ["clawrouter/anthropic/claude-sonnet-4.6"],
    },
    slackEnabled: false,
    access: { dmPolicy: "pairing", groupPolicy: "allowlist" },
    observability: { logLevel: "info" },
  }).inference.model, "clawrouter/openai/gpt-5.5");
});
