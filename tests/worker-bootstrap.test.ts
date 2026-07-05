import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { createClawRecord, standaloneBootstrapHash } from "../src/domain.js";
import {
  bootstrapStatusCommand,
  bootstrapToken,
  CrabboxWorkspaceBootstrap,
  inferenceProbeCommand,
  validBootstrapToken,
} from "../worker/bootstrap.js";

const run = promisify(execFile);

test("Cloudflare workspace bootstrap binds child identity, model, and channel state", async () => {
  const claw = createClawRecord({
    name: "Live child",
    owner: { subject: "github:live", label: "@live", source: "github" },
    inference: { model: "openai/gpt-5.5-mini" },
    slack: { enabled: true, mode: "socket" },
  });
  const bootstrap = new CrabboxWorkspaceBootstrap({
    brokerToken: "broker-test-token",
    publicUrl: "https://crabhelm.example.test/path-is-ignored",
    releaseId: "a".repeat(64),
    archiveId: "c".repeat(64),
    signingSecret: "signing-test-secret",
  });

  const command = await bootstrap.command(claw);
  assert.match(command, new RegExp(`/bootstrap/${claw.id}/install\\.sh\\?model=openai%2Fgpt-5\\.5-mini&slack=false&policyHash=${standaloneBootstrapHash(claw)}`));
  assert.match(command, new RegExp(`CRABHELM_POLICY_HASH='${standaloneBootstrapHash(claw)}'`));
  assert.match(command, new RegExp(`/tmp/crabhelm-attempt-${"a".repeat(64)}-${standaloneBootstrapHash(claw)}`));
  assert.doesNotMatch(command, /signing-test-secret|broker-test-token/);
  assert.match(command, /curl .* -o .* && touch/u);
  assert.match(command, /timeout --signal=TERM --kill-after=10s 10m bash/u);
  assert.doesNotMatch(command, /^touch /u);

  const now = 1_800_000_000_000;
  const releaseId = "a".repeat(64);
  const archiveId = "c".repeat(64);
  const token = await bootstrapToken("signing-test-secret", claw.id, releaseId, archiveId, now + 60_000);
  assert.equal(await validBootstrapToken("signing-test-secret", claw.id, releaseId, archiveId, token, now), true);
  assert.equal(await validBootstrapToken("signing-test-secret", crypto.randomUUID(), releaseId, archiveId, token, now), false);
  assert.equal(await validBootstrapToken("different-secret", claw.id, releaseId, archiveId, token, now), false);
  assert.equal(await validBootstrapToken("signing-test-secret", claw.id, "b".repeat(64), archiveId, token, now), false);
  assert.equal(await validBootstrapToken("signing-test-secret", claw.id, releaseId, "d".repeat(64), token, now), false);
  assert.equal(await validBootstrapToken("signing-test-secret", claw.id, releaseId, archiveId, token, now + 60_000), false);
});

test("Cloudflare workspace lifecycle drains the central runtime queue", async () => {
  const claw = createClawRecord({
    name: "Queued child",
    owner: { subject: "github:queued", label: "@queued", source: "github" },
    slack: { enabled: true, mode: "socket" },
  });
  const bootstrap = new CrabboxWorkspaceBootstrap({
    brokerToken: "broker-test-token",
    publicUrl: "https://crabhelm.example.test",
    releaseId: "a".repeat(64),
    archiveId: "c".repeat(64),
    signingSecret: "signing-test-secret",
    coordinators: { getByName: () => ({ runtimeStatus: async () => ({ pending: 1, running: 2, awaitingDelivery: 1 }) }) },
  });
  assert.equal((await bootstrap.disable(claw)).applied, true);
  const drain = await bootstrap.drain(claw);
  assert.equal(drain.drained, false);
  assert.equal(drain.activeRuns, 4);
  assert.equal(drain.message, "Cloudflare runtime queue still has active work");
  assert.ok(Date.parse(drain.checkedAt));
});

test("live inference probe is valid shell", async () => {
  const commands = [bootstrapStatusCommand(), inferenceProbeCommand("openai/gpt-5.5")];
  for (const command of commands) {
    await run("/bin/bash", ["-n", "-c", command]);
    assert.doesNotMatch(command, /&&\s*&&/u);
  }
  assert.match(inferenceProbeCommand("openai/gpt-5.5"), /value\.payloads/u);
  assert.doesNotMatch(inferenceProbeCommand("openai/gpt-5.5"), /grep[^\n]*CRABHELM_LIVE_OK/u);
  assert.doesNotMatch(bootstrapStatusCommand(), /CRABHELM_(?:READY|PENDING)/u);
  assert.match(bootstrapStatusCommand(), /\[b\]ootstrap-child\.sh/u);
});

test("terminal evidence is bound to a fresh inspection label", async () => {
  const label = "CRABHELM_deadbeef";
  const status = bootstrapStatusCommand("", label);
  const inference = inferenceProbeCommand("openai/gpt-5.5", `${label}_INFERENCE`);
  assert.match(status, /status_label='CRABHELM_deadbeef'/u);
  assert.match(inference, /probe_label='CRABHELM_deadbeef_INFERENCE'/u);
  await run("/bin/bash", ["-n", "-c", `${status}\n${inference}`]);
});

test("workspace readiness is pinned to the reviewed appliance release", async () => {
  const releaseId = "a".repeat(64);
  const status = bootstrapStatusCommand("echo launch", "CRABHELM_release", "/tmp/retry", releaseId);
  assert.match(status, new RegExp(`grep -Fqx '${releaseId}'`));
  assert.match(status, /test ! -e '\/tmp\/retry'.*pgrep -f '\[g\]uest-install\.sh'/u);
  assert.match(status, /pkill -TERM -P "\$stale_pid"/u);
  assert.match(status, /test ! -e '\/tmp\/retry\.retry'[\s\S]*touch '\/tmp\/retry\.retry'[\s\S]*echo launch/u);
  assert.match(status, /test ! -e '\/tmp\/retry\.retry2'[\s\S]*touch '\/tmp\/retry\.retry2'[\s\S]*echo launch/u);
  assert.ok(status.indexOf("test ! -e '/tmp/retry'") < status.indexOf("elif pgrep -f '[g]uest-install.sh'"));
  await run("/bin/bash", ["-n", "-c", status]);
});

test("workspace readiness changes with managed child policy", async () => {
  const releaseId = "a".repeat(64);
  const claw = createClawRecord({
    name: "Observed child",
    owner: { subject: "github:observed", label: "@observed", source: "github" },
  });
  const updated = createClawRecord({
    name: "Observed child",
    owner: { subject: "github:observed", label: "@observed", source: "github" },
    observability: {
      otel: {
        enabled: true,
        endpoint: "https://otel.example.test/v1",
        traces: true,
        metrics: true,
        logs: false,
      },
    },
  });
  const original = bootstrapStatusCommand("echo launch", "CRABHELM_policy", "/tmp/retry", `${releaseId}:${standaloneBootstrapHash(claw)}`);
  const changed = bootstrapStatusCommand("echo launch", "CRABHELM_policy", "/tmp/retry", `${releaseId}:${standaloneBootstrapHash(updated)}`);
  assert.notEqual(original, changed);
  assert.match(changed, new RegExp(`${releaseId}:${standaloneBootstrapHash(updated)}`));
  await run("/bin/bash", ["-n", "-c", changed]);
});

test("legacy appliance readiness is safe during the policy-aware rollout", async () => {
  const releaseId = "a".repeat(64);
  const policyReadyId = `${releaseId}:${"b".repeat(64)}`;
  const compatible = bootstrapStatusCommand("echo launch", "CRABHELM_legacy", "/tmp/retry", policyReadyId, releaseId);
  assert.match(compatible, new RegExp(`grep -Fqx '${policyReadyId}'.*\\|\\| grep -Fqx '${releaseId}'`));
  const blocked = bootstrapStatusCommand("echo launch", "CRABHELM_legacy", "/tmp/retry", policyReadyId, "", releaseId);
  assert.match(blocked, /POLICY_UPGRADE_REQUIRED/u);
  assert.ok(blocked.indexOf("POLICY_UPGRADE_REQUIRED") < blocked.indexOf("echo launch"));
  await run("/bin/bash", ["-n", "-c", compatible]);
  await run("/bin/bash", ["-n", "-c", blocked]);
});
