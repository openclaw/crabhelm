import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createClawRecord, rotateClawCredentials, standaloneBootstrapHash } from "../src/domain.js";
import {
  bootstrapInstallScript,
  bootstrapStatusCommand,
  bootstrapToken,
  CrabboxWorkspaceBootstrap,
  inferenceProbeCommand,
  validBootstrapToken,
} from "../worker/bootstrap.js";

const run = promisify(execFile);
const testNodeId = "e".repeat(64);
const testReleaseMarker = `${"a".repeat(64)}.${"c".repeat(64)}.${testNodeId}`;

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
    nodeId: "e".repeat(64),
    signingSecret: "signing-test-secret",
  });

  const command = await bootstrap.command(claw);
  assert.match(command, new RegExp(`/bootstrap/${claw.id}/install\\.sh\\?model=openai%2Fgpt-5\\.5-mini&slack=false&policyHash=${standaloneBootstrapHash(claw)}`));
  assert.match(command, new RegExp(`CRABHELM_POLICY_HASH='${standaloneBootstrapHash(claw)}'`));
  assert.match(command, new RegExp(`/tmp/crabhelm-attempt-${testReleaseMarker}-${standaloneBootstrapHash(claw)}`));
  assert.doesNotMatch(command, /signing-test-secret|broker-test-token/);
  assert.match(command, /curl .* -o .* && touch/u);
  assert.match(command, /timeout --signal=TERM --kill-after=10s 10m bash/u);
  assert.doesNotMatch(command, /^touch /u);

  const now = 1_800_000_000_000;
  const releaseId = "a".repeat(64);
  const archiveId = "c".repeat(64);
  const nodeId = "e".repeat(64);
  const token = await bootstrapToken("signing-test-secret", claw.id, releaseId, archiveId, nodeId, now + 60_000);
  assert.equal(await validBootstrapToken("signing-test-secret", claw.id, releaseId, archiveId, nodeId, token, now), true);
  assert.equal(await validBootstrapToken("signing-test-secret", crypto.randomUUID(), releaseId, archiveId, nodeId, token, now), false);
  assert.equal(await validBootstrapToken("different-secret", claw.id, releaseId, archiveId, nodeId, token, now), false);
  assert.equal(await validBootstrapToken("signing-test-secret", claw.id, "b".repeat(64), archiveId, nodeId, token, now), false);
  assert.equal(await validBootstrapToken("signing-test-secret", claw.id, releaseId, "d".repeat(64), nodeId, token, now), false);
  assert.equal(await validBootstrapToken("signing-test-secret", claw.id, releaseId, archiveId, "f".repeat(64), token, now), false);
  assert.equal(await validBootstrapToken("signing-test-secret", claw.id, releaseId, archiveId, nodeId, token, now + 60_000), false);
});

test("workspace bootstrap selects a per-claw appliance canary", async () => {
  const claw = createClawRecord({
    name: "Canary child",
    owner: { subject: "github:canary", label: "@canary", source: "github" },
    deployment: {
      appliance: { manifestSha256: "d".repeat(64), archiveSha256: "e".repeat(64), nodeSha256: "a".repeat(64) },
    },
  });
  const bootstrap = new CrabboxWorkspaceBootstrap({
    brokerToken: "broker-test-token",
    publicUrl: "https://crabhelm.example.test",
    releaseId: "a".repeat(64),
    archiveId: "c".repeat(64),
    nodeId: "e".repeat(64),
    signingSecret: "signing-test-secret",
  });

  const command = await bootstrap.command(claw);
  assert.match(command, new RegExp(`/tmp/crabhelm-attempt-${"d".repeat(64)}\\.${"e".repeat(64)}\\.${"a".repeat(64)}`));
  assert.doesNotMatch(command, new RegExp(`/tmp/crabhelm-attempt-${"a".repeat(64)}`));

  const repacked = createClawRecord({
    name: "Repacked canary",
    owner: { subject: "github:repacked", label: "@repacked", source: "github" },
    deployment: {
      appliance: { manifestSha256: "d".repeat(64), archiveSha256: "f".repeat(64), nodeSha256: "a".repeat(64) },
    },
  });
  const repackedCommand = await bootstrap.command(repacked);
  assert.match(repackedCommand, new RegExp(`/tmp/crabhelm-attempt-${"d".repeat(64)}\\.${"f".repeat(64)}\\.${"a".repeat(64)}`));
  assert.notEqual(command, repackedCommand);

  const newNode = createClawRecord({
    name: "New Node canary",
    owner: { subject: "github:new-node", label: "@new-node", source: "github" },
    deployment: {
      appliance: { manifestSha256: "d".repeat(64), archiveSha256: "e".repeat(64), nodeSha256: "b".repeat(64) },
    },
  });
  const newNodeCommand = await bootstrap.command(newNode);
  assert.match(newNodeCommand, new RegExp(`/tmp/crabhelm-attempt-${"d".repeat(64)}\\.${"e".repeat(64)}\\.${"b".repeat(64)}`));
  assert.notEqual(command, newNodeCommand);
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
    nodeId: "e".repeat(64),
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
  const commands = [bootstrapStatusCommand(), inferenceProbeCommand("openai/gpt-5.5", testReleaseMarker, testNodeId)];
  for (const command of commands) {
    await run("/bin/bash", ["-n", "-c", command]);
    assert.doesNotMatch(command, /&&\s*&&/u);
  }
  assert.match(inferenceProbeCommand("openai/gpt-5.5", testReleaseMarker, testNodeId), /value\.payloads/u);
  assert.doesNotMatch(inferenceProbeCommand("openai/gpt-5.5", testReleaseMarker, testNodeId), /grep[^\n]*CRABHELM_LIVE_OK/u);
  assert.doesNotMatch(bootstrapStatusCommand(), /CRABHELM_(?:READY|PENDING)/u);
  assert.match(bootstrapStatusCommand(), /\[b\]ootstrap-child\.sh/u);
});

test("terminal evidence is bound to a fresh inspection label", async () => {
  const label = "CRABHELM_deadbeef";
  const status = bootstrapStatusCommand("", label);
  const inference = inferenceProbeCommand("openai/gpt-5.5", testReleaseMarker, testNodeId, `${label}_INFERENCE`);
  assert.match(status, /status_label='CRABHELM_deadbeef'/u);
  assert.match(inference, /probe_label='CRABHELM_deadbeef_INFERENCE'/u);
  await run("/bin/bash", ["-n", "-c", `${status}\n${inference}`]);
});

test("live inference proof is re-keyed by the credential epoch", async () => {
  const model = "openai/gpt-5.5";
  const legacy = inferenceProbeCommand(model, testReleaseMarker, testNodeId);
  const rotated = inferenceProbeCommand(model, testReleaseMarker, testNodeId, "CRABHELM_INFERENCE", 2);
  assert.ok(legacy.includes(`'v3:${testReleaseMarker}:openai/gpt-5.5'`));
  assert.doesNotMatch(legacy, /v4:/u);
  assert.ok(rotated.includes(`'v4:${testReleaseMarker}:c2:openai/gpt-5.5'`));
  assert.doesNotMatch(
    inferenceProbeCommand("openai/gpt-5.5:c2", testReleaseMarker, testNodeId),
    new RegExp(`'v4:${testReleaseMarker}:c2:openai/gpt-5\\.5'`, "u"),
  );
  await run("/bin/bash", ["-n", "-c", rotated]);
});

test("workspace readiness is pinned to the reviewed appliance release", async () => {
  const releaseId = "a".repeat(64);
  const status = bootstrapStatusCommand("echo launch", "CRABHELM_release", "/tmp/retry", releaseId);
  assert.match(status, new RegExp(`grep -Fqx '${releaseId}'`));
  assert.match(status, /test ! -e '\/tmp\/retry'.*pgrep -f '\[g\]uest-install\.sh'/u);
  assert.match(status, /pkill -TERM -P "\$stale_pid"/u);
  assert.match(status, /rm -f '\/tmp\/retry' '\/tmp\/retry\.retry' '\/tmp\/retry\.retry2'/u);
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
  const compatible = bootstrapStatusCommand("echo launch", "CRABHELM_legacy", "/tmp/retry", policyReadyId, 1, releaseId);
  assert.match(compatible, new RegExp(`grep -Fqx '${policyReadyId}'.*\\|\\| grep -Fqx '${releaseId}'`));
  const blocked = bootstrapStatusCommand("echo launch", "CRABHELM_legacy", "/tmp/retry", policyReadyId, 1, "", releaseId);
  assert.match(blocked, /POLICY_UPGRADE_REQUIRED/u);
  assert.ok(blocked.indexOf("POLICY_UPGRADE_REQUIRED") < blocked.indexOf("echo launch"));
  await run("/bin/bash", ["-n", "-c", compatible]);
  await run("/bin/bash", ["-n", "-c", blocked]);
});

test("credential rotation re-keys the install marker and bootstrap request", async () => {
  const claw = createClawRecord({
    name: "Rotation child",
    owner: { subject: "github:rotation", label: "@rotation", source: "github" },
  });
  const bootstrap = new CrabboxWorkspaceBootstrap({
    brokerToken: "broker-test-token",
    publicUrl: "https://crabhelm.example.test",
    releaseId: "a".repeat(64),
    archiveId: "c".repeat(64),
    nodeId: "e".repeat(64),
    signingSecret: "signing-test-secret",
  });
  const initial = await bootstrap.command(claw);
  assert.doesNotMatch(initial, /credentials=/u);
  assert.ok(initial.includes(`/tmp/crabhelm-attempt-${testReleaseMarker}-${standaloneBootstrapHash(claw)}`));
  assert.ok(!initial.includes(`/tmp/crabhelm-attempt-${testReleaseMarker}-${standaloneBootstrapHash(claw)}-c`));

  const rotatedClaw = rotateClawCredentials(claw);
  const rotated = await bootstrap.command(rotatedClaw);
  assert.match(rotated, /install\.sh\?model=[^']+&slack=false&policyHash=[0-9a-f]{64}&credentials=2/u);
  assert.ok(rotated.includes(`/tmp/crabhelm-attempt-${testReleaseMarker}-${standaloneBootstrapHash(rotatedClaw)}-c2`));
});

test("readiness past epoch one requires the credential re-delivery marker", async () => {
  const releaseId = "b".repeat(64);
  const home = await mkdtemp(path.join(tmpdir(), "crabhelm-ready-"));
  const bin = path.join(home, "stub-bin");
  await mkdir(path.join(home, ".openclaw"), { recursive: true });
  await mkdir(bin, { recursive: true });
  // Quiet pgrep so host processes never influence the evidence chain.
  await writeFile(path.join(bin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await chmod(path.join(bin, "pgrep"), 0o755);
  await writeFile(path.join(home, ".openclaw", "crabhelm-ready"), `${releaseId}\n`, { mode: 0o600 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` };
  const observe = async (credentialsGeneration: number) => {
    const command = bootstrapStatusCommand("", "CRABHELM_epoch", "", releaseId, credentialsGeneration);
    const { stdout } = await run("/bin/bash", ["-c", command], { env });
    return stdout;
  };

  assert.match(await observe(1), /^CRABHELM_epoch_READY$/mu);
  assert.doesNotMatch(await observe(2), /_READY$/mu);

  await writeFile(
    path.join(home, ".openclaw", "crabhelm-credentials-generation"),
    "c2\n",
    { mode: 0o600 },
  );
  assert.match(await observe(2), /^CRABHELM_epoch_READY$/mu);
  assert.doesNotMatch(await observe(3), /_READY$/mu);
});

test("generated installer re-fetches credentials and records the epoch marker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crabhelm-install-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const fixtures = path.join(root, "fixtures");
  const guestLog = path.join(root, "guest.log");
  await mkdir(path.join(fixtures, "bundle"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(fixtures, "bundle", "guest-install.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gen=%s release=%s base=%s model=%s credentials=%s\\n' "$CRABHELM_CREDENTIALS_GENERATION" "$CRABHELM_RELEASE_ID" "$CRABHELM_MODEL_BASE_URL" "$CRABHELM_MODEL" "$(head -n 1 "$CRABHELM_CREDENTIAL_FILE")" >>"$CRABHELM_TEST_LOG"
`,
    { mode: 0o755 },
  );
  await chmod(path.join(fixtures, "bundle", "guest-install.sh"), 0o755);
  await run("tar", ["-czf", path.join(fixtures, "bundle.tgz"), "-C", fixtures, "bundle"]);
  const archiveId = createHash("sha256")
    .update(await readFile(path.join(fixtures, "bundle.tgz")))
    .digest("hex");
  await writeFile(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
url=""
dest=""
while (($#)); do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */bundle.tgz) cp ${JSON.stringify(path.join(fixtures, "bundle.tgz"))} "$dest" ;;
  */credentials.env) printf 'OPENAI_API_KEY=rotated-epoch-secret\\n' >"$dest" ;;
  */managed-spec.json*) printf '{}\\n' >"$dest" ;;
  *) exit 22 ;;
esac
`,
    { mode: 0o755 },
  );
  await chmod(path.join(bin, "curl"), 0o755);

  const script = bootstrapInstallScript({
    base: "https://crabhelm-runtime.example.test/bootstrap/child-id",
    archiveId,
    releaseId: "e".repeat(64),
    nodeSha256: "f".repeat(64),
    childId: "child-id",
    model: "openai/gpt-5.5",
    slack: "false",
    credentialsGeneration: 4,
    policyHash: "a".repeat(64),
    modelBaseUrl: "https://crabhelm-runtime.example.test/model/v1",
  });
  await run("/bin/bash", ["-n", "-c", script]);
  assert.ok(
    script.indexOf("guest-install.sh") < script.indexOf("crabhelm-credentials-generation"),
    "epoch marker must only be written after a successful install",
  );

  await run("/bin/bash", ["-c", script], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CRABHELM_BOOTSTRAP_TOKEN: "test-token",
      CRABHELM_TEST_LOG: guestLog,
    },
  });
  assert.equal(
    await readFile(guestLog, "utf8"),
    `gen=4 release=${"e".repeat(64)}.${archiveId}.${"f".repeat(64)} base=https://crabhelm-runtime.example.test/model/v1 model=openai/gpt-5.5 credentials=OPENAI_API_KEY=rotated-epoch-secret\n`,
  );
  const marker = path.join(home, ".openclaw", "crabhelm-credentials-generation");
  assert.equal(await readFile(marker, "utf8"), "c4\n");
  assert.equal(((await stat(marker)).mode & 0o777), 0o600);
});

test("live inference proof is re-keyed by managed policy", async () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const original = inferenceProbeCommand("openai/gpt-5.5", testReleaseMarker, testNodeId, "CRABHELM_INFERENCE", 1, first);
  const changed = inferenceProbeCommand("openai/gpt-5.5", testReleaseMarker, testNodeId, "CRABHELM_INFERENCE", 1, second);
  assert.notEqual(original, changed);
  assert.ok(original.includes(`'v5:${testReleaseMarker}:p${first}:openai/gpt-5.5'`));
  assert.ok(changed.includes(`'v5:${testReleaseMarker}:p${second}:openai/gpt-5.5'`));
  await run("/bin/bash", ["-n", "-c", changed]);
});
