import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { boxPackages, integrityMatches } from "../lib/appliance.mjs";
import { ClawRouterAdmin, IN_POD_SCRIPT, newKeyName } from "../lib/clawrouter.mjs";
import { Crabbox, sshCommand } from "../lib/crabbox.mjs";
import { childEnv } from "../lib/proc.mjs";
import { HARNESSES } from "../lib/harnesses.mjs";
import { agentRun, EXIT_INFRA, EXIT_QUEUED } from "../lib/run.mjs";
import { quote, splitWords } from "../lib/shell.mjs";

const sink = () => new Writable({ write(_chunk, _enc, cb) { cb(); } });

test("splitWords reads the quoting crabbox ssh prints", () => {
  const line = "'ssh' '-i' '/Users/x/Application Support/id' '-o' 'ProxyCommand='\\''crabbox'\\'' '\\''--lease'\\''' 'crabbox@cbx_1'";
  assert.deepEqual(splitWords(line), [
    "ssh", "-i", "/Users/x/Application Support/id", "-o", "ProxyCommand='crabbox' '--lease'", "crabbox@cbx_1",
  ]);
  for (const value of ["plain", "it's", "a b", "$HOME", "", "x'\"y"]) assert.deepEqual(splitWords(quote(value)), [value]);
});

test("the appliance takes only the lockfile packages a linux-x64 glibc box needs", () => {
  const entry = (extra) => ({ resolved: "https://r/x.tgz", integrity: "sha512-x", ...extra });
  const lock = { packages: {
    "": { name: "root" },
    "node_modules/a": entry(),
    "node_modules/a-darwin-arm64": entry({ os: ["darwin"], cpu: ["arm64"], optional: true }),
    "node_modules/a-linux-x64": entry({ os: ["linux"], cpu: ["x64"], optional: true }),
    "node_modules/a-linux-x64-musl": entry({ os: ["linux"], cpu: ["x64"], libc: ["musl"], optional: true }),
    "node_modules/not-windows": entry({ os: ["!win32"] }),
    "node_modules/devtool": entry({ dev: true }),
    "node_modules/linked": { link: true, resolved: "../x" },
  } };
  assert.deepEqual(boxPackages(lock).map((p) => p.path), ["node_modules/a", "node_modules/a-linux-x64", "node_modules/not-windows"]);
  assert.throws(() => boxPackages({ packages: { "node_modules/b": {} } }), /no resolved URL or integrity/);
});

test("tarball integrity is checked against the lockfile hash", () => {
  const bytes = Buffer.from("tarball");
  const good = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  assert.ok(integrityMatches(good, bytes));
  assert.ok(integrityMatches("sha1-ignored " + good, bytes));
  assert.ok(!integrityMatches(good, Buffer.from("other")));
  assert.ok(!integrityMatches("sha1-" + createHash("sha1").update(bytes).digest("base64"), bytes));
});

test("stopping a lease the coordinator never created counts as stopped", async () => {
  const runner = async () => ({ code: 0, stdout: "", stderr: "coordinator POST /v1/leases/s/release: http 404: {\"error\":\"not_found\"}\n" });
  assert.deepEqual(await new Crabbox({ crabboxProvider: "serve" }, { runner }).stop("s"), { stopped: true, absent: true, exitCode: 0, lease: null });
  const failing = async () => ({ code: 1, stdout: "", stderr: "coordinator POST /v1/leases/s/release: http 500\n" });
  assert.equal((await new Crabbox({ crabboxProvider: "serve" }, { runner: failing }).stop("s")).stopped, false);
});

test("sshCommand puts options before the destination", () => {
  assert.deepEqual(
    sshCommand(["ssh", "-p", "22", "user@box"], { options: ["-R", "1:h:2"], remote: "bash -s" }),
    ["-p", "22", "-R", "1:h:2", "user@box", "bash -s"],
  );
});

test("child environments never carry the admin token or a per-run key", () => {
  const env = childEnv({ PATH: "/bin", CLAWROUTER_ADMIN_TOKEN: "a", CLAWROUTER_API_KEY: "b" });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("key names fit ClawRouter's [A-Za-z0-9_] rule", () => {
  assert.match(newKeyName(new Date("2026-11-06T22:11:33Z"), "abc123"), /^agentrun_20261106221133_abc123$/);
});

test("the in-pod script sends the default device policy with no budget", () => {
  assert.match(IN_POD_SCRIPT, /providers: \["openai", "anthropic"\]/);
  assert.match(IN_POD_SCRIPT, /process\.env\.CLAWROUTER_ADMIN_TOKEN/);
  assert.doesNotMatch(IN_POD_SCRIPT, /monthlyBudgetMicros|monthlyRequestLimit/);
});

function fakePod() {
  const calls = [];
  const state = new Map();
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    const tail = args.slice(args.indexOf(IN_POD_SCRIPT) + 1);
    const [op, name] = tail;
    if (op === "put") state.set(name, true);
    if (op === "revoke") state.set(name, false);
    const credentials = [...state].filter(([id]) => op === "list" || id === name)
      .map(([credentialId, enabled]) => ({ credentialId, policyId: credentialId, enabled, active: enabled }));
    return { code: 0, stdout: JSON.stringify({ ok: true, op, credentials }) + "\n", stderr: "" };
  };
  return { calls, state, runner };
}

test("mint sends only the sha256 of the secret to the pod", async () => {
  const pod = fakePod();
  const admin = new ClawRouterAdmin({ kubeContext: "k", routerNamespace: "n", routerDeployment: "d", routerContainer: "c" }, { runner: pod.runner });
  const { token } = await admin.mint("agentrun_test_000001");
  const secret = token.slice("clawrouter-live-agentrun_test_000001-".length);
  const argv = pod.calls[0].join(" ");
  assert.ok(!argv.includes(secret));
  assert.ok(argv.includes(createHash("sha256").update(secret).digest("hex")));
});

test("a mint whose reply fails still revokes the key", async () => {
  const pod = fakePod();
  const runner = async (command, args) => {
    const result = await pod.runner(command, args);
    const op = args[args.indexOf(IN_POD_SCRIPT) + 1];
    return op === "put" ? { code: 1, stdout: "", stderr: "" } : result;
  };
  const admin = new ClawRouterAdmin({}, { runner });
  await assert.rejects(admin.mint("agentrun_test_000003"), /put failed/);
  assert.equal(pod.state.get("agentrun_test_000003"), false);
});

test("revocation is proven only when the list says disabled and the router refuses the key", async () => {
  for (const [status, ok] of [[403, true], [401, true], [200, false]]) {
    const pod = fakePod();
    const admin = new ClawRouterAdmin({ routerOrigin: "http://router" }, { runner: pod.runner, fetcher: async () => new Response("{}", { status }) });
    await admin.mint("agentrun_test_000002");
    const proof = await admin.revokeAndProve("agentrun_test_000002", "tok");
    assert.equal(proof.ok, ok);
    assert.equal(proof.listEnabled, false);
  }
});

test("the Pi box config drops the laptop key and reads the per-run key from the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-run-test-"));
  const modelsFile = join(dir, "models.json");
  writeFileSync(modelsFile, JSON.stringify({ providers: { clawrouter: { baseUrl: "http://127.0.0.1:8798", apiKey: "laptop-secret", api: "anthropic-messages", models: [{ id: "m" }, { id: "o", api: "openai-responses", baseUrl: "http://127.0.0.1:8798/v1" }] } } }));
  const files = HARNESSES.pi.remoteConfig({ config: { piModelsFile: modelsFile, piProvider: "clawrouter" }, remoteBaseUrl: "http://127.0.0.1:18789" });
  const provider = JSON.parse(files["pi/models.json"]).providers.clawrouter;
  assert.equal(provider.apiKey, "$CLAWROUTER_API_KEY");
  assert.equal(provider.baseUrl, "http://127.0.0.1:18789");
  assert.equal(provider.models[1].baseUrl, "http://127.0.0.1:18789/v1");
  assert.equal(provider.models[0].baseUrl, undefined);
  assert.ok(!files["pi/models.json"].includes("laptop-secret"));
});

function remoteFixture({ runExit = 0, failUpload = false, warmupError, stopResult = { stopped: true, exitCode: 0, lease: "cbx_1" }, afterMint } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-run-flow-"));
  const cacheDir = join(dir, "cache");
  mkdirSync(join(cacheDir, "appliances"), { recursive: true });
  const appliancePath = join(cacheDir, "appliances", "pi.tgz");
  writeFileSync(appliancePath, "appliance");
  const sha256 = createHash("sha256").update("appliance").digest("hex");
  writeFileSync(join(cacheDir, "appliances", "index.json"), JSON.stringify({
    "pi-1.0.0-node24": { path: appliancePath, sha256, package: "p", version: "1.0.0" },
  }));
  const modelsFile = join(dir, "models.json");
  writeFileSync(modelsFile, JSON.stringify({ providers: { clawrouter: { baseUrl: "http://127.0.0.1:8798", apiKey: "laptop", models: [] } } }));
  writeFileSync(join(dir, "prompt.md"), "say hi");
  const config = {
    cacheDir, stateDir: join(dir, "state"), piModelsFile: modelsFile, piProvider: "clawrouter",
    routerOrigin: "http://router.example:8789", remotePort: 18789, crabboxProvider: "serve", crabboxType: "cpu2",
  };
  const events = [];
  const pod = fakePod();
  const admin = new ClawRouterAdmin(config, { runner: pod.runner, fetcher: async () => new Response("{}", { status: 403 }) });
  const wrappedAdmin = {
    list: () => admin.list(),
    revoke: (n) => admin.revoke(n),
    mint: async (n) => { const key = await admin.mint(n); events.push("mint"); fixture.token = key.token; afterMint?.(); return key; },
    revokeAndProve: async (n, t) => { events.push("revoke"); return admin.revokeAndProve(n, t); },
  };
  const crabbox = {
    warmup: async () => { events.push("warmup"); if (warmupError) throw warmupError; return { leaseId: "cbx_1", slug: "s" }; },
    sshArgv: async () => ["ssh", "-p", "22", "u@cbx_1"],
    stop: async () => { events.push("stop"); return stopResult; },
  };
  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, input: typeof options.input === "string" ? options.input : undefined });
    if (command === "tar" && args[0] === "-czf") writeFileSync(args[1], "");
    if (options.input && typeof options.input.resume === "function") {
      await new Promise((done) => { options.input.on("end", done); options.input.on("error", done); options.input.resume(); });
    }
    const remote = args.at(-1) ?? "";
    if (command === "ssh" && remote.startsWith("mkdir") && failUpload) return { code: 255, stdout: "", stderr: "" };
    if (command === "ssh" && remote === "bash -s") return { code: runExit, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const fixture = {
    dir, events, calls, pod,
    deps: {
      config, admin: wrappedAdmin, crabbox, runner, log: sink(), stdout: sink(),
      pins: { node: { version: "24" }, harnesses: { pi: { package: "p", version: "1.0.0", bin: "pi" } } },
      placement: async () => ({ placement: "queue" }),
    },
    options: { harness: "pi", promptFile: join(dir, "prompt.md"), out: join(dir, "out"), model: "m" },
  };
  return fixture;
}

test("a remote run revokes the key and stops the lease after the harness exits", async () => {
  const f = remoteFixture({ runExit: 7 });
  const code = await agentRun(f.options, f.deps);
  assert.equal(code, 7);
  assert.deepEqual(f.events, ["mint", "warmup", "revoke", "stop"]);
  const receipt = JSON.parse(readFileSync(join(f.options.out, "receipt.json"), "utf8"));
  assert.equal(receipt.key.revokeProof.ok, true);
  assert.equal(receipt.target.cleanup.stopped, true);
  assert.ok(!JSON.stringify(receipt).includes(f.token));
  const runCall = f.calls.find((c) => c.args.at(-1) === "bash -s");
  assert.ok(runCall.args.includes("-R") && runCall.args.includes("127.0.0.1:18789:router.example:8789"));
  for (const call of f.calls) assert.ok(!call.args.join(" ").includes(f.token), "key on argv of " + call.command);
  assert.ok(runCall.input.includes(f.token), "key travels on stdin");
});

test("cleanup still runs when the upload fails", async () => {
  const f = remoteFixture({ failUpload: true });
  assert.equal(await agentRun(f.options, f.deps), EXIT_INFRA);
  assert.deepEqual(f.events, ["mint", "warmup", "revoke", "stop"]);
});

test("no broker capacity exits 75 and still revokes the key", async () => {
  const error = Object.assign(new Error("no capacity"), { capacity: true });
  const f = remoteFixture({ warmupError: error });
  assert.equal(await agentRun(f.options, f.deps), EXIT_QUEUED);
  assert.deepEqual(f.events, ["mint", "warmup", "revoke", "stop"]);
});

test("a lease that does not stop turns a successful run into an infrastructure failure", async () => {
  const f = remoteFixture({ stopResult: { stopped: false, exitCode: 1, lease: null } });
  assert.equal(await agentRun(f.options, f.deps), EXIT_INFRA);
  assert.equal(JSON.parse(readFileSync(join(f.options.out, "receipt.json"), "utf8")).target.cleanup.stopped, false);
});

test("a signal before the lease is requested revokes the key and takes no lease", async () => {
  const f = remoteFixture({ afterMint: () => process.emit("SIGTERM", "SIGTERM") });
  assert.equal(await agentRun(f.options, f.deps), EXIT_INFRA);
  assert.deepEqual(f.events, ["mint", "revoke"]);
});

test("the remote script keeps the harness exit code after collecting session files", async () => {
  const f = remoteFixture({ runExit: 5 });
  f.deps.pins.harnesses.codex = { package: "c", version: "1.0.0", bin: "codex" };
  const index = join(f.deps.config.cacheDir, "appliances", "index.json");
  const entries = JSON.parse(readFileSync(index, "utf8"));
  writeFileSync(index, JSON.stringify({ ...entries, "codex-1.0.0-node24": entries["pi-1.0.0-node24"] }));
  assert.equal(await agentRun({ ...f.options, harness: "codex", thinking: "high" }, f.deps), 5);
  const script = f.calls.find((c) => c.args.at(-1) === "bash -s").input;
  assert.match(script, /^codex exec .*-c 'model_reasoning_effort="high"' --dangerously-bypass-approvals-and-sandbox -- /m);
  assert.match(script, /rc=\$\?\n\{ if \[ -d "\$CODEX_HOME\/sessions" \].*\nexit \$rc/);
  assert.ok(!script.includes("exec codex"));
});

test("the Codex box config routes through the tunnel and names only the key variable", () => {
  const files = HARNESSES.codex.remoteConfig({ config: {}, remoteBaseUrl: "http://127.0.0.1:18789" });
  const toml = files["codex/config.toml"];
  assert.match(toml, /^model_provider = "clawrouter"$/m);
  assert.match(toml, /^base_url = "http:\/\/127\.0\.0\.1:18789\/v1"$/m);
  assert.match(toml, /^env_key = "CLAWROUTER_API_KEY"$/m);
  assert.deepEqual(HARNESSES.codex.remoteEnv({ configDir: "/w/config" }), { CODEX_HOME: "/w/config/codex" });
  assert.deepEqual(HARNESSES.codex.localArgv({ model: "clawrouter/gpt-x", prompt: "hi", sessionDir: "/s" }).slice(-3), ["gpt-x", "--", "hi"]);
});

test("local placement runs the harness on the laptop with no key and no lease", async () => {
  const f = remoteFixture();
  f.deps.placement = async () => ({ placement: "local" });
  assert.equal(await agentRun(f.options, f.deps), 0);
  assert.deepEqual(f.events, []);
  assert.equal(f.calls[0].command, "pi");
  assert.deepEqual(f.calls[0].args.slice(0, 1), ["-p"]);
});
