import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const builder = path.resolve("deploy/crabbox-profile/build-bundle.sh");

test("appliance builder pins artifacts and guest install verifies the bundle before bootstrap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crabhelm-appliance-"));
  const source = path.join(root, "source");
  const packageDir = path.join(source, "package");
  const openclawTarball = path.join(root, "openclaw.tgz");
  const nodeTarball = await createNodeFixture(root);
  const slackSource = path.join(root, "slack-source");
  const slackTarball = path.join(root, "slack.tgz");
  const output = path.join(root, "bundle");
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "2026.6.11" })}\n`,
  );
  await run("tar", ["-czf", openclawTarball, "-C", source, "package"]);
  await mkdir(path.join(slackSource, "package"), { recursive: true });
  await writeFile(
    path.join(slackSource, "package", "package.json"),
    `${JSON.stringify({ name: "@openclaw/slack", version: "2026.6.11" })}\n`,
  );
  await run("tar", ["-czf", slackTarball, "-C", slackSource, "package"]);

  const built = await run(builder, [
    "--node-tarball",
    nodeTarball,
    "--openclaw-tarball",
    openclawTarball,
    "--slack-tarball",
    slackTarball,
    "--output",
    output,
  ], {
    cwd: process.cwd(),
  });
  assert.match(built.stdout, /profile=openclaw-core/);
  const manifestBytes = await readFile(path.join(output, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.openclaw.version, "2026.6.11");
  assert.equal(manifest.node.version, "22.23.1");
  assert.equal(manifest.node.platform, "linux");
  assert.equal(manifest.node.arch, "x64");
  assert.equal(manifest.slack.version, "2026.6.11");
  assert.equal(manifest.crabhelm.version, "0.0.0");
  assert.equal(manifest.openclaw.sha256, digest(await readFile(path.join(output, manifest.openclaw.file))));
  assert.equal(manifest.slack.sha256, digest(await readFile(path.join(output, manifest.slack.file))));
  assert.equal(manifest.crabhelm.sha256, digest(await readFile(path.join(output, manifest.crabhelm.file))));
  assert.equal(manifest.runtimeBridge.sha256, digest(await readFile(path.join(output, manifest.runtimeBridge.file))));
  const guestInstallSource = await readFile(path.join(output, manifest.guestInstall.file), "utf8");
  assert.match(guestInstallSource, /CRABHELM_CREDENTIAL_REFRESH_URL/u);
  assert.match(guestInstallSource, /Authorization: Bearer \$CRABHELM_BOOTSTRAP_TOKEN/u);
  assert.ok(
    guestInstallSource.indexOf("CRABHELM_CREDENTIAL_REFRESH_URL") < guestInstallSource.indexOf('"$node_binary" - "$credential_source" "$credential_file"'),
  );
  const runtimeBridgeSource = await readFile(path.join(output, manifest.runtimeBridge.file), "utf8");
  assert.match(runtimeBridgeSource, /15 \* 60 \* 1000/u);
  assert.match(runtimeBridgeSource, /CRABHELM_RUNTIME_TOKEN_FD/u);
  assert.match(runtimeBridgeSource, /closeSync\(descriptor\)/u);
  assert.match(runtimeBridgeSource, /new WebSocket\(url, \["crabhelm\.runtime\.v1", `crabhelm\.ticket\.\$\{ticket\}`\]\)/u);
  assert.match(runtimeBridgeSource, /authorization: `Bearer \$\{runtimeToken\}`/u);
  assert.match(runtimeBridgeSource, /type: "job\.claim"/u);
  assert.match(runtimeBridgeSource, /type: "job\.started"/u);
  assert.match(runtimeBridgeSource, /type: "runtime\.refresh"/u);
  assert.match(runtimeBridgeSource, /setTimeout\(requestRefresh, 15_000\)/u);
  assert.match(runtimeBridgeSource, /if \(refreshPending\) requestRefresh\(\)/u);
  assert.match(runtimeBridgeSource, /binaryType = "arraybuffer"/u);
  assert.match(runtimeBridgeSource, /message\.type === "job\.ack"/u);
  assert.doesNotMatch(runtimeBridgeSource, /\/api\/runtime\/(?:claim|ack|complete|control|refresh)/u);
  assert.match(runtimeBridgeSource, /\/api\/runtime\/ticket/u);
  assert.match(runtimeBridgeSource, /"agent", "--agent", "main"/u);
  assert.doesNotMatch(runtimeBridgeSource, /"agent", "--local"/u);
  assert.doesNotMatch(runtimeBridgeSource, /env\.OPENAI_API_KEY/u);
  assert.match(runtimeBridgeSource, /process\.kill\(-child\.pid, signal\)/u);
  assert.match(runtimeBridgeSource, /activeRunCancel\?\.\("runtime reset by administrator"\)/u);
  assert.match(runtimeBridgeSource, /stdoutReady\?\.\(output\)/u);
  assert.match(runtimeBridgeSource, /runtime\.client_error/u);
  assert.match(runtimeBridgeSource, /data instanceof ArrayBuffer/u);
  assert.match(runtimeBridgeSource, /ArrayBuffer\.isView\(data\)/u);
  assert.match(runtimeBridgeSource, /typeof data\.text === "function"/u);
  assert.match(runtimeBridgeSource, /openSync\(file, "wx", 0o600\)/u);
  assert.match(runtimeBridgeSource, /!raw && Date\.now\(\) - info\.mtimeMs < 30_000/u);
  assert.match(runtimeBridgeSource, /runtime lock owner is invalid/u);
  assert.match(runtimeBridgeSource, /process\.kill\(owner, 0\)/u);
  assert.match(runtimeBridgeSource, /runtime_lock_release_failed/u);
  assert.match(runtimeBridgeSource, /child\.on\("exit"/u);
  assert.doesNotMatch(runtimeBridgeSource, /child\.on\("close"/u);
  assert.doesNotMatch(runtimeBridgeSource, /required\("CRABHELM_RUNTIME_TOKEN"\)/u);
  assert.match(runtimeBridgeSource, /CRABHELM_RUNTIME_TOKEN_FILE/u);
  assert.doesNotMatch(runtimeBridgeSource, /crabhelm\.token\./u);
  assert.doesNotMatch(runtimeBridgeSource, /crabhelm\.auth\./u);
  assert.match(runtimeBridgeSource, /\/api\/runtime\/connect/u);
  assert.equal((await stat(path.join(output, manifest.runtimeBridge.file))).mode & 0o777, 0o400);
  const repackedSlack = JSON.parse((await run("tar", [
    "-xOf",
    path.join(output, manifest.slack.file),
    "package/package.json",
  ])).stdout);
  assert.equal(repackedSlack.dependencies, undefined);
  assert.equal(repackedSlack.scripts, undefined);
  assert.deepEqual(repackedSlack.crabhelmAppliance, {
    dependenciesEmbedded: true,
    sourceSha256: digest(await readFile(slackTarball)),
  });
  const packedCrabhelm = JSON.parse((await run("tar", [
    "-xOf",
    path.join(output, manifest.crabhelm.file),
    "package/package.json",
  ])).stdout);
  assert.equal(packedCrabhelm.dependencies, undefined);
  assert.equal((await stat(path.join(output, "manifest.json"))).mode & 0o777, 0o400);
  assert.equal((await stat(path.join(output, "guest-install.sh"))).mode & 0o777, 0o500);

  const bin = path.join(root, "bin");
  const log = path.join(root, "guest.log");
  const home = path.join(root, "home");
  const credentialSource = path.join(root, "child-credentials.env");
  const managedSpecSource = path.join(root, "managed-spec.json");
  await mkdir(bin);
  await mkdir(home);
  await writeFile(
    credentialSource,
    "OPENAI_API_KEY=test-only\nCRABHELM_CONTROL_URL=https://crabhelm.example.test\nCRABHELM_RUNTIME_TOKEN=test-runtime-token\nCRABHELM_CHILD_ID=22222222-2222-4222-8222-222222222222\n",
    { mode: 0o600 },
  );
  await writeFile(managedSpecSource, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    clawId: "22222222-2222-4222-8222-222222222222",
    persona: { id: "persona-test", name: "Test agent", slug: "test-agent", kind: "personal", ownerPrincipalId: "principal-test", actorPolicy: { mode: "invoker" } },
    policyRevision: 1,
    capabilityIds: ["github.repository.read"],
    instructions: { identity: "# Test identity\n", soul: "# Test soul\n", agents: "# Test agents\n" },
    publishedContext: [],
    skills: [{ id: "skill-test", name: "Test skill", slug: "test-skill", version: 1, digest: "a".repeat(64), files: [{ path: "SKILL.md", content: "# Test skill\n", sha256: "b".repeat(64) }] }],
    readOnly: true,
  })}\n`, { mode: 0o600 });
  await executable(path.join(bin, "sudo"), "#!/usr/bin/env bash\n[[ \"${1:-}\" = -n ]] && shift\nexec \"$@\"\n");
  await executable(path.join(bin, "npm"), `#!/usr/bin/env bash
printf 'npm auth=%s/%s ' "\${OPENCLAW_GATEWAY_TOKEN+present}" "\${OPENCLAW_GATEWAY_PASSWORD+present}" >>"${log}"
printf '%q ' "$@" >>"${log}"
printf '\n' >>"${log}"
`);
  await executable(path.join(bin, "openclaw"), `#!/usr/bin/env bash
if [[ "\${1:-}" = --version ]]; then
  printf '%s\n' 'OpenClaw 2026.6.11 (test)'
  exit 0
fi
credential=absent
[[ -e "$HOME/.openclaw/.env" ]] && credential=present
printf 'openclaw auth=%s/%s credential=%s ' "\${OPENCLAW_GATEWAY_TOKEN+present}" "\${OPENCLAW_GATEWAY_PASSWORD+present}" "$credential" >>"${log}"
printf '%q ' "$@" >>"${log}"
printf '\n' >>"${log}"
`);
  await executable(path.join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");

  const guestEnv = {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      CRABHELM_TEST_LOG: log,
      CRABHELM_BUNDLE_MANIFEST_SHA256: digest(manifestBytes),
      CRABHELM_NODE_SHA256: manifest.node.sha256,
      CRABHELM_CREDENTIAL_FILE: credentialSource,
      CRABHELM_MANAGED_SPEC_FILE: managedSpecSource,
      CRABBOX_ADAPTER_ROOT_SESSION_ID: "22222222-2222-4222-8222-222222222222",
      CRABHELM_PARENT_HOST: "parent.internal.example",
      CRABHELM_PARENT_TLS: "true",
      CRABHELM_PARENT_TLS_FINGERPRINT: "b".repeat(64),
      OPENCLAW_GATEWAY_TOKEN: "must-not-reach-openclaw",
      OPENCLAW_GATEWAY_PASSWORD: "must-not-reach-openclaw",
  };
  await run("/bin/bash", [path.join(output, "guest-install.sh")], {
    env: guestEnv,
  });
  const calls = await readFile(log, "utf8");
  assert.match(calls, /npm auth=\/ install --global/);
  assert.match(calls, /openclaw auth=\/ credential=absent plugins install/);
  assert.match(calls, /openclaw auth=\/ credential=present config set/);
  assert.doesNotMatch(calls, /auth=present/);
  assert.match(calls, /config set plugins\.allow/);
  assert.match(calls, /node install/);
  const gatewayEnvironment = await readFile(path.join(home, ".openclaw", ".env"), "utf8");
  const runtimeEnvironment = await readFile(path.join(home, ".openclaw", "crabhelm-runtime.env"), "utf8");
  assert.match(gatewayEnvironment, /OPENAI_API_KEY=/u);
  assert.doesNotMatch(gatewayEnvironment, /CRABHELM_RUNTIME_TOKEN/u);
  assert.match(runtimeEnvironment, /CRABHELM_CONTROL_URL=/u);
  assert.doesNotMatch(runtimeEnvironment, /OPENAI_API_KEY|CRABHELM_RUNTIME_TOKEN/u);
  assert.equal(await readFile(path.join(home, ".openclaw", "crabhelm-runtime-token"), "utf8"), "test-runtime-token\n");
  assert.equal(await readFile(path.join(home, ".openclaw", "managed", "IDENTITY.md"), "utf8"), "# Test identity\n");
  assert.equal(await readFile(path.join(home, ".openclaw", "managed", "skills", "test-skill", "SKILL.md"), "utf8"), "# Test skill\n");
  assert.equal((await stat(path.join(home, ".openclaw", "managed", "IDENTITY.md"))).mode & 0o777, 0o444);
  assert.equal((await stat(path.join(home, ".openclaw", "managed"))).mode & 0o777, 0o555);

  await run("/bin/bash", [path.join(output, "guest-install.sh")], {
    env: guestEnv,
  });
  const retryCalls = await readFile(log, "utf8");
  assert.ok(retryCalls.length > calls.length);
  assert.match(retryCalls, /plugins uninstall crabhelm --force/);
  assert.match(retryCalls, /plugins uninstall slack --force/);

  await chmod(credentialSource, 0o644);
  await assert.rejects(
    run("/bin/bash", [path.join(output, "guest-install.sh")], { env: guestEnv }),
    /child credential source must be owner-only/,
  );
  assert.equal(await readFile(log, "utf8"), retryCalls);
  await chmod(credentialSource, 0o600);

  const crabhelmArtifact = path.join(output, manifest.crabhelm.file);
  await chmod(crabhelmArtifact, 0o600);
  await writeFile(crabhelmArtifact, "tampered\n");
  await assert.rejects(
    run("/bin/bash", [path.join(output, "guest-install.sh")], { env: guestEnv }),
    /bundle artifact digest mismatch: artifacts\/crabhelm\.tgz/,
  );
  assert.equal(await readFile(log, "utf8"), retryCalls);
});

test("appliance builder rejects a different OpenClaw version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crabhelm-appliance-version-"));
  const source = path.join(root, "source");
  const packageDir = path.join(source, "package");
  const openclawTarball = path.join(root, "openclaw.tgz");
  const nodeTarball = await createNodeFixture(root);
  const slackSource = path.join(root, "slack-source");
  const slackTarball = path.join(root, "slack.tgz");
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "2099.1.0" })}\n`,
  );
  await run("tar", ["-czf", openclawTarball, "-C", source, "package"]);
  await mkdir(path.join(slackSource, "package"), { recursive: true });
  await writeFile(
    path.join(slackSource, "package", "package.json"),
    `${JSON.stringify({ name: "@openclaw/slack", version: "2026.6.11" })}\n`,
  );
  await run("tar", ["-czf", slackTarball, "-C", slackSource, "package"]);
  await assert.rejects(
    run(builder, [
      "--node-tarball",
      nodeTarball,
      "--openclaw-tarball",
      openclawTarball,
      "--slack-tarball",
      slackTarball,
      "--output",
      path.join(root, "bundle"),
    ]),
    /must contain version 2026\.6\.11/,
  );
});

async function createNodeFixture(root: string): Promise<string> {
  const nodeRoot = path.join(root, "node-v22.23.1-linux-x64");
  const tarball = path.join(root, "node-v22.23.1-linux-x64.tar.xz");
  await mkdir(path.join(nodeRoot, "bin"), { recursive: true });
  await writeFile(path.join(nodeRoot, "bin", "node"), "fixture\n", { mode: 0o755 });
  await run("tar", ["-cJf", tarball, "-C", root, path.basename(nodeRoot)]);
  return tarball;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function executable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, { mode: 0o700 });
  await chmod(file, 0o700);
}
