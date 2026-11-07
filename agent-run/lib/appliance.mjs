import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./proc.mjs";
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

export function applianceKey(pins, harness) {
  const spec = pins.harnesses[harness];
  if (!spec) throw new Error("no appliance pin for harness " + harness);
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
  writeFileSync(path + ".tmp", bytes);
  renameSync(path + ".tmp", path);
  return path;
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
  if (!existsSync(join(stage, "app", "node_modules", ".bin", spec.bin))) throw new Error("npm ci did not install " + spec.bin);
  writeFileSync(join(stage, "agent-run-appliance.json"), JSON.stringify({ harness, package: spec.package, version: spec.version, bin: spec.bin, node: pins.node.version, lockSha256, assembled: "laptop" }) + "\n");
  rmSync(cache, { recursive: true, force: true });
  const packed = await runner("tar", ["-czf", partial, "-C", stage, "node.tgz", "app", "agent-run-appliance.json"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (packed.code !== 0) throw new Error("could not pack the appliance");
}

// Build one harness appliance and cache it locally: on the laptop when no
// package has install scripts, otherwise on a Crabbox lease.
export async function buildAppliance({ config, pins, harness, crabbox, log = process.stderr, runner = run }) {
  const key = applianceKey(pins, harness);
  const node = await nodeTarball(config, pins, log);
  const slug = "agentrun-build-" + harness.replace(/[^a-z0-9]/g, "") + "-" + Date.now().toString(36);
  const dir = join(config.cacheDir, "appliances");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partial = join(dir, key + ".tgz.partial");
  const lease = { slug, stopped: false };
  let stage;
  let leaseRequested = false;
  try {
    const staged = await stageInputs({ config, pins, harness, node, runner, log });
    stage = staged.stage;
    if (staged.installScripts.length === 0) {
      log.write("agent-run: no install scripts; assembling the linux-x64 appliance on the laptop\n");
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
    const result = await runner("ssh", sshCommand(base, { remote: "bash -c " + quote(script) }), {
      input: packer.stdout, stdout: out, stderr: log,
    });
    await new Promise((resolve) => out.end(resolve));
    if (await packed !== 0) throw new Error("could not stream the build inputs");
    if (result.code !== 0) throw new Error("appliance build failed on the lease (exit " + result.code + ")");
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
    const index = readIndex(config);
    index[key] = { path, sha256, harness, package: pins.harnesses[harness].package, version: pins.harnesses[harness].version, node: pins.node.version, lockSha256: staged.lockSha256, builtAt: new Date().toISOString(), builtOn };
    writeFileSync(indexPath(config), JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
    log.write("agent-run: appliance " + key + " sha256=" + sha256 + "\n");
    return { ...index[key], key };
  }
}

export async function ensureAppliance(options) {
  return await cachedAppliance(options.config, options.pins, options.harness) ?? buildAppliance(options);
}
