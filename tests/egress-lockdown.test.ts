import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { bootstrapInstallScript, normalizeEgressLockdownMode } from "../worker/bootstrap.js";

const run = promisify(execFile);

function installScript(egressLockdown: "attempt" | "required" | "off", archiveId = "c".repeat(64)): string {
  return bootstrapInstallScript({
    base: "https://crabhelm-runtime.example.test/bootstrap/child-id",
    archiveId,
    releaseId: "e".repeat(64),
    nodeSha256: "f".repeat(64),
    childId: "child-id",
    model: "openai/gpt-5.5",
    slack: "false",
    credentialsGeneration: 1,
    egressLockdown,
  });
}

// Stage a bundle fixture + curl stub so the whole installer runs offline, and
// return the archive digest plus a bin dir the caller can add tool stubs to.
async function stageInstall(): Promise<{
  root: string;
  home: string;
  bin: string;
  guestLog: string;
  archiveId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "crabhelm-egress-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const fixtures = path.join(root, "fixtures");
  const guestLog = path.join(root, "guest.log");
  await mkdir(path.join(fixtures, "bundle"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(fixtures, "bundle", "guest-install.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'guest-install ran\\n' >>\"$CRABHELM_TEST_LOG\"\n",
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
url=""; dest=""
while (($#)); do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */bundle.tgz) cp ${JSON.stringify(path.join(fixtures, "bundle.tgz"))} "$dest" ;;
  */credentials.env) printf 'OPENAI_API_KEY=k\\n' >"$dest" ;;
  */managed-spec.json) printf '{}\\n' >"$dest" ;;
  *) exit 22 ;;
esac
`,
    { mode: 0o755 },
  );
  await chmod(path.join(bin, "curl"), 0o755);
  return { root, home, bin, guestLog, archiveId };
}

test("egress lockdown mode normalizes unknown values to attempt and fails open", () => {
  assert.equal(normalizeEgressLockdownMode("required"), "required");
  assert.equal(normalizeEgressLockdownMode("off"), "off");
  assert.equal(normalizeEgressLockdownMode("attempt"), "attempt");
  assert.equal(normalizeEgressLockdownMode(undefined), "attempt");
  assert.equal(normalizeEgressLockdownMode(""), "attempt");
  assert.equal(normalizeEgressLockdownMode("Required"), "attempt");
  assert.equal(normalizeEgressLockdownMode("disabled"), "attempt");
});

test("generated installer embeds a metadata-blocking allowlist except when disabled", async () => {
  for (const mode of ["attempt", "required"] as const) {
    const script = installScript(mode);
    assert.match(script, /add table inet crabhelm_egress/u);
    assert.match(script, /ip daddr 169\.254\.169\.254 counter drop/u);
    assert.match(script, /ip6 daddr fd00:ec2::254 counter drop/u);
    assert.match(script, /policy drop/u);
    assert.match(script, /tcp dport \{ 53, 443 \} accept/u);
    assert.match(script, /list table inet crabhelm_egress/u);
    assert.match(script, /flush table inet crabhelm_egress/u);
    assert.ok(
      script.indexOf("ip daddr 169.254.169.254") < script.indexOf("ct state established,related accept"),
      "metadata drops must precede established-flow acceptance",
    );
    // The allowlist must be applied before the bundle download begins.
    assert.ok(script.indexOf("crabhelm_egress") < script.indexOf("bundle.tgz"));
    await run("/bin/bash", ["-n", "-c", script]);
  }
  const off = installScript("off");
  assert.doesNotMatch(off, /crabhelm_egress/u);
  assert.doesNotMatch(off, /169\.254\.169\.254/u);
  await run("/bin/bash", ["-n", "-c", off]);
});

// Full inherited PATH (coreutils such as sha256sum live outside bin) with the
// stub bin prepended so curl/nft/sudo stubs always win over host tools.
function stubPath(bin: string): string {
  return `${bin}:${process.env.PATH ?? ""}`;
}

async function writeStub(file: string, body: string): Promise<void> {
  await writeFile(file, body, { mode: 0o755 });
  await chmod(file, 0o755);
}

// Passwordless sudo stub so the non-root apply path runs in CI without real root.
async function writeSudoStub(bin: string): Promise<void> {
  await writeStub(path.join(bin, "sudo"), "#!/usr/bin/env bash\n[[ \"$1\" == \"-n\" ]] && shift\nexec \"$@\"\n");
}

test("required mode fails closed before install when the allowlist cannot apply", async () => {
  const { home, bin, guestLog, archiveId } = await stageInstall();
  // nft present but every apply is rejected, and sudo is available: the guest
  // can attempt the lockdown yet cannot enforce it, so required must abort.
  await writeStub(path.join(bin, "nft"), "#!/usr/bin/env bash\nexit 1\n");
  await writeSudoStub(bin);
  const script = installScript("required", archiveId);
  await assert.rejects(
    run("/bin/bash", ["-c", script], {
      env: {
        PATH: stubPath(bin),
        HOME: home,
        CRABHELM_BOOTSTRAP_TOKEN: "test-token",
        CRABHELM_TEST_LOG: guestLog,
      },
    }),
    /egress lockdown is required but the allowlist could not be applied/u,
  );
  await assert.rejects(readFile(guestLog, "utf8"), /ENOENT/u);
});

test("attempt mode installs the ruleset when nftables is reachable via sudo", async () => {
  const { home, bin, guestLog, archiveId } = await stageInstall();
  const nftLog = path.join(path.dirname(bin), "nft-ruleset.txt");
  await writeStub(
    path.join(bin, "nft"),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "list" ]]; then exit 1; fi
while (($#)); do case "$1" in -f) cp "$2" ${JSON.stringify(nftLog)} ;; esac; shift; done
exit 0
`,
  );
  await writeSudoStub(bin);

  const script = installScript("attempt", archiveId);
  const { stdout } = await run("/bin/bash", ["-c", script], {
    env: {
      PATH: stubPath(bin),
      HOME: home,
      CRABHELM_BOOTSTRAP_TOKEN: "test-token",
      CRABHELM_TEST_LOG: guestLog,
    },
  });
  assert.match(stdout, /outbound restricted to loopback/u);
  assert.equal(await readFile(guestLog, "utf8"), "guest-install ran\n");
  const ruleset = await readFile(nftLog, "utf8");
  assert.match(ruleset, /ip daddr 169\.254\.169\.254 counter drop/u);
  assert.match(ruleset, /policy drop/u);
});

test("lockdown retries atomically replace the existing table rules", async () => {
  const { home, bin, guestLog, archiveId } = await stageInstall();
  const nftLog = path.join(path.dirname(bin), "nft-ruleset.txt");
  await writeStub(
    path.join(bin, "nft"),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "list" ]]; then exit 0; fi
while (($#)); do case "$1" in -f) cp "$2" ${JSON.stringify(nftLog)} ;; esac; shift; done
exit 0
`,
  );
  await writeSudoStub(bin);

  await run("/bin/bash", ["-c", installScript("attempt", archiveId)], {
    env: {
      PATH: stubPath(bin),
      HOME: home,
      CRABHELM_BOOTSTRAP_TOKEN: "test-token",
      CRABHELM_TEST_LOG: guestLog,
    },
  });
  const ruleset = await readFile(nftLog, "utf8");
  assert.match(ruleset, /^flush table inet crabhelm_egress$/mu);
  assert.doesNotMatch(ruleset, /^add table /mu);
  assert.match(ruleset, /ip daddr 169\.254\.169\.254 counter drop/u);
  assert.equal(await readFile(guestLog, "utf8"), "guest-install ran\n");
});

test("attempt mode continues when nftables cannot be applied", async () => {
  const { home, bin, guestLog, archiveId } = await stageInstall();
  await writeStub(path.join(bin, "nft"), "#!/usr/bin/env bash\nexit 1\n");
  await writeSudoStub(bin);
  const script = installScript("attempt", archiveId);
  const { stdout } = await run("/bin/bash", ["-c", script], {
    env: {
      PATH: stubPath(bin),
      HOME: home,
      CRABHELM_BOOTSTRAP_TOKEN: "test-token",
      CRABHELM_TEST_LOG: guestLog,
    },
  });
  assert.match(stdout, /skipped \(nftables unavailable or not permitted\)/u);
  assert.equal(await readFile(guestLog, "utf8"), "guest-install ran\n");
});
