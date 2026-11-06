import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { ClawRouterAdmin, KEY_PREFIX, newKeyName } from "./clawrouter.mjs";
import { Crabbox, sshCommand } from "./crabbox.mjs";
import { ensureAppliance, loadPins } from "./appliance.mjs";
import { harness as harnessAdapter } from "./harnesses.mjs";
import { childEnv, run } from "./proc.mjs";
import { quote } from "./shell.mjs";

export const EXIT_QUEUED = 75;
export const EXIT_INFRA = 3;
export const EXIT_REVOKE_UNPROVEN = 4;

export async function placement(config, { harness, runId, mode }, runner = run) {
  if (mode === "local" || mode === "remote") return { placement: mode, reason: "forced by --placement " + mode };
  const result = await runner(process.execPath, [
    config.placementHelper, "--task", "agent-run/" + harness + "/" + runId, "--kind", "agent",
    "--memory-mib", "1024", "--processes", "4", "--json",
  ]);
  let decision;
  try { decision = JSON.parse(result.stdout); } catch { decision = undefined; }
  if (!decision?.placement || result.code === 2) throw new Error("capacity placement failed (exit " + result.code + ")");
  return decision;
}

function tee(file, target) {
  const stream = new PassThrough();
  const sink = createWriteStream(file, { mode: 0o600 });
  stream.pipe(sink);
  stream.pipe(target, { end: false });
  return { stream, done: () => new Promise((r) => { stream.end(); sink.on("finish", r); }) };
}

function locksDir(config) {
  const dir = join(config.stateDir, "locks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// Revoke enabled agentrun_* keys whose local run is gone (a killed agent-run).
export async function sweep(config, admin, log = process.stderr) {
  const credentials = await admin.list();
  const dir = locksDir(config);
  const revoked = [];
  for (const credential of credentials) {
    if (!credential.enabled || !credential.credentialId.startsWith(KEY_PREFIX)) continue;
    const lockFile = join(dir, credential.credentialId + ".json");
    let lock;
    try { lock = JSON.parse(readFileSync(lockFile, "utf8")); } catch { lock = undefined; }
    if (lock?.pid && pidAlive(lock.pid)) continue;
    await admin.revoke(credential.credentialId);
    rmSync(lockFile, { force: true });
    revoked.push(credential.credentialId);
    log.write("agent-run: swept stale key " + credential.credentialId + "\n");
  }
  return revoked;
}

function remoteRunScript({ workdir, token, env, argv, promptAsArgument }) {
  const exports = Object.entries(env).map(([k, v]) => "export " + k + "=" + quote(v));
  const promptArg = promptAsArgument ? " -- \"$(cat \"$W/inputs/prompt.md\")\"" : "";
  return [
    "set -eu",
    "W=" + quote(workdir),
    "export HOME=\"$W/home\" PATH=\"$W/appl/node/bin:$W/appl/app/node_modules/.bin:$PATH\"",
    "mkdir -p \"$HOME\" \"$W/out/session\"",
    ...exports,
    "export CLAWROUTER_API_KEY=" + quote(token),
    "cd \"$W/inputs\"",
    "exec " + argv.map(quote).join(" ") + promptArg + " </dev/null",
    "",
  ].join("\n");
}

export async function agentRun(options, deps = {}) {
  const config = deps.config;
  const log = deps.log ?? process.stderr;
  const stdout = deps.stdout ?? process.stdout;
  const runner = deps.runner ?? run;
  const adapter = harnessAdapter(options.harness);
  const runId = newKeyName();
  const out = resolve(options.out ?? join(process.cwd(), "agent-run-" + runId));
  mkdirSync(join(out, "session"), { recursive: true });
  const prompt = readFileSync(options.promptFile, "utf8");
  const receipt = {
    runId, harness: adapter.name, model: options.model ?? null, thinking: options.thinking ?? null,
    startedAt: new Date().toISOString(), out,
  };
  const writeReceipt = () => writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");

  const decision = await (deps.placement ?? placement)(config, { harness: adapter.name, runId, mode: options.placement ?? "auto" }, runner);
  receipt.placement = decision;
  log.write("agent-run: placement=" + decision.placement + (decision.reason ? " (" + decision.reason + ")" : "") + "\n");

  if (decision.placement === "local") {
    const argv = adapter.localArgv({ model: options.model, thinking: options.thinking, prompt, sessionDir: join(out, "session") });
    const output = tee(join(out, "stdout.txt"), stdout);
    const result = await runner(argv[0], argv.slice(1), { stdout: output.stream, stderr: "inherit", env: childEnv() });
    await output.done();
    receipt.target = "local";
    receipt.exitCode = result.code;
    receipt.finishedAt = new Date().toISOString();
    writeReceipt();
    return result.code;
  }

  const admin = deps.admin ?? new ClawRouterAdmin(config, { runner });
  const stage = mkdtempSync(join(tmpdir(), "agent-run-"));
  const crabbox = deps.crabbox ?? new Crabbox(config, { runner, cwd: stage });
  const pins = deps.pins ?? loadPins();
  const lockFile = join(locksDir(config), runId + ".json");
  const workdir = "/tmp/agentrun-" + runId;
  const slug = "agentrun-" + adapter.name + "-" + runId.slice(-6) + randomBytes(2).toString("hex");
  let key;
  let leaseRequested = false;
  let exitCode = EXIT_INFRA;
  let interrupted = false;
  let active;
  const onSignal = (signal) => {
    interrupted = true;
    log.write("agent-run: " + signal + " received; cleaning up\n");
    active?.kill("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const step = (child) => { active = child; };
  receipt.target = { provider: config.crabboxProvider, type: config.crabboxType, slug };

  try {
    receipt.swept = await sweep(config, admin, log).catch((error) => ({ error: String(error.message ?? error) }));
    const appliance = await ensureAppliance({ config, pins, harness: adapter.name, crabbox, log, runner });
    receipt.appliance = { key: appliance.key, sha256: appliance.sha256, package: appliance.package, version: appliance.version };
    if (interrupted) throw new Error("interrupted");

    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: receipt.startedAt }) + "\n", { mode: 0o600 });
    key = await admin.mint(runId);
    receipt.key = { name: runId, minted: true };
    log.write("agent-run: minted per-run key " + runId + "\n");

    leaseRequested = true;
    const lease = await crabbox.warmup(slug, log);
    receipt.target.leaseId = lease.leaseId;
    if (interrupted) throw new Error("interrupted");
    const base = await crabbox.sshArgv(slug);

    // Inputs: prompt, attachments and harness config. No key material.
    mkdirSync(join(stage, "inputs", "attach"), { recursive: true });
    writeFileSync(join(stage, "inputs", "prompt.md"), prompt);
    for (const path of options.attach ?? []) {
      if (!statSync(path).isFile()) throw new Error("--attach accepts files only: " + path);
      copyFileSync(path, join(stage, "inputs", "attach", basename(path)));
    }
    const remoteBaseUrl = "http://127.0.0.1:" + config.remotePort;
    for (const [rel, content] of Object.entries(adapter.remoteConfig({ config, remoteBaseUrl }))) {
      mkdirSync(join(stage, "config", rel, ".."), { recursive: true });
      writeFileSync(join(stage, "config", rel), content, { mode: 0o600 });
    }
    const tarball = join(stage, "inputs.tgz");
    const packed = await runner("tar", ["-czf", tarball, "-C", stage, "inputs", "config"], { env: childEnv(process.env, { COPYFILE_DISABLE: "1" }) });
    if (packed.code !== 0) throw new Error("could not pack inputs");
    const upload = await runner("ssh", sshCommand(base, { remote: "mkdir -p " + quote(workdir) + " && tar -xzf - -C " + quote(workdir) }), { input: createReadStream(tarball), onSpawn: step });
    rmSync(tarball, { force: true });
    if (upload.code !== 0) throw new Error("input upload failed (exit " + upload.code + ")");
    const install = await runner("ssh", sshCommand(base, {
      remote: "set -e; mkdir -p " + quote(workdir + "/appl") + "; cat > " + quote(workdir + "/appl.tgz") +
        "; echo " + quote(appliance.sha256 + "  " + workdir + "/appl.tgz") + " | sha256sum -c - >/dev/null" +
        "; tar -xzf " + quote(workdir + "/appl.tgz") + " -C " + quote(workdir + "/appl") + "; rm " + quote(workdir + "/appl.tgz"),
    }), { input: createReadStream(appliance.path), onSpawn: step });
    if (install.code !== 0) throw new Error("appliance upload or sha256 check failed (exit " + install.code + ")");
    receipt.appliance.verifiedOnBox = true;
    if (interrupted) throw new Error("interrupted");

    const router = new URL(config.routerOrigin);
    const forward = "127.0.0.1:" + config.remotePort + ":" + router.hostname + ":" + (router.port || (router.protocol === "https:" ? 443 : 80));
    const script = remoteRunScript({
      workdir, token: key.token,
      env: adapter.remoteEnv({ configDir: workdir + "/config" }),
      argv: adapter.remoteArgv({ config, model: options.model, thinking: options.thinking, sessionDir: workdir + "/out/session" }),
      promptAsArgument: adapter.promptAsArgument,
    });
    const output = tee(join(out, "stdout.txt"), stdout);
    log.write("agent-run: running " + adapter.name + " on " + lease.leaseId + "\n");
    const result = await runner("ssh", sshCommand(base, {
      options: ["-o", "ExitOnForwardFailure=yes", "-R", forward],
      remote: "bash -s",
    }), { input: script, stdout: output.stream, stderr: log, onSpawn: step });
    await output.done();
    exitCode = result.code;
    receipt.exitCode = result.code;

    const sessionTar = join(stage, "session.tgz");
    const sessionStream = createWriteStream(sessionTar, { mode: 0o600 });
    const download = await runner("ssh", sshCommand(base, { remote: "tar -czf - -C " + quote(workdir + "/out/session") + " ." }), { stdout: sessionStream, onSpawn: step });
    await new Promise((done) => sessionStream.end(done));
    if (download.code === 0) {
      const extracted = await runner("tar", ["-xzf", sessionTar, "-C", join(out, "session")]);
      receipt.sessionDownloaded = extracted.code === 0;
    } else {
      receipt.sessionDownloaded = false;
    }
    if (decision.placement === "queue" && decision.queueFile) {
      rmSync(decision.queueFile, { force: true });
      receipt.queueReceiptRemoved = true;
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    receipt.error = message;
    log.write("agent-run: " + message + "\n");
    exitCode = error?.capacity ? EXIT_QUEUED : EXIT_INFRA;
  } finally {
    if (key) {
      const proof = await admin.revokeAndProve(key.name, key.token);
      receipt.key = { ...receipt.key, revokeProof: proof };
      log.write("agent-run: key " + key.name + " revoked=" + proof.revoked + " listEnabled=" + proof.listEnabled + " inspect=" + proof.inspectStatus + "\n");
      if (!proof.ok) {
        log.write("agent-run: revocation NOT proven for " + key.name + "; run: clawctl device revoke " + key.name + " --host lue-kube\n");
        if (exitCode === 0) exitCode = EXIT_REVOKE_UNPROVEN;
      }
      key.token = undefined;
    }
    if (leaseRequested) {
      const stop = await crabbox.stop(slug).catch((error) => ({ stopped: false, error: String(error) }));
      receipt.target.cleanup = stop;
      log.write("agent-run: lease cleanup stopped=" + stop.stopped + " slug=" + slug + "\n");
    }
    rmSync(lockFile, { force: true });
    rmSync(stage, { recursive: true, force: true });
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    receipt.finishedAt = new Date().toISOString();
    receipt.exitCode = exitCode;
    writeReceipt();
  }
  return exitCode;
}
