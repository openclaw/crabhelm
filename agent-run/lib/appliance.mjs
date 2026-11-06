import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

export function buildScript(pins, harness, workdir) {
  const spec = pins.harnesses[harness];
  const manifest = JSON.stringify({ harness, package: spec.package, version: spec.version, bin: spec.bin, node: pins.node.version });
  return [
    "set -eu",
    "W=" + quote(workdir),
    "rm -rf \"$W\"; mkdir -p \"$W/a/node\" \"$W/a/app\" \"$W/home\"; cd \"$W\"",
    "cat > node.tgz",
    "echo " + quote(pins.node.sha256 + "  node.tgz") + " | sha256sum -c - >&2",
    "tar -xzf node.tgz -C a/node --strip-components=1; rm node.tgz",
    "export HOME=\"$W/home\" PATH=\"$W/a/node/bin:$PATH\" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false",
    "cd a/app",
    "printf '%s\\n' '{\"name\":\"agent-run-appliance\",\"private\":true}' > package.json",
    "npm install --omit=dev --save-exact " + quote(spec.package + "@" + spec.version) + " >&2",
    "test -x node_modules/.bin/" + quote(spec.bin),
    "cd \"$W/a\"",
    "printf '%s\\n' " + quote(manifest) + " > agent-run-appliance.json",
    "echo 'agent-run: appliance contents ready' >&2",
    "tar -czf - .",
    "cd /; rm -rf \"$W\"",
  ].join("\n");
}

// Build one harness appliance on a Crabbox lease and cache it locally.
export async function buildAppliance({ config, pins, harness, crabbox, log = process.stderr, runner = run }) {
  const key = applianceKey(pins, harness);
  const node = await nodeTarball(config, pins, log);
  const slug = "agentrun-build-" + harness.replace(/[^a-z0-9]/g, "") + "-" + Date.now().toString(36);
  const dir = join(config.cacheDir, "appliances");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partial = join(dir, key + ".tgz.partial");
  const lease = { slug, stopped: false };
  try {
    const leased = await crabbox.warmup(slug, log);
    lease.leaseId = leased.leaseId;
    const base = await crabbox.sshArgv(slug);
    const script = buildScript(pins, harness, "/tmp/agentrun-build-" + key);
    const out = createWriteStream(partial, { mode: 0o600 });
    const result = await runner("ssh", sshCommand(base, { remote: "bash -c " + quote(script) }), {
      input: createReadStream(node), stdout: out, stderr: log,
    });
    await new Promise((resolve) => out.end(resolve));
    if (result.code !== 0) throw new Error("appliance build failed on the lease (exit " + result.code + ")");
    const sha256 = await sha256File(partial);
    const path = join(dir, key + "-" + sha256.slice(0, 12) + ".tgz");
    renameSync(partial, path);
    const index = readIndex(config);
    index[key] = { path, sha256, harness, package: pins.harnesses[harness].package, version: pins.harnesses[harness].version, node: pins.node.version, builtAt: new Date().toISOString(), buildLease: lease.leaseId };
    writeFileSync(indexPath(config), JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
    log.write("agent-run: appliance " + key + " sha256=" + sha256 + "\n");
    return { ...index[key], key };
  } finally {
    rmSync(partial, { force: true });
    const stop = await crabbox.stop(slug).catch((error) => ({ stopped: false, error: String(error) }));
    log.write("agent-run: build lease cleanup stopped=" + stop.stopped + " slug=" + slug + "\n");
  }
}

export async function ensureAppliance(options) {
  return await cachedAppliance(options.config, options.pins, options.harness) ?? buildAppliance(options);
}
