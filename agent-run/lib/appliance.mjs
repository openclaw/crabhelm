import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, symlinkSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, run } from "./proc.mjs";
import { quote } from "./shell.mjs";
import { sshCommand } from "./crabbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function loadPins(path = join(here, "..", "appliances.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function indexPath(config) {
  return join(config.cacheDir, "appliances", "index.json");
}

function readIndex(config) {
  try { return JSON.parse(readFileSync(indexPath(config), "utf8")); } catch { return {}; }
}

// A name no other process or call uses, for temporary files in shared cache directories.
function uniqueSuffix() {
  return process.pid + "-" + randomBytes(6).toString("hex");
}

// Write a shared cache file so readers see the old file or the complete new one.
function writeFileAtomic(path, data, options) {
  const tmp = path + "." + uniqueSuffix() + ".tmp";
  try {
    writeFileSync(tmp, data, options);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Cross-process cache locks.
//
// A lock is a directory. Each contender owns one file in it, named
// <host>.<pid>.<process start>.<random>. A contender creates its file only
// when no live owner is present, then lists the directory again: if another
// live owner appeared, it removes its file and retries. Of two contenders,
// the one that created its file later always sees the earlier file, so two
// processes never both hold the lock.
//
// No file is ever taken over. A file whose process is gone is ignored and
// deleted; its name is never reused, so deleting it cannot release a live
// owner. Age is not used: a slow build keeps its lock for as long as it runs.
const HOST_ID = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
const OWNER_NAME = /^([0-9a-f]{12})\.(\d+)\.([0-9a-f]+)\.[0-9a-f]+$/;
const heldLocks = new Set();
let exitHookInstalled = false;

// Identifies one process even when its pid is reused later. "0": unknown.
function processStartId(pid) {
  try {
    let raw = "";
    if (process.platform === "linux") {
      const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
      raw = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] ?? "";
    } else if (process.platform === "darwin") {
      // Fixed TZ and locale: the text must be the same from every process.
      raw = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { PATH: "/bin:/usr/bin", TZ: "UTC", LC_ALL: "C" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    }
    return raw ? createHash("sha256").update(raw).digest("hex").slice(0, 12) : "0";
  } catch {
    return "0";
  }
}

let ownStartId;

// False only on proof that the owner process is gone. Anything unclear
// (another host, no permission, no start time) counts as alive.
function ownerAlive(name, verified) {
  const match = OWNER_NAME.exec(name);
  if (!match) return true;
  const [, host, pidText, startId] = match;
  if (host !== HOST_ID) return true;
  const pid = Number(pidText);
  if (pid === process.pid) return startId === "0" || ownStartId === "0" || startId === ownStartId;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
  if (startId === "0" || verified.has(name)) return true;
  const current = processStartId(pid);
  if (current === "0") return true;
  if (current !== startId) return false;
  verified.add(name);
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withCacheLock(config, name, { log, waitMessage } = {}, action) {
  ownStartId ??= processStartId(process.pid);
  const dir = join(config.cacheDir, "locks", name.replace(/[^A-Za-z0-9._-]/g, "_"));
  const mine = [HOST_ID, process.pid, ownStartId, randomBytes(6).toString("hex")].join(".");
  const path = join(dir, mine);
  const verified = new Set();
  const liveOthers = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const live = [];
    for (const entry of readdirSync(dir)) {
      if (entry === mine) continue;
      if (ownerAlive(entry, verified)) live.push(entry);
      else rmSync(join(dir, entry), { force: true });
    }
    return live;
  };
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => { for (const held of heldLocks) rmSync(held, { force: true }); });
  }
  let told = false;
  for (;;) {
    let live = liveOthers();
    if (live.length === 0) {
      heldLocks.add(path);
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      live = liveOthers();
      if (live.length === 0) break;
      // Another contender arrived at the same moment. Step back; random delays separate the retries.
      rmSync(path, { force: true });
      heldLocks.delete(path);
      await sleep(10 + Math.random() * 90);
      continue;
    }
    if (!told && waitMessage) {
      log?.write(waitMessage(Number(OWNER_NAME.exec(live[0])?.[2])));
      told = true;
    }
    await sleep(100);
  }
  try {
    return await action();
  } finally {
    rmSync(path, { force: true });
    heldLocks.delete(path);
  }
}

// One build per appliance key at a time, across processes.
function withBuildLock(config, key, log, action) {
  return withCacheLock(config, "appliance-build-" + key, {
    log,
    waitMessage: (pid) => "agent-run: waiting for pid " + pid + " to finish building appliance " + key + "\n",
  }, action);
}

// Add one entry to index.json. The lock covers read, change and write, so
// concurrent builds of different appliances all keep their entries.
async function publishIndexEntry(config, key, entry) {
  await withCacheLock(config, "appliance-index", {}, () => {
    const index = readIndex(config);
    index[key] = entry;
    writeFileAtomic(indexPath(config), JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
  });
}

export function applianceKey(pins, harness) {
  const spec = pins.harnesses[harness];
  if (!spec) throw new Error("no appliance pin for harness " + harness);
  if (spec.artifact) return harness + "-" + spec.version + "-" + spec.platform + "-" + spec.artifact.sha256.slice(0, 12);
  return harness + "-" + spec.version + "-node" + pins.node.version;
}

// Cached appliance for a harness, verified against the sha256 recorded when
// it was built. Returns undefined when it must be built first.
export async function cachedAppliance(config, pins, harness) {
  const key = applianceKey(pins, harness);
  const entry = readIndex(config)[key];
  if (!entry || !existsSync(entry.path)) return undefined;
  const sha256 = await sha256File(entry.path);
  if (sha256 !== entry.sha256) throw new Error("cached appliance " + key + " does not match its recorded sha256; delete " + entry.path + " and rebuild");
  return { ...entry, key };
}

async function nodeTarball(config, pins, log) {
  const dir = join(config.cacheDir, "node");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "node-v" + pins.node.version + "-linux-x64.tar.gz");
  if (existsSync(path) && await sha256File(path) === pins.node.sha256) return path;
  log.write("agent-run: downloading Node " + pins.node.version + " for linux-x64\n");
  const response = await fetch(pins.node.url);
  if (!response.ok) throw new Error("Node download failed: HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pins.node.sha256) throw new Error("Node tarball sha256 mismatch");
  writeFileAtomic(path, bytes);
  return path;
}

async function pinnedArtifact(config, spec, fetcher, runner, log) {
  const dir = join(config.cacheDir, "artifacts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const suffix = spec.artifact.format === "binary" ? ".bin" : ".tgz";
  const path = join(dir, spec.package + "-" + spec.version + "-" + spec.artifact.sha256.slice(0, 12) + suffix);
  if (existsSync(path) && await sha256File(path) === spec.artifact.sha256) return path;
  log.write("agent-run: downloading pinned " + spec.package + " " + spec.version + " for " + spec.platform + "\n");
  const downloadDir = mkdtempSync(join(dir, "download-"));
  try {
    let bytes;
    if (spec.artifact.githubRelease) {
      const release = spec.artifact.githubRelease;
      const result = await runner("gh", [
        "release", "download", release.tag, "--repo", release.repo,
        "--pattern", release.asset, "--dir", downloadDir,
      ], { env: childEnv(process.env, { GH_PROMPT_DISABLED: "1" }) });
      if (result.code !== 0) throw new Error("GitHub release download failed: " + result.stderr.trim().split("\n").at(-1));
      const downloaded = join(downloadDir, release.asset);
      if (!existsSync(downloaded)) throw new Error("GitHub release download did not create " + release.asset);
      bytes = readFileSync(downloaded);
    } else {
      const response = await fetcher(spec.artifact.url);
      if (!response.ok) throw new Error("release artifact download failed: HTTP " + response.status);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== spec.artifact.sha256) throw new Error("release artifact sha256 mismatch");
    writeFileAtomic(path, bytes, { mode: 0o600 });
    return path;
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

// The box: linux, x64, glibc (Ubuntu). npm records os/cpu/libc for platform-specific packages.
const TARGET = { os: "linux", cpu: "x64", libc: "glibc" };

function allows(list, value) {
  if (!list?.length) return true;
  if (list.includes("!" + value)) return false;
  const positive = list.filter((item) => !item.startsWith("!"));
  return positive.length === 0 || positive.includes(value);
}

// Lockfile entries the box needs, with their pinned URL and integrity.
export function boxPackages(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path !== "" && !entry.link && !entry.dev)
    .filter(([, entry]) => allows(entry.os, TARGET.os) && allows(entry.cpu, TARGET.cpu) && allows(entry.libc, TARGET.libc))
    .map(([path, entry]) => {
      if (!entry.resolved || !entry.integrity) throw new Error("lockfile entry " + path + " has no resolved URL or integrity");
      return { path, resolved: entry.resolved, integrity: entry.integrity, installScript: Boolean(entry.hasInstallScript) };
    });
}

export function integrityMatches(integrity, bytes) {
  return integrity.split(/\s+/).filter((item) => /^sha(512|384|256)-/.test(item)).some((item) => {
    const [algorithm, expected] = [item.slice(0, item.indexOf("-")), item.slice(item.indexOf("-") + 1)];
    return createHash(algorithm).update(bytes).digest("base64") === expected;
  });
}

function appPackageJson(spec) {
  return JSON.stringify({ name: "agent-run-appliance", private: true, dependencies: { [spec.package]: spec.version } }, null, 2) + "\n";
}

// Resolve the dependency tree on the laptop (registry metadata only) and
// download the box's tarballs here: the broker boxes' internet egress is
// slow (about 6 KB/s from the npm registry on 2026-11-07), while the
// laptop-to-box SSH relay is fast. Each tarball is checked against the
// lockfile integrity before it is used.
async function stageInputs({ config, pins, harness, node, runner, log }) {
  const spec = pins.harnesses[harness];
  const stage = mkdtempSync(join(config.cacheDir, "build-"));
  mkdirSync(join(stage, "app"));
  mkdirSync(join(stage, "tarballs"));
  writeFileSync(join(stage, "app", "package.json"), appPackageJson(spec));
  const locked = await runner("npm", ["install", "--package-lock-only", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: join(stage, "app") });
  if (locked.code !== 0) throw new Error("npm could not resolve " + spec.package + "@" + spec.version + ": " + locked.stderr.trim().split("\n").at(-1));
  const lock = JSON.parse(readFileSync(join(stage, "app", "package-lock.json"), "utf8"));
  const packages = boxPackages(lock);
  log.write("agent-run: downloading " + packages.length + " npm tarballs for linux-x64\n");
  let index = 0;
  const worker = async () => {
    while (index < packages.length) {
      const item = packages[index];
      const file = join(stage, "tarballs", String(index++).padStart(4, "0") + ".tgz");
      const response = await fetch(item.resolved);
      if (!response.ok) throw new Error("download failed for " + item.path + ": HTTP " + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!integrityMatches(item.integrity, bytes)) throw new Error("integrity mismatch for " + item.path);
      writeFileSync(file, bytes);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  copyFileSync(node, join(stage, "node.tgz"));
  return { stage, installScripts: packages.filter((p) => p.installScript).map((p) => p.path), lockSha256: createHash("sha256").update(readFileSync(join(stage, "app", "package-lock.json"))).digest("hex") };
}

export function buildScript(pins, harness, workdir, { lockSha256 } = {}) {
  const spec = pins.harnesses[harness];
  const manifest = JSON.stringify({ harness, package: spec.package, version: spec.version, bin: spec.bin, node: pins.node.version, lockSha256 });
  return [
    "set -eu",
    "W=" + quote(workdir),
    "rm -rf \"$W\"; mkdir -p \"$W/in\" \"$W/a/node\" \"$W/a/app\" \"$W/home\"; cd \"$W\"",
    "tar -xf - -C in",
    "echo " + quote(pins.node.sha256 + "  in/node.tgz") + " | sha256sum -c - >&2",
    "tar -xzf in/node.tgz -C a/node --strip-components=1",
    "export HOME=\"$W/home\" PATH=\"$W/a/node/bin:$PATH\" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false",
    "cp in/app/package.json in/app/package-lock.json a/app/",
    "npm cache add in/tarballs/*.tgz >&2",
    "cd a/app",
    "npm ci --offline --omit=dev >&2",
    "rm -rf \"$W/in\" \"$HOME/.npm\"",
    "test -x node_modules/.bin/" + quote(spec.bin),
    "cd \"$W/a\"",
    "printf '%s\\n' " + quote(manifest) + " > agent-run-appliance.json",
    "echo 'agent-run: appliance contents ready' >&2",
    "tar -czf - .",
    "cd /; rm -rf \"$W\"",
  ].join("\n");
}

// With no install scripts, npm only unpacks verified tarballs, so the
// laptop can assemble the linux-x64 tree itself (npm --os/--cpu/--libc pick
// the box's optional packages). This avoids a slow round trip through a
// lease. Node stays packed as node.tgz; the box unpacks it per run.
async function assembleLocally({ stage, pins, harness, lockSha256, partial, runner }) {
  const spec = pins.harnesses[harness];
  const cache = join(stage, "npm-cache");
  const tarballs = (await runner("ls", [join(stage, "tarballs")])).stdout.trim().split("\n").map((name) => join(stage, "tarballs", name));
  const npm = (args) => runner("npm", [...args, "--cache", cache, "--no-audit", "--no-fund"], { cwd: join(stage, "app") });
  const added = await npm(["cache", "add", ...tarballs]);
  if (added.code !== 0) throw new Error("npm cache add failed: " + added.stderr.trim().split("\n").at(-1));
  const installed = await npm(["ci", "--offline", "--omit=dev", "--ignore-scripts", "--os=linux", "--cpu=x64", "--libc=glibc"]);
  if (installed.code !== 0) throw new Error("npm ci failed: " + installed.stderr.trim().split("\n").at(-1));
  const parts = ["node.tgz", "app", "agent-run-appliance.json"];
  if (spec.entry) {
    // The pin names the real executable (for example a native binary that an
    // install script would have copied over a stub); link it as bin/<bin>.
    if (!existsSync(join(stage, "app", spec.entry))) throw new Error("npm ci did not install " + spec.entry);
    mkdirSync(join(stage, "bin"));
    symlinkSync(join("..", "app", spec.entry), join(stage, "bin", spec.bin));
    parts.push("bin");
  } else if (!existsSync(join(stage, "app", "node_modules", ".bin", spec.bin))) {
    throw new Error("npm ci did not install " + spec.bin);
  }
  writeFileSync(join(stage, "agent-run-appliance.json"), JSON.stringify({ harness, package: spec.package, version: spec.version, bin: spec.bin, node: pins.node.version, lockSha256, assembled: "laptop" }) + "\n");
  rmSync(cache, { recursive: true, force: true });
  const packed = await runner("tar", ["-czf", partial, "-C", stage, ...parts], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (packed.code !== 0) throw new Error("could not pack the appliance");
}

async function buildPinnedArtifactAppliance({ config, pins, harness, log, runner, fetcher }) {
  const spec = pins.harnesses[harness];
  const key = applianceKey(pins, harness);
  const dir = join(config.cacheDir, "appliances");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partial = join(dir, key + ".tgz.partial-" + uniqueSuffix());
  const stage = mkdtempSync(join(config.cacheDir, "build-"));
  try {
    const asset = await pinnedArtifact(config, spec, fetcher, runner, log);
    const binary = join(stage, "bin", spec.bin);
    mkdirSync(join(stage, "bin"));
    const bundleParts = [];
    if (spec.artifact.format === "binary") {
      copyFileSync(asset, binary);
      chmodSync(binary, 0o755);
    } else if (spec.artifact.format === "bundle") {
      const bundleDir = spec.artifact.bundleDir;
      const binPath = spec.artifact.binPath;
      if (!bundleDir || bundleDir.startsWith("/") || bundleDir.split(/[\\/]/).includes("..") || !binPath || binPath.startsWith("/") || binPath.split(/[\\/]/).includes("..")) {
        throw new Error("pinned release bundle needs safe relative bundleDir and binPath");
      }
      const bundle = join(stage, bundleDir);
      mkdirSync(bundle, { recursive: true });
      const unpacked = await runner("tar", ["-xzf", asset, "-C", bundle]);
      if (unpacked.code !== 0) throw new Error("could not extract pinned release bundle");
      const source = join(bundle, binPath);
      if (!existsSync(source)) throw new Error("pinned release bundle lacks " + binPath);
      chmodSync(source, 0o755);
      symlinkSync(relative(dirname(binary), source), binary);
      bundleParts.push(bundleDir);
    } else {
      const extracted = join(stage, "release");
      mkdirSync(extracted);
      const unpacked = await runner("tar", ["-xzf", asset, "-C", extracted, spec.artifact.member]);
      if (unpacked.code !== 0) throw new Error("could not extract pinned release artifact");
      const source = join(extracted, spec.artifact.member);
      if (!existsSync(source)) throw new Error("pinned release artifact lacks " + spec.artifact.member);
      copyFileSync(source, binary);
      chmodSync(binary, 0o755);
    }
    const manifest = {
      harness, package: spec.package, version: spec.version, bin: spec.bin,
      platform: spec.platform, artifactSha256: spec.artifact.sha256, artifactSource: spec.artifact.source ?? null,
    };
    writeFileSync(join(stage, "agent-run-appliance.json"), JSON.stringify(manifest, null, 2) + "\n");
    const packed = await runner("tar", ["-czf", partial, "-C", stage, "bin", "agent-run-appliance.json", ...bundleParts], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (packed.code !== 0) throw new Error("could not pack pinned release appliance");
    const sha256 = await sha256File(partial);
    const path = join(dir, key + "-" + sha256.slice(0, 12) + ".tgz");
    renameSync(partial, path);
    const entry = {
      path, sha256, harness, package: spec.package, version: spec.version,
      platform: spec.platform, sourceSha256: spec.artifact.sha256,
      builtAt: new Date().toISOString(), builtOn: spec.artifact.source ?? (spec.artifact.githubRelease ? "github-release" : "release-url"),
    };
    await publishIndexEntry(config, key, entry);
    log.write("agent-run: appliance " + key + " sha256=" + sha256 + "\n");
    return { ...entry, key };
  } finally {
    rmSync(partial, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}

// Build one harness appliance and cache it locally: on the laptop when no
// package has install scripts, otherwise on a Crabbox lease. Always builds;
// waits first if another process is building the same appliance.
export async function buildAppliance(options) {
  const { config, pins, harness, log = process.stderr } = options;
  if (!pins.harnesses[harness]) throw new Error("no appliance pin for harness " + harness);
  return await withBuildLock(config, applianceKey(pins, harness), log, () => buildUnlocked(options));
}

async function buildUnlocked({ config, pins, harness, crabbox, log = process.stderr, runner = run, fetcher = fetch }) {
  const spec = pins.harnesses[harness];
  if (spec.artifact) return await buildPinnedArtifactAppliance({ config, pins, harness, log, runner, fetcher });
  const key = applianceKey(pins, harness);
  const node = await nodeTarball(config, pins, log);
  const slug = "agentrun-build-" + harness.replace(/[^a-z0-9]/g, "") + "-" + Date.now().toString(36);
  const dir = join(config.cacheDir, "appliances");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partial = join(dir, key + ".tgz.partial-" + uniqueSuffix());
  const lease = { slug, stopped: false };
  let stage;
  let leaseRequested = false;
  try {
    const staged = await stageInputs({ config, pins, harness, node, runner, log });
    stage = staged.stage;
    if (staged.installScripts.length === 0 || pins.harnesses[harness].ignoreScripts) {
      log.write("agent-run: " + (staged.installScripts.length ? "pin skips install scripts" : "no install scripts") + "; assembling the linux-x64 appliance on the laptop\n");
      await assembleLocally({ stage, pins, harness, lockSha256: staged.lockSha256, partial, runner });
      return await finish(staged, "laptop");
    }
    log.write("agent-run: install scripts in " + staged.installScripts.join(", ") + "; building on a lease\n");
    leaseRequested = true;
    const leased = await crabbox.warmup(slug, log);
    lease.leaseId = leased.leaseId;
    const base = await crabbox.sshArgv(slug);
    const script = buildScript(pins, harness, "/tmp/agentrun-build-" + key, staged);
    const out = createWriteStream(partial, { mode: 0o600 });
    const packer = spawn("tar", ["-cf", "-", "-C", stage, "node.tgz", "app", "tarballs"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
    // A spawn failure must reach the finally block (which stops the lease), not crash the process.
    const packed = new Promise((resolve) => { packer.on("error", () => resolve(-1)); packer.on("close", resolve); });
    let result;
    try {
      result = await runner("ssh", sshCommand(base, { remote: "bash -c " + quote(script) }), {
        input: packer.stdout, stdout: out, stderr: log,
      });
    } finally {
      // A failed or timed-out SSH receiver must not leave tar blocked on its pipe.
      if (!result || result.code !== 0) {
        packer.stdout.destroy();
        packer.kill("SIGKILL");
      }
      await new Promise((resolve) => out.end(resolve));
    }
    const packedCode = await packed;
    if (result.code !== 0) throw new Error("appliance build failed on the lease (exit " + result.code + ")");
    if (packedCode !== 0) throw new Error("could not stream the build inputs");
    return await finish(staged, lease.leaseId);
  } finally {
    rmSync(partial, { force: true });
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (leaseRequested) {
      const stop = await crabbox.stop(slug).catch((error) => ({ stopped: false, error: String(error) }));
      log.write("agent-run: build lease cleanup stopped=" + stop.stopped + " slug=" + slug + "\n");
    }
  }

  async function finish(staged, builtOn) {
    const sha256 = await sha256File(partial);
    const path = join(dir, key + "-" + sha256.slice(0, 12) + ".tgz");
    renameSync(partial, path);
    const entry = { path, sha256, harness, package: pins.harnesses[harness].package, version: pins.harnesses[harness].version, node: pins.node.version, lockSha256: staged.lockSha256, builtAt: new Date().toISOString(), builtOn };
    await publishIndexEntry(config, key, entry);
    log.write("agent-run: appliance " + key + " sha256=" + sha256 + "\n");
    return { ...entry, key };
  }
}

// The cached appliance, built first when it is missing. Concurrent calls for
// one appliance share one build: the others wait for the build lock, then
// find the finished appliance in the cache.
export async function ensureAppliance(options) {
  const { config, pins, harness, log = process.stderr } = options;
  const cached = await cachedAppliance(config, pins, harness);
  if (cached) return cached;
  return await withBuildLock(config, applianceKey(pins, harness), log, async () =>
    await cachedAppliance(config, pins, harness) ?? await buildUnlocked(options));
}
