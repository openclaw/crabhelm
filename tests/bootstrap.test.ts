import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { inferenceProbeCommand } from "../worker/bootstrap.js";

const run = promisify(execFile);
const bootstrap = path.resolve("deploy/bootstrap-child.sh");

test("child bootstrap verifies artifacts, allowlists Crabhelm, and strips ambient Gateway auth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crabhelm-bootstrap-"));
  const bin = path.join(root, "bin");
  const plugin = path.join(root, "crabhelm.tgz");
  const slackPlugin = path.join(root, "slack.tgz");
  const runtimeBridge = path.join(root, "runtime-bridge.mjs");
  const log = path.join(root, "openclaw.log");
  await mkdir(bin);
  await writeFile(plugin, "pinned plugin artifact\n", { mode: 0o600 });
  await writeFile(slackPlugin, "pinned Slack artifact\n", { mode: 0o600 });
  await writeFile(runtimeBridge, "// pinned runtime bridge\n", { mode: 0o600 });
  await executable(path.join(bin, "openclaw"), `#!/usr/bin/env bash
printf 'auth=%s/%s argv=' "\${OPENCLAW_GATEWAY_TOKEN+present}" "\${OPENCLAW_GATEWAY_PASSWORD+present}" >>"$CRABHELM_TEST_LOG"
printf '%q ' "$@" >>"$CRABHELM_TEST_LOG"
printf '\n' >>"$CRABHELM_TEST_LOG"
`);
  await executable(path.join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  const digest = createHash("sha256").update(await readFile(plugin)).digest("hex");
  const slackDigest = createHash("sha256").update(await readFile(slackPlugin)).digest("hex");
  const runtimeBridgeDigest = createHash("sha256").update(await readFile(runtimeBridge)).digest("hex");

  await run("/bin/bash", [bootstrap], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      CRABHELM_TEST_LOG: log,
      CRABBOX_ADAPTER_ROOT_SESSION_ID: "11111111-1111-4111-8111-111111111111",
      CRABHELM_PARENT_HOST: "parent.internal.example",
      CRABHELM_PARENT_PORT: "18789",
      CRABHELM_PARENT_TLS: "true",
      CRABHELM_PARENT_TLS_FINGERPRINT: "a".repeat(64),
      CRABHELM_PLUGIN_TARBALL: plugin,
      CRABHELM_PLUGIN_SHA256: digest,
      CRABHELM_SLACK_PLUGIN_TARBALL: slackPlugin,
      CRABHELM_SLACK_PLUGIN_SHA256: slackDigest,
      CRABHELM_RUNTIME_BRIDGE: runtimeBridge,
      CRABHELM_RUNTIME_BRIDGE_SHA256: runtimeBridgeDigest,
      CRABHELM_RELEASE_ID: `${"b".repeat(64)}.${"c".repeat(64)}.${"d".repeat(64)}`,
      CRABHELM_MODEL: "openai/gpt-5.5-mini",
      CRABHELM_SLACK_ENABLED: "true",
      OPENCLAW_GATEWAY_TOKEN: "must-not-reach-openclaw",
      OPENCLAW_GATEWAY_PASSWORD: "must-not-reach-openclaw",
    },
  });

  const calls = await readFile(log, "utf8");
  assert.doesNotMatch(calls, /auth=present/);
  assert.match(calls, /config set plugins\.allow/);
  assert.match(calls, /plugins\.allow .*crabhelm.*slack/);
  assert.match(calls, /channels\.slack\.mode socket/);
  assert.match(calls, /agents\.defaults\.model\.primary openai\/gpt-5\.5-mini/);
  assert.match(calls, /agents\.defaults\.workspace .*\.openclaw\/workspace/);
  assert.match(calls, /channels\.slack\.enabled true/);
  assert.match(calls, /channels\.slack\.appToken .*SLACK_APP_TOKEN/);
  assert.match(calls, /config set gateway\.auth\.mode none/);
  assert.match(calls, /node install/);
  assert.match(calls, /--node-id crabhelm-11111111-1111-4111-8111-111111111111/);
  assert.match(calls, /--tls-fingerprint a{64}/);
});

test("child bootstrap rejects a changed plugin before invoking OpenClaw", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crabhelm-bootstrap-digest-"));
  const bin = path.join(root, "bin");
  const plugin = path.join(root, "crabhelm.tgz");
  const slackPlugin = path.join(root, "slack.tgz");
  const runtimeBridge = path.join(root, "runtime-bridge.mjs");
  const log = path.join(root, "openclaw.log");
  await mkdir(bin);
  await writeFile(plugin, "changed artifact\n", { mode: 0o600 });
  await writeFile(slackPlugin, "pinned Slack artifact\n", { mode: 0o600 });
  await writeFile(runtimeBridge, "// pinned runtime bridge\n", { mode: 0o600 });
  await executable(path.join(bin, "openclaw"), `#!/usr/bin/env bash
printf 'called\n' >>"$CRABHELM_TEST_LOG"
`);
  await executable(path.join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  const slackDigest = createHash("sha256").update(await readFile(slackPlugin)).digest("hex");
  const runtimeBridgeDigest = createHash("sha256").update(await readFile(runtimeBridge)).digest("hex");

  await assert.rejects(
    run("/bin/bash", [bootstrap], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CRABHELM_TEST_LOG: log,
        CRABBOX_ADAPTER_ROOT_SESSION_ID: "11111111-1111-4111-8111-111111111111",
        CRABHELM_PARENT_HOST: "parent.internal.example",
        CRABHELM_PARENT_TLS_FINGERPRINT: "a".repeat(64),
        CRABHELM_PLUGIN_TARBALL: plugin,
        CRABHELM_PLUGIN_SHA256: "0".repeat(64),
        CRABHELM_SLACK_PLUGIN_TARBALL: slackPlugin,
        CRABHELM_SLACK_PLUGIN_SHA256: slackDigest,
        CRABHELM_RUNTIME_BRIDGE: runtimeBridge,
        CRABHELM_RUNTIME_BRIDGE_SHA256: runtimeBridgeDigest,
        CRABHELM_RELEASE_ID: `${"b".repeat(64)}.${"c".repeat(64)}.${"d".repeat(64)}`,
      },
    }),
    /plugin tarball digest mismatch/,
  );
  await assert.rejects(readFile(log), /ENOENT/);
});

test("child bootstrap supports Web PKI TLS without a pinned certificate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crabhelm-bootstrap-tls-"));
  const bin = path.join(root, "bin");
  const plugin = path.join(root, "crabhelm.tgz");
  const slackPlugin = path.join(root, "slack.tgz");
  const runtimeBridge = path.join(root, "runtime-bridge.mjs");
  const log = path.join(root, "openclaw.log");
  await mkdir(bin);
  await writeFile(plugin, "pinned plugin artifact\n", { mode: 0o600 });
  await writeFile(slackPlugin, "pinned Slack artifact\n", { mode: 0o600 });
  await writeFile(runtimeBridge, "// pinned runtime bridge\n", { mode: 0o600 });
  await executable(path.join(bin, "openclaw"), `#!/usr/bin/env bash
printf '%q ' "$@" >>"$CRABHELM_TEST_LOG"
printf '\n' >>"$CRABHELM_TEST_LOG"
`);
  await executable(path.join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  const digest = createHash("sha256").update(await readFile(plugin)).digest("hex");
  const slackDigest = createHash("sha256").update(await readFile(slackPlugin)).digest("hex");
  const runtimeBridgeDigest = createHash("sha256").update(await readFile(runtimeBridge)).digest("hex");
  await run("/bin/bash", [bootstrap], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      CRABHELM_TEST_LOG: log,
      CRABBOX_ADAPTER_ROOT_SESSION_ID: "11111111-1111-4111-8111-111111111111",
      CRABHELM_PARENT_HOST: "parent.internal.example",
      CRABHELM_PARENT_TLS: "true",
      CRABHELM_PLUGIN_TARBALL: plugin,
      CRABHELM_PLUGIN_SHA256: digest,
      CRABHELM_SLACK_PLUGIN_TARBALL: slackPlugin,
      CRABHELM_SLACK_PLUGIN_SHA256: slackDigest,
      CRABHELM_RUNTIME_BRIDGE: runtimeBridge,
      CRABHELM_RUNTIME_BRIDGE_SHA256: runtimeBridgeDigest,
      CRABHELM_RELEASE_ID: `${"b".repeat(64)}.${"c".repeat(64)}.${"d".repeat(64)}`,
    },
  });
  const calls = await readFile(log, "utf8");
  assert.match(calls, /node install .*--tls/);
  assert.doesNotMatch(calls, /--tls-fingerprint/);
});

test("standalone bootstrap defers the runtime bridge until inference readiness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crabhelm-bootstrap-runtime-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const state = path.join(home, ".openclaw");
  const plugin = path.join(root, "crabhelm.tgz");
  const slackPlugin = path.join(root, "slack.tgz");
  const runtimeBridge = path.join(root, "runtime-bridge.mjs");
  const log = path.join(root, "openclaw.log");
  await mkdir(bin);
  await mkdir(state, { recursive: true });
  await writeFile(plugin, "pinned plugin artifact\n", { mode: 0o600 });
  await writeFile(slackPlugin, "pinned Slack artifact\n", { mode: 0o600 });
  await writeFile(runtimeBridge, "// pinned runtime bridge\n", { mode: 0o600 });
  await writeFile(path.join(state, "crabhelm-runtime.env"), "CRABHELM_CONTROL_URL=https://crabhelm.example.test\nCRABHELM_CHILD_ID=11111111-1111-4111-8111-111111111111\n", { mode: 0o600 });
  await writeFile(path.join(state, "crabhelm-runtime-token"), "test-runtime-token\n", { mode: 0o600 });
  await executable(path.join(bin, "openclaw"), `#!/usr/bin/env bash
printf '%q ' "$@" >>"$CRABHELM_TEST_LOG"
printf '\n' >>"$CRABHELM_TEST_LOG"
`);
  await executable(path.join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  const digest = createHash("sha256").update(await readFile(plugin)).digest("hex");
  const slackDigest = createHash("sha256").update(await readFile(slackPlugin)).digest("hex");
  const runtimeBridgeDigest = createHash("sha256").update(await readFile(runtimeBridge)).digest("hex");

  const bootstrapEnv = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    CRABHELM_TEST_LOG: log,
    CRABBOX_ADAPTER_ROOT_SESSION_ID: "11111111-1111-4111-8111-111111111111",
    CRABHELM_STANDALONE: "true",
    CRABHELM_PLUGIN_TARBALL: plugin,
    CRABHELM_PLUGIN_SHA256: digest,
    CRABHELM_SLACK_PLUGIN_TARBALL: slackPlugin,
    CRABHELM_SLACK_PLUGIN_SHA256: slackDigest,
    CRABHELM_RUNTIME_BRIDGE: runtimeBridge,
    CRABHELM_RUNTIME_BRIDGE_SHA256: runtimeBridgeDigest,
    CRABHELM_RELEASE_ID: `${"b".repeat(64)}.${"c".repeat(64)}.${"d".repeat(64)}`,
  };
  await run("/bin/bash", [bootstrap], { env: bootstrapEnv });
  await run("/bin/bash", [bootstrap], { env: bootstrapEnv });

  const launcher = path.join(home, ".local/share/crabhelm/runtime/start-runtime-bridge.sh");
  assert.equal((await stat(launcher)).mode & 0o777, 0o500);
  const launcherSource = await readFile(launcher, "utf8");
  assert.match(launcherSource, /CRABHELM_RUNTIME_TOKEN_FILE=/u);
  assert.doesNotMatch(launcherSource, /flock|lock_dir/u);
  assert.doesNotMatch(launcherSource, /rm -f "\$runtime_token_file"/u);
  assert.equal(await readFile(path.join(state, "crabhelm-runtime-token"), "utf8"), "test-runtime-token\n");
  await assert.rejects(stat(path.join(state, "crabhelm-runtime-bridge.pid")), /ENOENT/u);
  await run("/bin/bash", ["-n", launcher]);
  const bootstrapSource = await readFile(bootstrap, "utf8");
  assert.ok(
    bootstrapSource.lastIndexOf("prepare_runtime_bridge") < bootstrapSource.indexOf('printf \'%s\\n\' "$release_id"'),
    "release readiness must be written only after the runtime launcher is executable",
  );
  const nodeId = "d".repeat(64);
  const releaseId = `${"b".repeat(64)}.${"c".repeat(64)}.${nodeId}`;
  const probe = inferenceProbeCommand("openai/gpt-5.5", releaseId, nodeId);
  assert.match(probe, /start-runtime-bridge\.sh/u);
  assert.match(probe, new RegExp(`node-v22\\.23\\.1-${nodeId}-linux-x64`));
  assert.match(probe, new RegExp(`v3:${releaseId}:openai/gpt-5\\.5`));
  assert.match(probe, /if \/bin\/bash \$HOME\/\.local\/share\/crabhelm\/runtime\/start-runtime-bridge\.sh; then[\s\S]*crabhelm-inference-ready/u);
});

async function executable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, { mode: 0o700 });
  await chmod(file, 0o700);
}
