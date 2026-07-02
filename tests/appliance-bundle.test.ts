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
  const slackSource = path.join(root, "slack-source");
  const slackTarball = path.join(root, "slack.tgz");
  const output = path.join(root, "bundle");
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "2026.6.11-beta.1" })}\n`,
  );
  await run("tar", ["-czf", openclawTarball, "-C", source, "package"]);
  await mkdir(path.join(slackSource, "package"), { recursive: true });
  await writeFile(
    path.join(slackSource, "package", "package.json"),
    `${JSON.stringify({ name: "@openclaw/slack", version: "2026.6.10" })}\n`,
  );
  await run("tar", ["-czf", slackTarball, "-C", slackSource, "package"]);

  const built = await run(builder, [
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
  assert.equal(manifest.openclaw.version, "2026.6.11-beta.1");
  assert.equal(manifest.slack.version, "2026.6.10");
  assert.equal(manifest.crabhelm.version, "0.0.0");
  assert.equal(manifest.openclaw.sha256, digest(await readFile(path.join(output, manifest.openclaw.file))));
  assert.equal(manifest.slack.sha256, digest(await readFile(path.join(output, manifest.slack.file))));
  assert.equal(manifest.crabhelm.sha256, digest(await readFile(path.join(output, manifest.crabhelm.file))));
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
  await mkdir(bin);
  await mkdir(home);
  await writeFile(
    credentialSource,
    "OPENAI_API_KEY=test-only\nSLACK_BOT_TOKEN=test-only\nSLACK_APP_TOKEN=test-only\n",
    { mode: 0o600 },
  );
  await executable(path.join(bin, "sudo"), "#!/usr/bin/env bash\n[[ \"${1:-}\" = -n ]] && shift\nexec \"$@\"\n");
  await executable(path.join(bin, "npm"), `#!/usr/bin/env bash
printf 'npm auth=%s/%s ' "\${OPENCLAW_GATEWAY_TOKEN+present}" "\${OPENCLAW_GATEWAY_PASSWORD+present}" >>"${log}"
printf '%q ' "$@" >>"${log}"
printf '\n' >>"${log}"
`);
  await executable(path.join(bin, "openclaw"), `#!/usr/bin/env bash
if [[ "\${1:-}" = --version ]]; then
  printf '%s\n' 'OpenClaw 2026.6.11-beta.1 (test)'
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
      CRABHELM_CREDENTIAL_FILE: credentialSource,
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

  await chmod(credentialSource, 0o644);
  await assert.rejects(
    run("/bin/bash", [path.join(output, "guest-install.sh")], { env: guestEnv }),
    /child credential source must be owner-only/,
  );
  assert.equal(await readFile(log, "utf8"), calls);
  await chmod(credentialSource, 0o600);

  const crabhelmArtifact = path.join(output, manifest.crabhelm.file);
  await chmod(crabhelmArtifact, 0o600);
  await writeFile(crabhelmArtifact, "tampered\n");
  await assert.rejects(
    run("/bin/bash", [path.join(output, "guest-install.sh")], { env: guestEnv }),
    /bundle artifact digest mismatch: artifacts\/crabhelm\.tgz/,
  );
  assert.equal(await readFile(log, "utf8"), calls);
});

test("appliance builder rejects a different OpenClaw version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crabhelm-appliance-version-"));
  const source = path.join(root, "source");
  const packageDir = path.join(source, "package");
  const openclawTarball = path.join(root, "openclaw.tgz");
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
    `${JSON.stringify({ name: "@openclaw/slack", version: "2026.6.10" })}\n`,
  );
  await run("tar", ["-czf", slackTarball, "-C", slackSource, "package"]);
  await assert.rejects(
    run(builder, [
      "--openclaw-tarball",
      openclawTarball,
      "--slack-tarball",
      slackTarball,
      "--output",
      path.join(root, "bundle"),
    ]),
    /must contain version 2026\.6\.11-beta\.1/,
  );
});

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function executable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, { mode: 0o700 });
  await chmod(file, 0o700);
}
