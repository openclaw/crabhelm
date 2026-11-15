import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { ClawRouterAdmin, KEY_PREFIX, newKeyName } from "./clawrouter.mjs";
import { Crabbox, sshCommand } from "./crabbox.mjs";
import { ensureAppliance, loadPins } from "./appliance.mjs";
import { harness as harnessAdapter } from "./harnesses.mjs";
import { childEnv, run } from "./proc.mjs";
import { quote } from "./shell.mjs";
import { PI_CONTEXT_VERSION, readPiContext } from "./pi-context.mjs";

export const EXIT_QUEUED = 75;
export const EXIT_INFRA = 3;
export const EXIT_REVOKE_UNPROVEN = 4;

function readPlacementDecision(path) {
  const decision = JSON.parse(readFileSync(path, "utf8"));
  if (!decision || !["local", "remote", "queue"].includes(decision.placement)) {
    throw new Error("invalid --placement-decision: placement must be local, remote or queue");
  }
  return decision;
}

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
    // Another dispatch host may own a key absent from this host's lock directory.
    if (!lock?.pid || (!lock.finishedAt && pidAlive(lock.pid))) continue;
    await admin.revoke(credential.credentialId);
    rmSync(lockFile, { force: true });
    revoked.push(credential.credentialId);
    log.write("agent-run: swept stale key " + credential.credentialId + "\n");
  }
  return revoked;
}

function remoteRunScript({ workdir, token, env, argv, promptAsArgument, promptOnStdin, keyEnv = [], collect = [] }) {
  const exports = Object.entries(env).map(([k, v]) => "export " + k + "=" + quote(v));
  const promptArg = promptAsArgument ? " -- \"$(cat \"$W/inputs/prompt.md\")\"" : "";
  const stdin = promptOnStdin ? " <\"$W/inputs/prompt.md\"" : " </dev/null";
  return [
    "set -eu",
    "W=" + quote(workdir),
    "export HOME=\"$W/home\" PATH=\"$W/appl/bin:$W/appl/node/bin:$W/appl/app/node_modules/.bin:$PATH\"",
    "mkdir -p \"$HOME\" \"$W/out/session\" \"$W/out/out\"",
    "export AGENT_RUN_OUT_DIR=\"$W/out/out\"",
    "ln -s \"$W/out/out\" \"$W/inputs/out\"",
    ...exports,
    "export CLAWROUTER_API_KEY=" + quote(token),
    ...keyEnv.map((name) => "export " + name + "=\"$CLAWROUTER_API_KEY\""),
    "cd \"$W/inputs\"",
    "set +e",
    argv.map(quote).join(" ") + promptArg + stdin,
    "rc=$?",
    ...collect.map((line) => "{ " + line + "; } >&2 || true"),
    "exit $rc",
    "",
  ].join("\n");
}

export async function agentRun(options, deps = {}) {
  const config = deps.config;
  const log = deps.log ?? process.stderr;
  const stdout = deps.stdout ?? process.stdout;
  const execute = deps.runner ?? run;
  const runner = async (command, args, options = {}) => {
    const result = await execute(command, args, { timeoutMs: config.commandTimeoutMs, ...options });
    if (result.timedOut) log.write("agent-run: command timed out after " + config.commandTimeoutMs + "ms: " + command + "\n");
    return result;
  };
  const adapter = harnessAdapter(options.harness);
  const hasPiContext = options.piContextFile !== undefined;
  if (hasPiContext && adapter.name !== "pi") throw new Error("--pi-context-file requires --harness pi");
  const piContext = hasPiContext ? readPiContext(options.piContextFile) : undefined;
  if (piContext && !options.model) throw new Error("--pi-context-file requires --model; no default model is inferred");
  if (piContext && options.thinking && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(options.thinking)) throw new Error("Pi context transport received an unsupported thinking level");
  const runId = newKeyName();
  const out = resolve(options.out ?? join(process.cwd(), "agent-run-" + runId));
  mkdirSync(join(out, "session"), { recursive: true });
  const prompt = readFileSync(options.promptFile, "utf8");
  const receipt = {
    runId, harness: adapter.name, model: options.model ?? null, thinking: options.thinking ?? null,
    startedAt: new Date().toISOString(), out,
  };
  const writeReceipt = () => writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");

  const decision = options.placementDecision
    ? readPlacementDecision(options.placementDecision)
    : await (deps.placement ?? placement)(config, { harness: adapter.name, runId, mode: options.placement ?? "auto" }, runner);
  receipt.placement = decision;
  log.write("agent-run: placement=" + decision.placement + (decision.reason ? " (" + decision.reason + ")" : "") + "\n");

  if (decision.placement === "local") {
    if (piContext) throw new Error("Pi child context requires remote placement; caller must keep the existing local session");
    const argv = adapter.localArgv({ model: options.model, thinking: options.thinking, prompt, sessionDir: join(out, "session"), runId });
    const output = tee(join(out, "stdout.txt"), stdout);
    // Keep the foreground process group so Ctrl-C still reaches local harnesses.
    const result = await runner(argv[0], argv.slice(1), { timeoutMs: undefined, input: adapter.promptOnStdin ? prompt : undefined, stdout: output.stream, stderr: "inherit", env: childEnv(process.env, adapter.localEnv?.({ config, model: options.model, sessionDir: join(out, "session") }) ?? {}) });
    await output.done();
    receipt.target = "local";
    receipt.exitCode = result.code;
    receipt.finishedAt = new Date().toISOString();
    writeReceipt();
    return result.code;
  }

  const pins = deps.pins ?? loadPins();
  if (piContext && (pins.harnesses.pi.version !== PI_CONTEXT_VERSION || pins.harnesses.pi.package !== "@earendil-works/pi-coding-agent")) throw new Error("Pi context transport requires the pinned Pi SDK appliance");
  if (piContext) receipt.piContext = { version: 1, sdkVersion: PI_CONTEXT_VERSION, tools: piContext.tools, historyMessages: piContext.history.length };
  const admin = deps.admin ?? new ClawRouterAdmin(config, { runner });
  const stage = mkdtempSync(join(tmpdir(), "agent-run-"));
  const crabbox = deps.crabbox ?? new Crabbox(config, { runner, cwd: stage });
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
    if (interrupted) throw new Error("interrupted");

    leaseRequested = true;
    const lease = await crabbox.warmup(slug, log, { onSpawn: step });
    receipt.target.leaseId = lease.leaseId;
    receipt.target.requestedMachine = config.crabboxMachine ?? null;
    log.write("agent-run: run details provider=" + config.crabboxProvider + " lease=" + lease.leaseId + " slug=" + slug + "\n");
    if (interrupted) throw new Error("interrupted");
    const base = await crabbox.sshArgv(slug);

    // Inputs: prompt, attachments and harness config. No key material.
    mkdirSync(join(stage, "inputs", "attach"), { recursive: true });
    writeFileSync(join(stage, "inputs", "prompt.md"), prompt);
    for (const path of options.attach ?? []) {
      if (!statSync(path).isFile()) throw new Error("--attach accepts files only: " + path);
      copyFileSync(path, join(stage, "inputs", "attach", basename(path)));
    }
    for (const [rel, content] of Object.entries(adapter.workspaceFiles ?? {})) {
      const path = join(stage, "inputs", rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
    }
    const remoteBaseUrl = "http://127.0.0.1:" + config.remotePort;
    for (const [rel, content] of Object.entries(adapter.remoteConfig({ config, remoteBaseUrl, model: options.model, workdir, piContext }))) {
      mkdirSync(join(stage, "config", rel, ".."), { recursive: true });
      writeFileSync(join(stage, "config", rel), content, { mode: 0o600 });
    }
    const tarball = join(stage, "inputs.tgz");
    const packed = await runner("tar", ["-czf", tarball, "-C", stage, "inputs", "config"], { env: childEnv(process.env, { COPYFILE_DISABLE: "1" }) });
    if (packed.code !== 0) throw new Error("could not pack inputs");
    const upload = await runner("ssh", sshCommand(base, { remote: "mkdir -p " + quote(workdir) + " && tar -xzf - -C " + quote(workdir) }), { input: createReadStream(tarball), onSpawn: step });
    rmSync(tarball, { force: true });
    if (upload.code !== 0) throw new Error("input upload failed (exit " + upload.code + ")");
    const applianceBytes = statSync(appliance.path).size;
    const uploadStarted = Date.now();
    log.write("agent-run: appliance upload starting bytes=" + applianceBytes + (config.serveProxyCommand ? " transport=custom-serve-proxy" : " transport=crabbox") + "\n");
    const applianceInput = createReadStream(appliance.path);
    const progress = setInterval(() => log.write("agent-run: appliance upload bytes=" + applianceInput.bytesRead + "/" + applianceBytes + "\n"), 30_000);
    progress.unref();
    applianceInput.on("close", () => clearInterval(progress));
    applianceInput.on("error", () => clearInterval(progress));
    let install;
    try {
      install = await runner("ssh", sshCommand(base, {
      remote: "set -e; mkdir -p " + quote(workdir + "/appl") + "; cat > " + quote(workdir + "/appl.tgz") +
        "; echo " + quote(appliance.sha256 + "  " + workdir + "/appl.tgz") + " | sha256sum -c - >/dev/null" +
        "; tar -xzf " + quote(workdir + "/appl.tgz") + " -C " + quote(workdir + "/appl") + "; rm " + quote(workdir + "/appl.tgz") +
        // Laptop-assembled appliances keep Node packed; it was sha256-checked when the appliance was built.
        "; if [ -f " + quote(workdir + "/appl/node.tgz") + " ]; then mkdir -p " + quote(workdir + "/appl/node") + "; tar -xzf " + quote(workdir + "/appl/node.tgz") + " -C " + quote(workdir + "/appl/node") + " --strip-components=1; rm " + quote(workdir + "/appl/node.tgz") + "; fi",
      }), { input: applianceInput, onSpawn: step });
    } finally {
      clearInterval(progress);
      applianceInput.destroy();
    }
    if (install.code !== 0) throw new Error("appliance upload or sha256 check failed (exit " + install.code + ")");
    receipt.appliance.verifiedOnBox = true;
    receipt.appliance.upload = { bytes: applianceBytes, elapsedMs: Date.now() - uploadStarted, transport: config.serveProxyCommand ? "custom-serve-proxy" : "crabbox" };
    log.write("agent-run: appliance upload verified sha256=" + appliance.sha256 + " elapsed_ms=" + receipt.appliance.upload.elapsedMs + "\n");
    if (interrupted) throw new Error("interrupted");

    const router = new URL(config.routerOrigin);
    const forward = "127.0.0.1:" + config.remotePort + ":" + router.hostname + ":" + (router.port || (router.protocol === "https:" ? 443 : 80));
    const script = remoteRunScript({
      workdir, token: key.token,
      env: adapter.remoteEnv({ configDir: workdir + "/config", remoteBaseUrl }),
      argv: adapter.remoteArgv({ config, model: options.model, thinking: options.thinking, sessionDir: workdir + "/out/session", runId, promptFile: workdir + "/inputs/prompt.md", remoteBaseUrl, workdir, piContext }),
      promptAsArgument: adapter.promptAsArgument && !piContext,
      promptOnStdin: adapter.promptOnStdin,
      keyEnv: typeof adapter.keyEnv === "function" ? adapter.keyEnv({ model: options.model }) : adapter.keyEnv,
      collect: adapter.remoteCollect?.({ configDir: workdir + "/config", sessionDir: workdir + "/out/session" }) ?? [],
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

    if (interrupted) {
      receipt.resultsDownloaded = receipt.sessionDownloaded = false;
    } else {
      const sessionTar = join(stage, "session.tgz");
      const sessionStream = createWriteStream(sessionTar, { mode: 0o600 });
      const download = await runner("ssh", sshCommand(base, { remote: "tar -czf - -C " + quote(workdir + "/out") + " ." }), { stdout: sessionStream, onSpawn: step });
      await new Promise((done) => sessionStream.end(done));
      if (download.code === 0) {
        const extracted = await runner("tar", ["-xzf", sessionTar, "-C", out]);
        receipt.resultsDownloaded = receipt.sessionDownloaded = extracted.code === 0;
      } else {
        receipt.resultsDownloaded = receipt.sessionDownloaded = false;
      }
      if (!receipt.resultsDownloaded) {
        log.write("agent-run: result download failed; remote output was not recovered\n");
        if (exitCode === 0) exitCode = EXIT_INFRA;
      }
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
      if (!stop.stopped) {
        log.write("agent-run: lease NOT stopped; run: crabbox stop --provider " + config.crabboxProvider + " --id " + slug + "\n");
        if (exitCode === 0) exitCode = EXIT_INFRA;
      }
    }
    if (receipt.key?.revokeProof?.ok) {
      rmSync(lockFile, { force: true });
    } else if (existsSync(lockFile)) {
      // Retain ownership after an uncertain mint or revoke so a later sweep can retry.
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: receipt.startedAt, finishedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
    }
    rmSync(stage, { recursive: true, force: true });
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    receipt.finishedAt = new Date().toISOString();
    receipt.exitCode = exitCode;
    writeReceipt();
  }
  return exitCode;
}
