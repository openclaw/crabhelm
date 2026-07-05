import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { bootstrapInstallScript, normalizeEgressLockdownMode } from "../worker/bootstrap.js";

const run = promisify(execFile);

function installScript(
  egressLockdown: "attempt" | "required" | "off",
  archiveId = "c".repeat(64),
  egressPersistenceRoot?: string,
): string {
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
    egressPersistenceRoot,
  });
}

// Stage a bundle fixture + curl stub so the whole installer runs offline, and
// return the archive digest plus a bin dir the caller can add tool stubs to.
async function stageInstall(systemd = true): Promise<{
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
  if (systemd) await mkdir(path.join(root, "run/systemd/system"), { recursive: true });
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
    assert.match(script, /Before=network-pre\.target/u);
    assert.match(script, /After=local-fs\.target nftables\.service/u);
    assert.match(script, /WantedBy=multi-user\.target/u);
    assert.doesNotMatch(script, /ct state established,related accept/u);
    // The allowlist must be applied before the bundle download begins.
    assert.ok(script.indexOf("crabhelm_egress") < script.indexOf("bundle.tgz"));
    await run("/bin/bash", ["-n", "-c", script]);
  }
  const off = installScript("off");
  assert.match(off, /delete table inet crabhelm_egress/u);
  assert.match(off, /disable --now crabhelm-egress\.service/u);
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

async function writeSystemctlStub(bin: string): Promise<void> {
  await writeStub(path.join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
}

test("required mode fails closed before install when the allowlist cannot apply", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
  // nft present but every apply is rejected, and sudo is available: the guest
  // can attempt the lockdown yet cannot enforce it, so required must abort.
  await writeStub(path.join(bin, "nft"), "#!/usr/bin/env bash\nexit 1\n");
  await writeSudoStub(bin);
  await writeSystemctlStub(bin);
  const script = installScript("required", archiveId, root);
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
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
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
  await writeSystemctlStub(bin);

  const script = installScript("attempt", archiveId, root);
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
  const applyPath = path.join(root, "usr/local/sbin/crabhelm-egress-apply");
  const unitPath = path.join(root, "etc/systemd/system/crabhelm-egress.service");
  assert.equal((await stat(applyPath)).mode & 0o777, 0o500);
  assert.equal((await stat(unitPath)).mode & 0o777, 0o644);
  assert.match(await readFile(unitPath, "utf8"), /Before=network-pre\.target/u);
  assert.match(await readFile(unitPath, "utf8"), new RegExp(`ExecStart=${applyPath}`));
});

test("lockdown retries atomically replace the existing table rules", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
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
  await writeSystemctlStub(bin);

  await run("/bin/bash", ["-c", installScript("attempt", archiveId, root)], {
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

test("off mode removes the live table and boot persistence", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
  const nftState = path.join(root, "nft-active");
  await writeStub(
    path.join(bin, "nft"),
    `#!/usr/bin/env bash
case "\${1:-}" in
  list) [[ -f ${JSON.stringify(nftState)} ]] ;;
  delete) rm -f ${JSON.stringify(nftState)} ;;
  -f) touch ${JSON.stringify(nftState)} ;;
  *) exit 1 ;;
esac
`,
  );
  await writeSudoStub(bin);
  await writeSystemctlStub(bin);
  const env = {
    PATH: stubPath(bin),
    HOME: home,
    CRABHELM_BOOTSTRAP_TOKEN: "test-token",
    CRABHELM_TEST_LOG: guestLog,
  };

  await run("/bin/bash", ["-c", installScript("attempt", archiveId, root)], { env });
  assert.equal(await readFile(nftState, "utf8"), "");
  await run("/bin/bash", ["-c", installScript("off", archiveId, root)], { env });

  await assert.rejects(readFile(path.join(root, "usr/local/sbin/crabhelm-egress-apply"), "utf8"), /ENOENT/u);
  await assert.rejects(readFile(path.join(root, "etc/systemd/system/crabhelm-egress.service"), "utf8"), /ENOENT/u);
  await assert.rejects(readFile(nftState, "utf8"), /ENOENT/u);
  assert.equal(await readFile(guestLog, "utf8"), "guest-install ran\nguest-install ran\n");
});

test("off mode removes a legacy live table without running systemd", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall(false);
  const nftState = path.join(root, "nft-active");
  await writeFile(nftState, "active\n");
  await writeStub(
    path.join(bin, "nft"),
    `#!/usr/bin/env bash
case "\${1:-}" in
  list) [[ -f ${JSON.stringify(nftState)} ]] ;;
  delete) rm -f ${JSON.stringify(nftState)} ;;
  *) exit 1 ;;
esac
`,
  );
  await writeSudoStub(bin);
  await writeStub(path.join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 1\n");

  await run("/bin/bash", ["-c", installScript("off", archiveId, root)], {
    env: {
      PATH: stubPath(bin),
      HOME: home,
      CRABHELM_BOOTSTRAP_TOKEN: "test-token",
      CRABHELM_TEST_LOG: guestLog,
    },
  });
  await assert.rejects(readFile(nftState, "utf8"), /ENOENT/u);
  assert.equal(await readFile(guestLog, "utf8"), "guest-install ran\n");
});

test("attempt mode skips cleanly when systemd is not running", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall(false);
  const nftApply = path.join(root, "nft-applied");
  await writeStub(
    path.join(bin, "nft"),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "-f" ]]; then touch ${JSON.stringify(nftApply)}; fi
exit 0
`,
  );
  await writeSudoStub(bin);
  await writeSystemctlStub(bin);

  const { stdout } = await run(
    "/bin/bash",
    ["-c", installScript("attempt", archiveId, root)],
    {
      env: {
        PATH: stubPath(bin),
        HOME: home,
        CRABHELM_BOOTSTRAP_TOKEN: "test-token",
        CRABHELM_TEST_LOG: guestLog,
      },
    },
  );
  assert.match(stdout, /skipped \(nftables unavailable or not permitted\)/u);
  await assert.rejects(readFile(nftApply, "utf8"), /ENOENT/u);
  await assert.rejects(readFile(path.join(root, "usr/local/sbin/crabhelm-egress-apply"), "utf8"), /ENOENT/u);
  assert.equal(await readFile(guestLog, "utf8"), "guest-install ran\n");
});

test("failed persistence upgrade stops when a legacy live-only table cannot be restored", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
  const nftState = path.join(root, "nft-active");
  await writeFile(nftState, "active\n");
  await writeStub(
    path.join(bin, "nft"),
    `#!/usr/bin/env bash
case "\${1:-}" in
  list) [[ -f ${JSON.stringify(nftState)} ]] ;;
  delete) rm -f ${JSON.stringify(nftState)} ;;
  -f) touch ${JSON.stringify(nftState)} ;;
  *) exit 1 ;;
esac
`,
  );
  await writeSudoStub(bin);
  await writeStub(
    path.join(bin, "systemctl"),
    "#!/usr/bin/env bash\ncase \"${1:-}\" in enable) exit 1 ;; is-enabled) exit 1 ;; *) exit 0 ;; esac\n",
  );

  await assert.rejects(
    run("/bin/bash", ["-c", installScript("attempt", archiveId, root)], {
      env: {
        PATH: stubPath(bin),
        HOME: home,
        CRABHELM_BOOTSTRAP_TOKEN: "test-token",
        CRABHELM_TEST_LOG: guestLog,
      },
    }),
    /prior state could not be restored/u,
  );
  assert.equal(await readFile(nftState, "utf8"), "active\n");
  await assert.rejects(readFile(path.join(root, "usr/local/sbin/crabhelm-egress-apply"), "utf8"), /ENOENT/u);
  await assert.rejects(readFile(path.join(root, "etc/systemd/system/crabhelm-egress.service"), "utf8"), /ENOENT/u);
  await assert.rejects(readFile(guestLog, "utf8"), /ENOENT/u);
});

test("failed persistence update restores the prior boot configuration", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
  const applyPath = path.join(root, "usr/local/sbin/crabhelm-egress-apply");
  const unitPath = path.join(root, "etc/systemd/system/crabhelm-egress.service");
  const restoredMarker = path.join(root, "restored-old-policy");
  const enableCounter = path.join(root, "enable-attempted");
  await mkdir(path.dirname(applyPath), { recursive: true });
  await mkdir(path.dirname(unitPath), { recursive: true });
  const oldApply = `#!/bin/bash\ntouch ${JSON.stringify(restoredMarker)}\n`;
  const oldUnit = "[Unit]\nDescription=prior policy\n";
  await writeFile(applyPath, oldApply, { mode: 0o500 });
  await chmod(applyPath, 0o500);
  await writeFile(unitPath, oldUnit, { mode: 0o644 });
  await writeStub(
    path.join(bin, "nft"),
    "#!/usr/bin/env bash\ncase \"${1:-}\" in list) exit 1 ;; -f) exit 0 ;; *) exit 0 ;; esac\n",
  );
  await writeSudoStub(bin);
  await writeStub(
    path.join(bin, "systemctl"),
    `#!/usr/bin/env bash
case "\${1:-}" in
  is-enabled|daemon-reload) exit 0 ;;
  enable)
    if [[ -e ${JSON.stringify(enableCounter)} ]]; then exit 0; fi
    touch ${JSON.stringify(enableCounter)}
    exit 1
    ;;
  *) exit 0 ;;
esac
`,
  );

  const { stdout } = await run(
    "/bin/bash",
    ["-c", installScript("attempt", archiveId, root)],
    {
      env: {
        PATH: stubPath(bin),
        HOME: home,
        CRABHELM_BOOTSTRAP_TOKEN: "test-token",
        CRABHELM_TEST_LOG: guestLog,
      },
    },
  );
  assert.match(stdout, /skipped \(nftables unavailable or not permitted\)/u);
  assert.equal(await readFile(applyPath, "utf8"), oldApply);
  assert.equal(await readFile(unitPath, "utf8"), oldUnit);
  assert.equal(await readFile(restoredMarker, "utf8"), "");
  assert.equal(await readFile(guestLog, "utf8"), "guest-install ran\n");
});

test("failed legacy unit backup stops and removes staged persistence files", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
  const unitDirectory = path.join(root, "etc/systemd/system");
  const unitPath = path.join(unitDirectory, "crabhelm-egress.service");
  const nftState = path.join(root, "nft-active");
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(unitPath, "[Unit]\nDescription=legacy live-only policy\n");
  await writeFile(nftState, "active\n");
  await writeStub(
    path.join(bin, "nft"),
    `#!/usr/bin/env bash
case "\${1:-}" in
  list) [[ -f ${JSON.stringify(nftState)} ]] ;;
  -f) touch ${JSON.stringify(nftState)} ;;
  *) exit 0 ;;
esac
`,
  );
  await writeSudoStub(bin);
  await writeSystemctlStub(bin);
  await writeStub(path.join(bin, "cp"), "#!/usr/bin/env bash\nexit 1\n");

  await assert.rejects(
    run("/bin/bash", ["-c", installScript("attempt", archiveId, root)], {
      env: {
        PATH: stubPath(bin),
        HOME: home,
        CRABHELM_BOOTSTRAP_TOKEN: "test-token",
        CRABHELM_TEST_LOG: guestLog,
      },
    }),
    /prior state could not be restored/u,
  );
  assert.deepEqual(await readdir(path.join(root, "usr/local/sbin")), []);
  assert.deepEqual((await readdir(unitDirectory)).sort(), ["crabhelm-egress.service", "multi-user.target.wants"]);
  await assert.rejects(readFile(guestLog, "utf8"), /ENOENT/u);
});

test("attempt mode continues when nftables cannot be applied", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
  await writeStub(path.join(bin, "nft"), "#!/usr/bin/env bash\nexit 1\n");
  await writeSudoStub(bin);
  await writeSystemctlStub(bin);
  const script = installScript("attempt", archiveId, root);
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
