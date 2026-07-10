import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { bootstrapInstallScript, normalizeEgressLockdownMode } from "../worker/bootstrap.js";

const run = promisify(execFile);

function installScript(
  egressLockdown: "required" | "off",
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
    policyHash: "a".repeat(64),
    egressLockdown,
    egressPersistenceRoot,
  });
}

async function writeExecutable(file: string, body: string): Promise<void> {
  await writeFile(file, body, { mode: 0o755 });
  await chmod(file, 0o755);
}

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
  await mkdir(path.join(root, "run/systemd/system"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeExecutable(
    path.join(fixtures, "bundle", "guest-install.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'guest-install ran\\n' >>\"$CRABHELM_TEST_LOG\"\n",
  );
  await run("tar", ["-czf", path.join(fixtures, "bundle.tgz"), "-C", fixtures, "bundle"]);
  const archiveId = createHash("sha256").update(await readFile(path.join(fixtures, "bundle.tgz"))).digest("hex");
  await writeExecutable(
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
  */credentials.env*) printf 'OPENAI_API_KEY=k\\n' >"$dest" ;;
  */managed-spec.json*) printf '{}\\n' >"$dest" ;;
  *) exit 22 ;;
esac
`,
  );
  await writeExecutable(path.join(bin, "sudo"), "#!/usr/bin/env bash\n[[ \"$1\" == -n ]] && shift\nexec \"$@\"\n");
  await writeExecutable(path.join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(path.join(bin, "id"), "#!/usr/bin/env bash\nprintf '0\\n'\n");
  return { root, home, bin, guestLog, archiveId };
}

function testEnv(home: string, bin: string, guestLog: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    CRABHELM_BOOTSTRAP_TOKEN: "test-token",
    CRABHELM_TEST_LOG: guestLog,
  };
}

test("egress mode defaults fail closed", () => {
  assert.equal(normalizeEgressLockdownMode("required"), "required");
  assert.equal(normalizeEgressLockdownMode("off"), "off");
  for (const value of [undefined, "", "attempt", "Required", "disabled"]) {
    assert.equal(normalizeEgressLockdownMode(value), "required");
  }
});

test("generated installer isolates the agent behind a boot-persistent live-verified allowlist", async () => {
  const script = installScript("required");
  assert.match(script, /ip daddr 169\.254\.169\.254 counter drop/u);
  assert.match(script, /ip6 daddr fd00:ec2::254 counter drop/u);
  assert.match(script, /policy accept/u);
  assert.match(script, /meta skuid \$agent_uid tcp dport \{ 53, 443 \} accept/u);
  assert.match(script, /WantedBy=multi-user\.target/u);
  assert.match(script, /ExecStartPost=\$egress_verify_path --verify/u);
  assert.match(script, /User=crabhelm-agent/u);
  assert.match(script, /NoNewPrivileges=true/u);
  assert.match(script, /ProtectSystem=strict/u);
  assert.match(script, /Requires=crabhelm-egress\.service/u);
  assert.match(script, /pkill -TERM -u "\$agent_uid"/u);
  assert.match(script, /stat -c '%u' "\/proc\/\$main_pid"/u);
  assert.match(script, /"\$process_uid" = "\$agent_uid"/u);
  assert.doesNotMatch(script, /ct state established,related accept/u);
  assert.ok(script.indexOf("crabhelm_egress") < script.indexOf("bundle.tgz"));
  await run("/bin/bash", ["-n", "-c", script]);

  const off = installScript("off");
  assert.match(off, /delete table inet crabhelm_egress/u);
  assert.doesNotMatch(off, /169\.254\.169\.254/u);
  assert.doesNotMatch(off, /Requires=crabhelm-egress\.service/u);
  await run("/bin/bash", ["-n", "-c", off]);
});

test("required mode fails before credentials when nftables cannot apply", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
  await writeExecutable(path.join(bin, "nft"), "#!/usr/bin/env bash\nexit 1\n");
  await assert.rejects(
    run("/bin/bash", ["-c", installScript("required", archiveId, root)], {
      env: testEnv(home, bin, guestLog),
    }),
    /egress lockdown is required/u,
  );
  await assert.rejects(readFile(guestLog, "utf8"), /ENOENT/u);
});

test("required mode installs, live-verifies, and records the trusted policy", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
  const nftState = path.join(root, "nft-active");
  await writeExecutable(
    path.join(bin, "nft"),
    `#!/usr/bin/env bash
case "\${1:-}" in
  -f) touch ${JSON.stringify(nftState)} ;;
  list)
    if [[ "\${2:-}" == table ]]; then [[ -f ${JSON.stringify(nftState)} ]]; else
      cat <<'RULES'
table inet crabhelm_egress {
 chain output { type filter hook output priority filter; policy accept;
  meta skuid 0 oifname "lo" accept
  meta skuid 0 ip daddr 169.254.169.254 counter packets 0 bytes 0 drop
  meta skuid 0 ip6 daddr fd00:ec2::254 counter packets 0 bytes 0 drop
  meta skuid 0 udp dport { 53, 67, 68, 123, 546, 547 } accept
  meta skuid 0 tcp dport { 53, 443 } accept
  meta skuid 0 counter packets 0 bytes 0 drop comment "default agent egress deny"
 }
}
RULES
    fi ;;
  delete) rm -f ${JSON.stringify(nftState)} ;;
  *) exit 1 ;;
esac
`,
  );
  await run("/bin/bash", ["-c", installScript("required", archiveId, root)], {
    env: testEnv(home, bin, guestLog),
  });
  assert.equal(await readFile(guestLog, "utf8"), "guest-install ran\n");
  assert.equal(await readFile(path.join(root, "var/lib/crabhelm/egress-policy"), "utf8"), "v2:required\n");
  assert.equal((await stat(path.join(root, "usr/local/sbin/crabhelm-egress-apply"))).mode & 0o777, 0o500);
  assert.equal((await stat(path.join(root, "usr/local/sbin/crabhelm-egress-verify"))).mode & 0o777, 0o500);
});

test("off mode removes managed persistence and still installs safely", async () => {
  const { root, home, bin, guestLog, archiveId } = await stageInstall();
  await writeExecutable(path.join(bin, "nft"), "#!/usr/bin/env bash\nexit 1\n");
  await run("/bin/bash", ["-c", installScript("off", archiveId, root)], {
    env: testEnv(home, bin, guestLog),
  });
  assert.equal(await readFile(guestLog, "utf8"), "guest-install ran\n");
  assert.equal(await readFile(path.join(root, "var/lib/crabhelm/egress-policy"), "utf8"), "v2:off\n");
});
