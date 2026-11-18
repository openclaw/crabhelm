import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { test } from "node:test";
import { applianceKey, boxPackages, buildAppliance, integrityMatches } from "../lib/appliance.mjs";
import { ClawRouterAdmin, IN_POD_SCRIPT, newKeyName } from "../lib/clawrouter.mjs";
import { Crabbox, sshCommand } from "../lib/crabbox.mjs";
import { childEnv } from "../lib/proc.mjs";
import { HARNESSES } from "../lib/harnesses.mjs";
import { agentRun, applianceInstallCommand, applianceRestoreCommand, remoteApplianceCache, sweep, EXIT_INFRA, EXIT_QUEUED } from "../lib/run.mjs";
import { loadConfig } from "../lib/config.mjs";
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

test("a pinned Linux release artifact assembles a digest-addressed appliance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-run-rusty-appliance-"));
  const source = join(dir, "source");
  mkdirSync(source);
  writeFileSync(join(source, "rustyd"), "fake rustyd binary\n", { mode: 0o755 });
  const archive = join(dir, "rustyd.tgz");
  execFileSync("tar", ["-czf", archive, "-C", source, "rustyd"]);
  const bytes = readFileSync(archive);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const url = "https://releases.example/rustyd.tgz";
  const release = { repo: "example/rusty", tag: "v0.1.5", asset: "rustyd.tgz" };
  const pins = { harnesses: { rusty: { package: "rustyd", version: "0.1.5", bin: "rustyd", platform: "linux-x64", artifact: { url, githubRelease: release, sha256: digest, member: "rustyd" } } } };
  const appliance = await buildAppliance({
    config: { cacheDir: join(dir, "cache") }, pins, harness: "rusty", log: sink(),
    fetcher: async () => { throw new Error("private release must use gh auth"); },
    runner: async (command, args, options = {}) => {
      if (command === "gh") {
        assert.deepEqual(args.slice(0, -2), ["release", "download", release.tag, "--repo", release.repo, "--pattern", release.asset]);
        assert.equal(options.env.GH_PROMPT_DISABLED, "1");
        assert.equal(options.env.CLAWROUTER_API_KEY, undefined);
        writeFileSync(join(args.at(-1), release.asset), bytes);
        return { code: 0, stdout: "", stderr: "" };
      }
      execFileSync(command, args, { env: options.env });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(appliance.key, applianceKey(pins, "rusty"));
  assert.equal(appliance.sourceSha256, digest);
  assert.equal(appliance.builtOn, "github-release");
  const unpacked = join(dir, "unpacked");
  mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", appliance.path, "-C", unpacked]);
  const binary = join(unpacked, "bin", "rustyd");
  assert.equal(readFileSync(binary, "utf8"), "fake rustyd binary\n");
  assert.ok(statSync(binary).mode & 0o111);
  const manifest = JSON.parse(readFileSync(join(unpacked, "agent-run-appliance.json"), "utf8"));
  assert.equal(manifest.artifactSha256, digest);
});

test("a pinned Linux binary release assembles a digest-addressed appliance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-run-grok-appliance-"));
  const bytes = Buffer.from("fake grok ELF binary\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const pins = { harnesses: { grok: {
    package: "grok", version: "1.0.78", bin: "grok", platform: "linux-x64",
    artifact: { url: "https://releases.example/grok", format: "binary", source: "test-binary-release", sha256: digest },
  } } };
  const appliance = await buildAppliance({
    config: { cacheDir: join(dir, "cache") }, pins, harness: "grok", log: sink(),
    fetcher: async (url) => { assert.equal(url, pins.harnesses.grok.artifact.url); return new Response(bytes); },
    runner: async (command, args, options = {}) => {
      execFileSync(command, args, { env: options.env });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(appliance.key, applianceKey(pins, "grok"));
  assert.equal(appliance.sourceSha256, digest);
  assert.equal(appliance.builtOn, "test-binary-release");
  const unpacked = join(dir, "unpacked");
  mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", appliance.path, "-C", unpacked]);
  const binary = join(unpacked, "bin", "grok");
  assert.equal(readFileSync(binary, "utf8"), "fake grok ELF binary\n");
  assert.ok(statSync(binary).mode & 0o111);
});

test("a pinned Linux release bundle preserves the executable runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-run-prime-appliance-"));
  const source = join(dir, "release");
  mkdirSync(join(source, "prime-agent-runtime"), { recursive: true });
  writeFileSync(join(source, "prime-agent"), "fake prime ELF binary\n", { mode: 0o755 });
  writeFileSync(join(source, "prime-agent-runtime", "pyproject.toml"), "[project]\nname='rlm'\n");
  const archive = join(dir, "prime.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", source, "."]);
  const bytes = readFileSync(archive);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const release = { repo: "PrimeIntellect-ai/prime-agent", tag: "v0.10.0", asset: "prime-agent-0.10.0-linux-x64.tar.gz" };
  const pins = { harnesses: { prime: {
    package: "prime-agent", version: "0.10.0", bin: "prime-agent", platform: "linux-x64",
    artifact: { format: "bundle", githubRelease: release, sha256: digest, bundleDir: "prime-agent", binPath: "prime-agent" },
  } } };
  const appliance = await buildAppliance({
    config: { cacheDir: join(dir, "cache") }, pins, harness: "prime", log: sink(),
    runner: async (command, args, options = {}) => {
      if (command === "gh") {
        assert.ok(args.includes(release.asset));
        assert.equal(options.env.GH_PROMPT_DISABLED, "1");
        writeFileSync(join(args.at(-1), release.asset), bytes);
        return { code: 0, stdout: "", stderr: "" };
      }
      execFileSync(command, args, { env: options.env });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(appliance.key, applianceKey(pins, "prime"));
  assert.equal(appliance.sourceSha256, digest);
  assert.equal(appliance.builtOn, "github-release");
  const unpacked = join(dir, "unpacked");
  mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", appliance.path, "-C", unpacked]);
  assert.equal(readFileSync(join(unpacked, "bin", "prime-agent"), "utf8"), "fake prime ELF binary\n");
  assert.equal(readFileSync(join(unpacked, "prime-agent", "prime-agent-runtime", "pyproject.toml"), "utf8"), "[project]\nname='rlm'\n");
  assert.ok(statSync(join(unpacked, "bin", "prime-agent")).mode & 0o111);
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

test("the in-pod script allows xai without adding a budget", () => {
  assert.match(IN_POD_SCRIPT, /providers: \["openai", "anthropic", "xai"\]/);
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

// Runs the real in-pod script with fetch stubbed; returns the PUT body text.
function podPutBody(extraArgs) {
  const stub = "globalThis.fetch = async (url, init) => { if (init.method === 'PUT') process.stderr.write('BODY:' + init.body + '\\n'); "
    + "return new Response(JSON.stringify({ credentials: [] }), { status: 200 }); };";
  const result = spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(stub), "--input-type=module", "-e", IN_POD_SCRIPT,
    "put", "agentrun_test_000009", "a".repeat(64), ...extraArgs], { env: { ...process.env, CLAWROUTER_ADMIN_TOKEN: "t" }, encoding: "utf8" });
  const line = result.stderr.split("\n").find((l) => l.startsWith("BODY:"));
  return { body: line?.slice(5), stdout: result.stdout, status: result.status };
}

test("without AGENT_RUN_OPENAI_GRANT the mint argv and body are unchanged", async () => {
  assert.equal(podPutBody([]).body, JSON.stringify({
    secretSha256: "a".repeat(64), providers: ["openai", "anthropic", "xai"], tenantId: "default",
    tokenRole: "service", retainRequestContent: false,
  }));
  const pod = fakePod();
  await new ClawRouterAdmin(loadConfig({ HOME: "/h" }), { runner: pod.runner }).mint("agentrun_test_000010");
  const tail = pod.calls[0].slice(pod.calls[0].indexOf(IN_POD_SCRIPT) + 1);
  assert.equal(tail.length, 3);
});

test("AGENT_RUN_OPENAI_GRANT limits the minted key to that OpenAI grant", async () => {
  const body = JSON.parse(podPutBody(["openai_work"]).body);
  assert.deepEqual(body.grantRouting, { eligibleGrants: { openai: ["openai_work"] } });
  const pod = fakePod();
  await new ClawRouterAdmin(loadConfig({ HOME: "/h", AGENT_RUN_OPENAI_GRANT: "openai_work" }), { runner: pod.runner }).mint("agentrun_test_000011");
  assert.equal(pod.calls[0].at(-1), "openai_work");
});

test("an invalid OpenAI grant reference is refused before and inside the pod", async () => {
  for (const bad of ["", "a/b", "x\u0001y", "z".repeat(257)]) {
    assert.throws(() => loadConfig({ HOME: "/h", AGENT_RUN_OPENAI_GRANT: bad }), /token reference/);
    await assert.rejects(new ClawRouterAdmin({ openaiGrant: bad }, { runner: fakePod().runner }).mint("agentrun_test_000012"), /invalid openai grant/);
  }
  for (const bad of [null, false, 0]) await assert.rejects(new ClawRouterAdmin({ openaiGrant: bad }, { runner: fakePod().runner }).mint("agentrun_test_000013"), /invalid openai grant/);
  assert.equal(loadConfig({ HOME: "/h", AGENT_RUN_OPENAI_GRANT: "openai-primary" }).openaiGrant, "openai-primary");
  const refused = podPutBody(["bad/ref"]);
  assert.equal(refused.body, undefined);
  assert.match(refused.stdout, /invalid openai grant/);
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

test("Pi converts Codex OAuth models to API-key Responses without changing other transports", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-run-pi-auth-"));
  const modelsFile = join(dir, "models.json");
  for (const api of ["anthropic-messages", "openai-codex-responses"]) {
    writeFileSync(modelsFile, JSON.stringify({ providers: { clawrouter: {
      baseUrl: "http://router:8798", api, apiKey: "laptop-secret",
      models: [
        { id: "inherited" },
        { id: "astra", api: "openai-codex-responses", baseUrl: "http://router:8798/v1" },
        { id: "astra-no-url", api: "openai-codex-responses" },
        { id: "n-sol", api: "openai-responses", baseUrl: "http://router:8798/v1" },
        { id: "claude", api: "anthropic-messages" },
      ],
    } } }));
    const files = HARNESSES.pi.remoteConfig({ config: { piModelsFile: modelsFile, piProvider: "clawrouter" }, remoteBaseUrl: "http://127.0.0.1:18789" });
    const p = JSON.parse(files["pi/models.json"]).providers.clawrouter;
    assert.equal(p.api, api === "openai-codex-responses" ? "openai-responses" : api);
    for (const m of p.models.slice(1, 4)) {
      assert.equal(m.api, "openai-responses");
      assert.equal(m.baseUrl, "http://127.0.0.1:18789/v1");
    }
    assert.equal(p.models[4].api, "anthropic-messages");
    assert.equal(p.models[0].api, api === "openai-codex-responses" ? "openai-responses" : undefined);
    assert.equal(p.apiKey, "$CLAWROUTER_API_KEY");
    assert.ok(!files["pi/models.json"].includes("laptop-secret"));
  }
});

test("warmup requests standard capacity and the selected donor", async () => {
  const box = new Crabbox({ crabboxProvider: "serve", crabboxType: "cpu2", crabboxMachine: "safe-donor", leaseIdleTimeout: "75m", leaseTtl: "90m" }, {
    runner: async (command, args) => {
      assert.equal(command, "crabbox");
      assert.deepEqual(args, ["warmup", "--provider", "serve", "--type", "cpu2", "--class", "standard", "--slug", "s", "--serve-machine", "safe-donor", "--idle-timeout", "75m", "--ttl", "90m"]);
      return { code: 0, stdout: "leased cbx_1 slug=s", stderr: "" };
    },
  });
  assert.equal((await box.warmup("s", sink())).leaseId, "cbx_1");
});

test("sweep leaves other hosts' keys alone and revokes only a dead local run", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-run-sweep-"));
  mkdirSync(join(stateDir, "locks"));
  writeFileSync(join(stateDir, "locks/agentrun_live.json"), JSON.stringify({ pid: process.pid }));
  writeFileSync(join(stateDir, "locks/agentrun_dead.json"), JSON.stringify({ pid: 2147483647 }));
  const revoked = [];
  await sweep({ stateDir }, {
    list: async () => ["agentrun_live", "agentrun_dead", "agentrun_otherhost"].map(credentialId => ({ credentialId, enabled: true })),
    revoke: async name => revoked.push(name),
  }, sink());
  assert.deepEqual(revoked, ["agentrun_dead"]);
});

function remoteFixture({ runExit = 0, failUpload = false, cacheHit = false, remoteToolCache = ".cache/crabbox-tools", warmupError, stopResult = { stopped: true, exitCode: 0, lease: "cbx_1" }, afterMint } = {}) {
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
    routerOrigin: "http://router.example:8789", remotePort: 18789, crabboxProvider: "serve", crabboxType: "cpu2", commandTimeoutMs: 12345,
    remoteToolCache,
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
    calls.push({ command, args, input: typeof options.input === "string" ? options.input : undefined, env: options.env, timeoutMs: options.timeoutMs });
    if (command === "tar" && args[0] === "-czf") {
      const inputDir = join(args[3], "inputs");
      if (existsSync(join(inputDir, "BOOTSTRAP.md"))) {
        const names = ["BOOTSTRAP.md", "IDENTITY.md", "USER.md", "SOUL.md", "memory/.keep"];
        calls.at(-1).workspaceFiles = Object.fromEntries(names.map((name) => [name, readFileSync(join(inputDir, name), "utf8")]));
      }
      const profile = join(args[3], "config/rusty/home/.rusty/profiles/agent-run.json");
      if (existsSync(profile)) calls.at(-1).rustyProfile = JSON.parse(readFileSync(profile, "utf8"));
      const grokConfig = join(args[3], "config/grok/home/.grok/config.toml");
      if (existsSync(grokConfig)) calls.at(-1).grokConfig = readFileSync(grokConfig, "utf8");
      const piContext = join(args[3], "config/pi/context.json");
      if (existsSync(piContext)) calls.at(-1).piContextFiles = Object.fromEntries(["context.json", "pi-context.mjs", "pi-context-turn.mjs"].map((name) => [name, readFileSync(join(args[3], "config/pi", name), "utf8")]));
      const primeConfig = join(args[3], "config/prime/home/.prime/agent/models.json");
      if (existsSync(primeConfig)) calls.at(-1).primeConfig = JSON.parse(readFileSync(primeConfig, "utf8"));
      writeFileSync(args[1], "");
    }
    if (options.input && typeof options.input.resume === "function") {
      await new Promise((done) => { options.input.on("end", done); options.input.on("error", done); options.input.resume(); });
    }
    const remote = args.at(-1) ?? "";
    if (command === "ssh" && remote.startsWith("mkdir") && failUpload) return { code: 255, stdout: "", stderr: "" };
    if (command === "ssh" && remote === "bash -s") return { code: runExit, stdout: "", stderr: "" };
    if (command === "ssh" && remote.includes("rc=1; if [ -f ")) return { code: 0, stdout: "agent-run-appliance-cache=" + (cacheHit ? "hit" : "miss") + "\n", stderr: "" };
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

test("agent-run place prints the capacity decision and treats queued placement as a successful lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-run-place-"));
  const helper = join(dir, "placement.mjs");
  const cli = fileURLToPath(new URL("../bin/agent-run.mjs", import.meta.url));
  writeFileSync(helper, [
    "const i = process.argv.indexOf('--task');",
    "console.log(JSON.stringify({ placement: 'queue', reason: 'test queue', queueFile: process.argv[i + 1] }));",
    "process.exitCode = 75;",
  ].join("\n"));
  const stdout = execFileSync(process.execPath, [cli, "place", "--harness", "pi", "--run-id", "fixture-123"], {
    encoding: "utf8", env: { HOME: dir, PATH: process.env.PATH, AGENT_RUN_PLACEMENT: helper },
  });
  assert.deepEqual(JSON.parse(stdout), {
    placement: "queue", reason: "test queue", queueFile: "agent-run/pi/fixture-123",
  });
});

test("--placement-decision uses the supplied local decision without invoking the placement helper", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-run-decision-cli-"));
  const binDir = join(dir, "bin");
  const out = join(dir, "out");
  const prompt = join(dir, "prompt.md");
  const decisionFile = join(dir, "placement.json");
  const invokedFile = join(dir, "pi-invoked");
  const pi = join(binDir, "pi");
  const helper = join(dir, "placement.mjs");
  const cli = fileURLToPath(new URL("../bin/agent-run.mjs", import.meta.url));
  mkdirSync(binDir);
  writeFileSync(prompt, "say hi\n");
  writeFileSync(decisionFile, JSON.stringify({ placement: "local", reason: "test local" }));
  writeFileSync(helper, "process.exitCode = 2;\n");
  writeFileSync(pi, `#!/bin/sh\ntouch "${invokedFile}"\n`);
  chmodSync(pi, 0o755);

  execFileSync(process.execPath, [cli, "--harness", "pi", "--prompt-file", prompt, "--out", out, "--placement-decision", decisionFile], {
    encoding: "utf8", env: { HOME: dir, PATH: `${binDir}:/bin:/usr/bin`, AGENT_RUN_PLACEMENT: helper },
  });
  assert.equal(existsSync(invokedFile), true);
  assert.equal(JSON.parse(readFileSync(join(out, "receipt.json"), "utf8")).placement.placement, "local");
});

test("agent-run place returns exit 2 when capacity placement fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-run-place-failure-"));
  const helper = join(dir, "placement.mjs");
  const cli = fileURLToPath(new URL("../bin/agent-run.mjs", import.meta.url));
  writeFileSync(helper, "process.exitCode = 2;\n");
  assert.throws(() => execFileSync(process.execPath, [cli, "place", "--harness", "pi"], {
    encoding: "utf8", env: { HOME: dir, PATH: process.env.PATH, AGENT_RUN_PLACEMENT: helper },
  }), (error) => error.status === 2);
});

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

test("a precomputed queue decision skips placement and removes its queue receipt after the remote run", async () => {
  const f = remoteFixture();
  const queueFile = join(f.dir, "queue.json");
  const decisionFile = join(f.dir, "placement.json");
  writeFileSync(queueFile, "queued\n");
  writeFileSync(decisionFile, JSON.stringify({ placement: "queue", queueFile }));
  f.options.placementDecision = decisionFile;
  f.deps.placement = async () => { assert.fail("precomputed decision must not call placement again"); };

  assert.equal(await agentRun(f.options, f.deps), 0);
  assert.equal(existsSync(queueFile), false);
  assert.equal(JSON.parse(readFileSync(join(f.options.out, "receipt.json"), "utf8")).queueReceiptRemoved, true);
});

test("remote results include reports and session files under --out", async () => {
  const f = remoteFixture();
  const source = join(f.dir, "remote-out");
  mkdirSync(join(source, "out"), { recursive: true });
  mkdirSync(join(source, "session"));
  writeFileSync(join(source, "out", "changes.patch"), "diff evidence");
  writeFileSync(join(source, "session", "last-message.md"), "done");
  const runner = f.deps.runner;
  f.deps.runner = async (command, args, options) => {
    if (command === "ssh" && args.at(-1).startsWith("tar -czf")) {
      assert.match(args.at(-1), /\/out'? \.$/);
      options.stdout.write(execFileSync("tar", ["-czf", "-", "-C", source, "."]));
      return { code: 0 };
    }
    if (command === "tar" && args[0] === "-xzf") {
      execFileSync(command, args);
      return { code: 0 };
    }
    return runner(command, args, options);
  };
  assert.equal(await agentRun(f.options, f.deps), 0);
  assert.equal(readFileSync(join(f.options.out, "out/changes.patch"), "utf8"), "diff evidence");
  assert.equal(readFileSync(join(f.options.out, "session/last-message.md"), "utf8"), "done");
  const script = f.calls.find(c => c.args.at(-1) === "bash -s").input;
  assert.ok(script.includes('export AGENT_RUN_OUT_DIR="$W/out/out"'));
  assert.ok(script.includes('ln -s "$W/out/out" "$W/inputs/out"'));
  assert.equal(JSON.parse(readFileSync(join(f.options.out, "receipt.json"))).resultsDownloaded, true);
});

test("a failed result download or extraction fails a successful run and still cleans up", async () => {
  for (const fail of ["ssh", "tar"]) {
    const f = remoteFixture();
    const runner = f.deps.runner;
    f.deps.runner = async (command, args, options) => {
      if (command === fail && (args.at(-1).startsWith("tar -czf") || args[0] === "-xzf")) return { code: 1 };
      return runner(command, args, options);
    };
    assert.equal(await agentRun(f.options, f.deps), EXIT_INFRA);
    const receipt = JSON.parse(readFileSync(join(f.options.out, "receipt.json")));
    assert.equal(receipt.resultsDownloaded, false);
    assert.equal(receipt.key.revokeProof.ok, true);
    assert.equal(receipt.target.cleanup.stopped, true);
  }
});

test("a signal skips session download and proceeds to cleanup", async () => {
  const f = remoteFixture();
  const runner = f.deps.runner;
  f.deps.runner = async (command, args, options) => {
    const result = await runner(command, args, options);
    if (command === "ssh" && args.at(-1) === "bash -s") process.emit("SIGTERM", "SIGTERM");
    return result;
  };
  assert.equal(await agentRun(f.options, f.deps), 0);
  assert.deepEqual(f.events, ["mint", "warmup", "revoke", "stop"]);
  assert.equal(f.calls.filter((call) => call.command === "ssh").length, 4);
  assert.equal(JSON.parse(readFileSync(join(f.options.out, "receipt.json"), "utf8")).sessionDownloaded, false);
});

test("failed revocation and uncertain mint retain ownership for the next sweep", async () => {
  for (const failure of ["revoke", "mint"]) {
    const f = remoteFixture();
    if (failure === "revoke") {
      f.deps.admin.revokeAndProve = async () => ({ ok: false, revoked: false, listEnabled: true });
    } else {
      const mint = f.deps.admin.mint;
      f.deps.admin.mint = async name => {
        await mint(name);
        throw new Error("mint reply and rollback failed");
      };
    }
    assert.notEqual(await agentRun(f.options, f.deps), 0);
    const receipt = JSON.parse(readFileSync(join(f.options.out, "receipt.json")));
    const lock = join(f.deps.config.stateDir, "locks", receipt.runId + ".json");
    assert.ok(JSON.parse(readFileSync(lock)).finishedAt);
    assert.deepEqual(await sweep(f.deps.config, f.deps.admin, sink()), [receipt.runId]);
    assert.equal(existsSync(lock), false);
    assert.equal((await f.deps.admin.list()).find(c => c.credentialId === receipt.runId).enabled, false);
  }
});

const isUpload = (call) => call.command === "ssh" && call.args.at(-1).includes("cat > ");
const isRestore = (call) => call.command === "ssh" && call.args.at(-1).includes("rc=1; if [ -f ");

test("an appliance in the lease cache is checked on a private copy and not uploaded", async () => {
  const f = remoteFixture({ cacheHit: true });
  assert.equal(await agentRun(f.options, f.deps), 0);
  assert.equal(f.calls.filter(isUpload).length, 0);
  const sha256 = createHash("sha256").update("appliance").digest("hex");
  const remote = f.calls.find(isRestore).args.at(-1);
  const entry = '"$HOME/.cache/crabbox-tools/agent-run/' + sha256 + '.tgz"';
  const copied = remote.indexOf("[ -f " + entry + " ] && [ ! -L " + entry + " ] && timeout 120 head -c 9 " + entry + " > ");
  const checked = remote.indexOf("sha256sum -c");
  const unpacked = remote.indexOf("tar -xzf");
  assert.ok(copied >= 0 && copied < checked && checked < unpacked, remote);
  assert.match(remote, new RegExp("echo '" + sha256 + "  /tmp/agentrun-[^']+/appl\\.tgz' \\| sha256sum -c"));
  const receipt = JSON.parse(readFileSync(join(f.options.out, "receipt.json"), "utf8"));
  assert.equal(receipt.appliance.cache, "hit");
  assert.equal(receipt.appliance.verifiedOnBox, true);
  assert.equal(receipt.appliance.upload, undefined);
});

test("a cache miss uploads, checks the upload, then stores it only where a cache exists", async () => {
  const f = remoteFixture();
  assert.equal(await agentRun(f.options, f.deps), 0);
  const sha256 = createHash("sha256").update("appliance").digest("hex");
  const remote = f.calls.find(isUpload).args.at(-1);
  const checked = remote.indexOf("sha256sum -c");
  const stored = remote.indexOf('mv -f "$t" "$HOME/.cache/crabbox-tools/agent-run/' + sha256 + '.tgz"');
  assert.ok(remote.includes('t=$(mktemp "$HOME/.cache/crabbox-tools/agent-run/.' + sha256 + '.XXXXXX") || exit 0'), remote);
  assert.ok(checked >= 0 && checked < stored, remote);
  assert.ok(remote.includes('if [ -d "$HOME/.cache/crabbox-tools" ] && [ -w "$HOME/.cache/crabbox-tools" ]; then'), remote);
  const receipt = JSON.parse(readFileSync(join(f.options.out, "receipt.json"), "utf8"));
  assert.equal(receipt.appliance.cache, "miss");
  assert.equal(receipt.appliance.upload.bytes, 9);
});

test("a failed cache lookup falls back to the upload", async () => {
  const f = remoteFixture();
  const runner = f.deps.runner;
  f.deps.runner = async (command, args, options) => {
    const result = await runner(command, args, options);
    return isRestore({ command, args }) ? { code: 255, stdout: "agent-run-appliance-cache=hit\n", stderr: "" } : result;
  };
  assert.equal(await agentRun(f.options, f.deps), 0);
  assert.equal(f.calls.filter(isUpload).length, 1);
});

test("the lease cache can be turned off and rejects paths outside the remote home", async () => {
  const f = remoteFixture({ remoteToolCache: null });
  assert.equal(await agentRun(f.options, f.deps), 0);
  assert.equal(f.calls.filter(isRestore).length, 0);
  assert.ok(!f.calls.find(isUpload).args.at(-1).includes("crabbox-tools"));
  assert.equal(JSON.parse(readFileSync(join(f.options.out, "receipt.json"), "utf8")).appliance.cache, "off");
  assert.equal(loadConfig({ HOME: "/h", AGENT_RUN_REMOTE_TOOL_CACHE: "off" }).remoteToolCache, undefined);
  assert.equal(loadConfig({ HOME: "/h" }).remoteToolCache, ".cache/crabbox-tools");
  const sha256 = "a".repeat(64);
  for (const bad of ["/abs", "../up", "a/../b", "a b", "$(id)", "a/"]) assert.throws(() => remoteApplianceCache({ remoteToolCache: bad }, sha256), /AGENT_RUN_REMOTE_TOOL_CACHE/);
  assert.throws(() => remoteApplianceCache({ remoteToolCache: "ok" }, "nothex"), /sha256/);
});

test("the lease cache commands store, restore and reject a changed file in a real shell", { skip: spawnSync("sh", ["-c", "command -v sha256sum"]).status !== 0 }, () => {
  const home = mkdtempSync(join(tmpdir(), "agent-run-cache-"));
  const source = join(home, "src");
  mkdirSync(source);
  writeFileSync(join(source, "bin.txt"), "harness");
  const tgz = join(home, "appliance.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", source, "bin.txt"]);
  const sha256 = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  const bytes = statSync(tgz).size;
  const cache = remoteApplianceCache({ remoteToolCache: ".cache/crabbox-tools" }, sha256);
  const cached = join(home, ".cache/crabbox-tools/agent-run", sha256 + ".tgz");
  const sh = (command, input) => spawnSync("sh", ["-c", command], { input, env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  const work = (name) => join(home, name);

  assert.equal(sh(applianceInstallCommand(work("no-cache"), sha256, cache), readFileSync(tgz)).status, 0);
  assert.equal(readFileSync(join(work("no-cache"), "appl/bin.txt"), "utf8"), "harness");
  assert.ok(!existsSync(join(home, ".cache")), "no cache directory is created where the provider mounted none");
  assert.match(sh(applianceRestoreCommand(work("cold"), sha256, cache, bytes)).stdout, /=miss\n$/);
  assert.ok(!existsSync(join(work("cold"), "appl")));

  mkdirSync(join(home, ".cache/crabbox-tools"), { recursive: true });
  assert.equal(sh(applianceInstallCommand(work("first"), sha256, cache), readFileSync(tgz)).status, 0);
  assert.deepEqual(readFileSync(cached), readFileSync(tgz));
  const hit = sh(applianceRestoreCommand(work("second"), sha256, cache, bytes));
  assert.equal(hit.stdout, "agent-run-appliance-cache=hit\n");
  assert.equal(readFileSync(join(work("second"), "appl/bin.txt"), "utf8"), "harness");
  assert.ok(!existsSync(join(work("second"), "appl.tgz")));

  assert.notEqual(sh(applianceInstallCommand(work("bad-upload"), sha256, cache), "not the appliance").status, 0);
  assert.ok(!existsSync(join(work("bad-upload"), "appl/bin.txt")));
  assert.deepEqual(readFileSync(cached), readFileSync(tgz), "a failed upload does not replace the cached file");

  writeFileSync(cached, "swapped by another lease");
  const changed = sh(applianceRestoreCommand(work("third"), sha256, cache, bytes));
  assert.equal(changed.stdout, "agent-run-appliance-cache=miss\n");
  assert.ok(!existsSync(join(work("third"), "appl")) && !existsSync(join(work("third"), "appl.tgz")));

  // A pipe in the entry's place would block a plain copy until a writer came.
  rmSync(cached);
  assert.equal(spawnSync("mkfifo", [cached]).status, 0);
  const pipe = spawnSync("sh", ["-c", applianceRestoreCommand(work("pipe"), sha256, cache, bytes)], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20_000 });
  assert.equal(pipe.status, 0, "the restore returns: " + pipe.signal);
  assert.equal(pipe.stdout, "agent-run-appliance-cache=miss\n");
  // An entry longer than the appliance is cut at the appliance's size, then fails the check.
  rmSync(cached);
  writeFileSync(cached, Buffer.concat([readFileSync(tgz), Buffer.alloc(4096)]));
  assert.equal(sh(applianceRestoreCommand(work("long"), sha256, cache, bytes)).stdout, "agent-run-appliance-cache=hit\n");
  writeFileSync(cached, Buffer.alloc(bytes + 4096, 1));
  assert.equal(sh(applianceRestoreCommand(work("endless"), sha256, cache, bytes)).stdout, "agent-run-appliance-cache=miss\n");
  assert.equal(statSync(cached).size, bytes + 4096);
  writeFileSync(cached, readFileSync(tgz));

  // Another lease can leave anything in the shared directory. A store that
  // cannot work must not fail the run, and a directory in the file's place is replaced.
  rmSync(cached);
  mkdirSync(join(cached, "trap"), { recursive: true });
  assert.equal(sh(applianceInstallCommand(work("dir-in-place"), sha256, cache), readFileSync(tgz)).status, 0);
  assert.equal(readFileSync(join(work("dir-in-place"), "appl/bin.txt"), "utf8"), "harness");
  assert.deepEqual(readFileSync(cached), readFileSync(tgz));
  rmSync(join(home, ".cache/crabbox-tools/agent-run"), { recursive: true });
  writeFileSync(join(home, ".cache/crabbox-tools/agent-run"), "not a directory");
  const blocked = sh(applianceInstallCommand(work("blocked-store"), sha256, cache), readFileSync(tgz));
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(readFileSync(join(work("blocked-store"), "appl/bin.txt"), "utf8"), "harness");
  assert.equal(readFileSync(join(home, ".cache/crabbox-tools/agent-run"), "utf8"), "not a directory");
  assert.equal(readdirSync(join(home, ".cache/crabbox-tools")).length, 1, "no temp file is left behind");
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

test("Grok uses the xAI ClawRouter route with a per-run key and isolated profile", () => {
  const files = HARNESSES.grok.remoteConfig({ remoteBaseUrl: "http://127.0.0.1:18789", model: "clawrouter/xai/grok-4.7" });
  const config = files["grok/home/.grok/config.toml"];
  assert.match(config, /^\[model\.agent-run\]$/m);
  assert.match(config, /^model = "xai\/grok-4\.7"$/m);
  assert.match(config, /^base_url = "http:\/\/127\.0\.0\.1:18789\/v1"$/m);
  assert.match(config, /^env_key = "XAI_API_KEY"$/m);
  assert.match(config, /^api_backend = "chat_completions"$/m);
  assert.doesNotMatch(config, /api_key\s*=/);
  assert.deepEqual(HARNESSES.grok.keyEnv, ["XAI_API_KEY"]);
  assert.deepEqual(HARNESSES.grok.remoteEnv({ configDir: "/w/config" }), {
    HOME: "/w/config/grok/home", GROK_HOME: "/w/config/grok/home/.grok", GROK_DISABLE_AUTOUPDATER: "1",
  });
  assert.deepEqual(HARNESSES.grok.remoteArgv({ model: "xai/grok-4.7", thinking: "high", promptFile: "/w/inputs/prompt.md" }), [
    "grok", "--prompt-file", "/w/inputs/prompt.md", "--model", "agent-run", "--permission-mode", "bypassPermissions",
    "--reasoning-effort", "high",
  ]);
  assert.ok(HARNESSES.grok.remoteCollect({ configDir: "/w/config", sessionDir: "/w/out/session" })[0].includes("/grok/home/.grok/sessions"));
  assert.throws(() => HARNESSES.grok.remoteConfig({ remoteBaseUrl: "http://127.0.0.1:18789", model: "clawrouter/gpt-6-sol" }), /must be a Grok model/);
  assert.deepEqual(HARNESSES.grok.localArgv({ model: "clawrouter/grok-4.7", thinking: "medium", prompt: "hi" }), [
    "grok", "--single", "hi", "--model", "grok-4.7", "--reasoning-effort", "medium",
  ]);
  assert.deepEqual(HARNESSES.grok.localArgv({ thinking: "minimal", prompt: "hi" }).slice(-2), ["--reasoning-effort", "low"]);
  assert.deepEqual(HARNESSES.grok.localArgv({ thinking: "max", prompt: "hi" }).slice(-2), ["--reasoning-effort", "xhigh"]);
});

test("Prime Agent configures OpenAI Responses through the tunnel and isolates its profile", () => {
  const files = HARNESSES.prime.remoteConfig({ remoteBaseUrl: "http://127.0.0.1:18789", model: "clawrouter/gpt-6-sol" });
  const config = JSON.parse(files["prime/home/.prime/agent/models.json"]);
  assert.equal(config.providers.openai.baseUrl, "http://127.0.0.1:18789/v1");
  assert.deepEqual(config.providers.openai.models[0], {
    id: "gpt-6-sol", name: "gpt-6-sol (ClawRouter)", api: "openai-responses", reasoning: true,
    input: ["text"], contextWindow: 200000, maxTokens: 8192,
  });
  assert.equal(config.providers.openai.apiKey, undefined);
  assert.equal(config.providers.openai.models[0].apiKey, undefined);
  assert.deepEqual(HARNESSES.prime.remoteEnv({ configDir: "/w/config" }), {
    HOME: "/w/config/prime/home", PRIME_AGENT_TELEMETRY: "0",
  });
  assert.deepEqual(HARNESSES.prime.keyEnv, ["OPENAI_API_KEY"]);
  assert.deepEqual(HARNESSES.prime.remoteArgv({ model: "clawrouter/gpt-6-sol", thinking: "high", sessionDir: "/w/out/session" }), [
    "prime-agent", "--offline", "--print", "--mode", "text", "--provider", "openai", "--model", "gpt-6-sol",
    "--session-dir", "/w/out/session/prime-agent", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--thinking", "high",
  ]);
  assert.deepEqual(HARNESSES.prime.localArgv({ model: "gpt-6-sol", prompt: "hi", sessionDir: "/s" }).slice(-2), ["--", "hi"]);
  assert.throws(() => HARNESSES.prime.remoteArgv({ model: "xai/grok-4.7", sessionDir: "/s" }), /must be a GPT model/);
});

test("OpenClaw maps allowed models to OpenAI or Anthropic and isolates state", () => {
  const openai = HARNESSES.openclaw.remoteConfig({ remoteBaseUrl: "http://127.0.0.1:18789", model: "clawrouter/gpt-6-sol", workdir: "/w" });
  const openaiConfig = JSON.parse(openai["openclaw/openclaw.json"]);
  assert.equal(openaiConfig.gateway.mode, "local");
  assert.equal(openaiConfig.agents.defaults.model.primary, "openai/gpt-6-sol");
  assert.equal(openaiConfig.agents.defaults.workspace, "/w/inputs");
  assert.equal(openaiConfig.models.providers.openai.baseUrl, "http://127.0.0.1:18789/v1");
  assert.equal(openaiConfig.models.providers.openai.api, "openai-responses");
  assert.deepEqual(openaiConfig.models.providers.openai.apiKey, { source: "env", provider: "default", id: "OPENAI_API_KEY" });
  assert.deepEqual(HARNESSES.openclaw.keyEnv({ model: "openai/gpt-6-sol" }), ["OPENAI_API_KEY"]);
  const localArgv = HARNESSES.openclaw.localArgv({ model: "clawrouter/gpt-6-sol", prompt: "hi", runId: "local-1" });
  assert.deepEqual(localArgv.slice(localArgv.indexOf("--model"), localArgv.indexOf("--model") + 2), ["--model", "openai/gpt-6-sol"]);

  const anthropic = HARNESSES.openclaw.remoteConfig({ remoteBaseUrl: "http://127.0.0.1:18789", model: "clawrouter/claude-sonnet-4.6", workdir: "/w" });
  const anthropicConfig = JSON.parse(anthropic["openclaw/openclaw.json"]);
  assert.equal(anthropicConfig.agents.defaults.model.primary, "anthropic/claude-sonnet-4.6");
  assert.equal(anthropicConfig.models.providers.anthropic.baseUrl, "http://127.0.0.1:18789");
  assert.equal(anthropicConfig.models.providers.anthropic.api, "anthropic-messages");
  assert.deepEqual(HARNESSES.openclaw.keyEnv({ model: "anthropic/claude-sonnet-4.6" }), ["ANTHROPIC_API_KEY"]);
  for (const model of ["xai/grok-4.7", "clawrouter/grok-4.7", "grok-4.7"]) {
    assert.throws(() => HARNESSES.openclaw.remoteConfig({ remoteBaseUrl: "http://127.0.0.1:18789", model }), /XAI models are not allowed/);
  }
  assert.throws(() => HARNESSES.openclaw.remoteConfig({ remoteBaseUrl: "http://127.0.0.1:18789", model: "clawrouter/gemini-3" }), /must identify an OpenAI or Anthropic/);

  assert.deepEqual(HARNESSES.openclaw.remoteEnv({ configDir: "/w/config" }), {
    OPENCLAW_CONFIG_PATH: "/w/config/openclaw/openclaw.json",
    OPENCLAW_STATE_DIR: "/w/config/openclaw/state",
  });
  assert.deepEqual(HARNESSES.openclaw.remoteArgv({
    model: "clawrouter/gpt-6-sol", thinking: "high", runId: "agentrun_1", promptFile: "/w/inputs/prompt.md",
  }), ["openclaw", "agent", "--local", "--agent", "main", "--session-id", "agentrun_1", "--message-file", "/w/inputs/prompt.md", "--model", "openai/gpt-6-sol", "--thinking", "high", "--timeout", "840", "--json"]);
  assert.ok(HARNESSES.openclaw.remoteCollect({ configDir: "/w/config", sessionDir: "/w/out/session" })[0].includes("agents/main/sessions"));
});

test("OpenClaw remote run streams a single turn and collects its session", async () => {
  const f = remoteFixture();
  f.deps.pins.harnesses.openclaw = { package: "openclaw", version: "2026.7.1", bin: "openclaw" };
  const index = join(f.deps.config.cacheDir, "appliances", "index.json");
  const entries = JSON.parse(readFileSync(index, "utf8"));
  writeFileSync(index, JSON.stringify({ ...entries, "openclaw-2026.7.1-node24": entries["pi-1.0.0-node24"] }));
  assert.equal(await agentRun({ ...f.options, harness: "openclaw", model: "clawrouter/gpt-6-sol", thinking: "high" }, f.deps), 0);
  const script = f.calls.find((c) => c.args.at(-1) === "bash -s").input;
  assert.match(script, /^export OPENAI_API_KEY="\$CLAWROUTER_API_KEY"$/m);
  assert.ok(script.includes("openclaw agent --local --agent main --session-id agentrun_"));
  assert.ok(script.includes("--message-file "));
  assert.ok(script.includes("--model openai/gpt-6-sol --thinking high --timeout 840 --json"));
  assert.ok(script.includes("agents/main/sessions"));
  const workspaceFiles = f.calls.find((c) => c.command === "tar").workspaceFiles;
  assert.match(workspaceFiles["BOOTSTRAP.md"], /Do not run onboarding/);
  assert.match(workspaceFiles["IDENTITY.md"], /disposable task-scoped software agent/);
  assert.match(workspaceFiles["USER.md"], /No persistent user profile/);
  assert.match(workspaceFiles["SOUL.md"], /Protect credentials and private data/);
  assert.equal(workspaceFiles["memory/.keep"], "");
  assert.equal(script.match(new RegExp(f.token, "g")).length, 1, "the per-run key is injected only once");
  assert.deepEqual(f.events, ["mint", "warmup", "revoke", "stop"]);
});

test("Grok remote run uses the xAI key, pinned appliance, and isolated session", async () => {
  const f = remoteFixture();
  const digest = "8e59eb3e32ef1a185de8ec5ebed7b64d30986abd5e20923d1695accca6e0645b";
  f.deps.pins.harnesses.grok = {
    package: "grok", version: "1.0.78", bin: "grok", platform: "linux-x64",
    artifact: { url: "https://x.ai/cli/grok-1.0.78-linux-x86_64", format: "binary", sha256: digest },
  };
  const key = applianceKey(f.deps.pins, "grok");
  const index = join(f.deps.config.cacheDir, "appliances", "index.json");
  const entries = JSON.parse(readFileSync(index, "utf8"));
  writeFileSync(index, JSON.stringify({ ...entries, [key]: {
    path: join(f.deps.config.cacheDir, "appliances/pi.tgz"),
    sha256: createHash("sha256").update("appliance").digest("hex"), package: "grok", version: "1.0.78",
  } }));
  assert.equal(await agentRun({ ...f.options, harness: "grok", model: "xai/grok-4.7", thinking: "high" }, f.deps), 0);
  const script = f.calls.find((call) => call.args.at(-1) === "bash -s").input;
  assert.match(script, /^export XAI_API_KEY="\$CLAWROUTER_API_KEY"$/m);
  assert.match(script, /^grok --prompt-file .* --model agent-run --permission-mode bypassPermissions --reasoning-effort high <\/dev\/null$/m);
  assert.equal(script.match(new RegExp(f.token, "g")).length, 1, "the per-run key is injected only once");
  const archive = f.calls.find((call) => call.command === "tar" && call.args[0] === "-czf");
  assert.match(archive.grokConfig, /^model = "xai\/grok-4\.7"$/m);
  assert.ok(archive.grokConfig.includes("base_url = \"http://127.0.0.1:18789/v1\""));
  assert.deepEqual(f.events, ["mint", "warmup", "revoke", "stop"]);
});

test("Prime Agent remote run injects an OpenAI per-run key and isolates sessions", async () => {
  const f = remoteFixture();
  const digest = "c16bd2af5e77b53f49b914a44742c4cf6a67c5ed5000041430b78dbd4c3bcbec";
  f.deps.pins.harnesses.prime = {
    package: "prime-agent", version: "0.10.0", bin: "prime-agent", platform: "linux-x64",
    artifact: { format: "bundle", sha256: digest, bundleDir: "prime-agent", binPath: "prime-agent" },
  };
  const key = applianceKey(f.deps.pins, "prime");
  const index = join(f.deps.config.cacheDir, "appliances", "index.json");
  const entries = JSON.parse(readFileSync(index, "utf8"));
  writeFileSync(index, JSON.stringify({ ...entries, [key]: {
    path: join(f.deps.config.cacheDir, "appliances/pi.tgz"),
    sha256: createHash("sha256").update("appliance").digest("hex"), package: "prime-agent", version: "0.10.0",
  } }));
  assert.equal(await agentRun({ ...f.options, harness: "prime", model: "clawrouter/gpt-6-sol", thinking: "high" }, f.deps), 0);
  const script = f.calls.find((call) => call.args.at(-1) === "bash -s").input;
  assert.match(script, /^export OPENAI_API_KEY="\$CLAWROUTER_API_KEY"$/m);
  assert.match(script, /prime-agent --offline --print --mode text --provider openai --model gpt-6-sol --session-dir .* --no-context-files --no-skills --no-prompt-templates --no-themes --thinking high --/);
  assert.equal(script.match(new RegExp(f.token, "g")).length, 1, "the key appears once, in the injected environment");
  const archive = f.calls.find((call) => call.command === "tar" && call.args[0] === "-czf");
  assert.equal(archive.primeConfig.providers.openai.baseUrl, "http://127.0.0.1:18789/v1");
  assert.deepEqual(f.events, ["mint", "warmup", "revoke", "stop"]);
});

test("Rusty runs one Responses turn with a throwaway profile and per-run key", async () => {
  const f = remoteFixture();
  const digest = "4554c6dbb2dd35e50b161e6d4134cda56b3ea14d28a11dfdc7b8bee2cbf996db";
  f.deps.pins.harnesses.rusty = {
    package: "rustyd", version: "0.1.5", bin: "rustyd", platform: "linux-x64",
    artifact: { url: "https://example.invalid/rustyd.tgz", sha256: digest, member: "rustyd" },
  };
  const key = applianceKey(f.deps.pins, "rusty");
  const index = join(f.deps.config.cacheDir, "appliances", "index.json");
  writeFileSync(index, JSON.stringify({ [key]: {
    path: join(f.deps.config.cacheDir, "appliances/pi.tgz"),
    sha256: createHash("sha256").update("appliance").digest("hex"), package: "rustyd", version: "0.1.5",
  } }));
  assert.equal(await agentRun({ ...f.options, harness: "rusty", model: "clawrouter/gpt-6-sol", thinking: "high" }, f.deps), 0);
  const script = f.calls.find((call) => call.args.at(-1) === "bash -s").input;
  assert.match(script, /^export OPENAI_API_KEY="\$CLAWROUTER_API_KEY"$/m);
  assert.match(script, /^rustyd print .* --output-format text --provider responses --bridge http:\/\/127\.0\.0\.1:18789 --model gpt-6-sol --profile agent-run --reasoning-effort high <"\$W\/inputs\/prompt\.md"$/m);
  assert.equal(script.match(new RegExp(f.token, "g")).length, 1, "the per-run key appears only in the injected environment");
  const archive = f.calls.find((call) => call.command === "tar");
  assert.equal(archive.rustyProfile.name, "agent-run");
  assert.deepEqual(archive.rustyProfile.permissions, { allow: [], deny: ["*"] });
  assert.deepEqual(HARNESSES.rusty.remoteEnv({ configDir: "/w/config" }), {
    HOME: "/w/config/rusty/home", RUSTY_SESSION_DIR: "/w/config/rusty/home/.rusty",
    RUSTY_NO_WORKTREE: "1", RUSTY_AGENT_RELAY: "0", RUSTY_HERDR_REPORT: "0",
  });
  assert.deepEqual(f.events, ["mint", "warmup", "revoke", "stop"]);
});

test("Claude gets the per-run key as ANTHROPIC_API_KEY, the prompt on stdin and the tunnel as base URL", async () => {
  const f = remoteFixture();
  f.deps.pins.harnesses.claude = { package: "c", version: "1.0.0", bin: "claude" };
  const index = join(f.deps.config.cacheDir, "appliances", "index.json");
  const entries = JSON.parse(readFileSync(index, "utf8"));
  writeFileSync(index, JSON.stringify({ ...entries, "claude-1.0.0-node24": entries["pi-1.0.0-node24"] }));
  assert.equal(await agentRun({ ...f.options, harness: "claude", model: "clawrouter/claude-x", thinking: "minimal" }, f.deps), 0);
  const script = f.calls.find((c) => c.args.at(-1) === "bash -s").input;
  assert.match(script, /^export ANTHROPIC_API_KEY="\$CLAWROUTER_API_KEY"$/m);
  assert.match(script, /^export ANTHROPIC_BASE_URL='?http:\/\/127\.0\.0\.1:18789'?$/m);
  assert.match(script, /^claude -p --output-format text --model claude-x --effort low --bare --dangerously-skip-permissions <"\$W\/inputs\/prompt\.md"$/m);
  assert.match(script, /PATH="\$W\/appl\/bin:/);
  assert.equal(script.match(new RegExp(f.token, "g")).length, 1, "the key appears once, in CLAWROUTER_API_KEY");
});

test("remote commands inherit the configured timeout", async () => {
  const f = remoteFixture();
  assert.equal(await agentRun(f.options, f.deps), 0);
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every((call) => call.timeoutMs === f.deps.config.commandTimeoutMs));
});

test("local placement runs the harness on the laptop with no key and no lease", async () => {
  const f = remoteFixture();
  f.deps.placement = async () => ({ placement: "local" });
  assert.equal(await agentRun(f.options, f.deps), 0);
  assert.deepEqual(f.events, []);
  assert.equal(f.calls[0].command, "pi");
  assert.equal(f.calls[0].timeoutMs, undefined, "keep the local harness in the foreground process group");
  assert.deepEqual(f.calls[0].args.slice(0, 1), ["-p"]);
});

test("local Rusty uses an ephemeral session directory and disables relay sidecars", async () => {
  const f = remoteFixture();
  f.deps.placement = async () => ({ placement: "local" });
  assert.equal(await agentRun({ ...f.options, harness: "rusty", model: "clawrouter/gpt-6-sol", thinking: "high" }, f.deps), 0);
  const call = f.calls[0];
  assert.equal(call.command, "rusty");
  assert.deepEqual(call.args, ["-p", "--output-format", "text", "--model", "gpt-6-sol", "--effort", "high"]);
  assert.throws(() => HARNESSES.rusty.localArgv({ thinking: "unknown" }), /unknown thinking level/);
  assert.equal(call.input, readFileSync(f.options.promptFile, "utf8"));
  assert.equal(call.env.RUSTY_SESSION_DIR, f.options.out + "/session");
  assert.equal(call.env.RUSTY_NO_WORKTREE, "1");
  assert.equal(call.env.RUSTY_AGENT_RELAY, "0");
  assert.equal(call.env.RUSTY_HERDR_REPORT, "0");
});

function withPiContext(f, context = { version: 1, systemPrompt: "PRIVATE SYSTEM\n", tools: ["read"], history: [] }) {
  const file = join(f.dir, "context.json");
  writeFileSync(file, JSON.stringify(context));
  f.options.piContextFile = file;
  f.deps.pins.harnesses.pi = { package: "@earendil-works/pi-coding-agent", version: "1.5.0", bin: "pi" };
  const index = join(f.deps.config.cacheDir, "appliances", "index.json");
  const entries = JSON.parse(readFileSync(index, "utf8"));
  writeFileSync(index, JSON.stringify({ ...entries, "pi-1.5.0-node24": entries["pi-1.0.0-node24"] }));
  return context;
}

test("Pi child context is staged privately per run, never in the appliance or receipt", async () => {
  const f = remoteFixture();
  const context = withPiContext(f);
  assert.equal(await agentRun(f.options, f.deps), 0);
  const packed = f.calls.find((c) => c.piContextFiles);
  assert.deepEqual(JSON.parse(packed.piContextFiles["context.json"]), context);
  assert.match(packed.piContextFiles["pi-context-turn.mjs"], /tools: context.tools/);
  assert.match(packed.piContextFiles["pi-context.mjs"], /validatePiContext/);
  assert.equal(existsSync(packed.args[3]), false, "staging context removed after cleanup");
  const script = f.calls.find((c) => c.args.at(-1) === "bash -s").input;
  assert.ok(script.includes("node ") && script.includes("/config/pi/pi-context-turn.mjs"));
  assert.ok(script.includes("/appl/app/node_modules/@earendil-works/pi-coding-agent"));
  assert.ok(!script.includes('$(cat "$W/inputs/prompt.md")'), "current prompt travels only through its file");
  assert.ok(!script.includes(context.systemPrompt));
  const receipt = readFileSync(join(f.options.out, "receipt.json"), "utf8");
  assert.ok(!receipt.includes("PRIVATE SYSTEM"));
  assert.deepEqual(JSON.parse(receipt).piContext, { version: 1, sdkVersion: "1.5.0", tools: ["read"], historyMessages: 0 });
  assert.deepEqual(f.events, ["mint", "warmup", "revoke", "stop"]);
});

test("invalid Pi context fails before placement, mint, lease or child execution", async () => {
  for (const mutation of [{ tools: ["codemode"] }, { history: [{ role: "system", content: "policy", timestamp: 1 }] }, { tools: undefined }]) {
    const f = remoteFixture();
    withPiContext(f, { version: 1, systemPrompt: "", tools: [], history: [], ...mutation });
    f.deps.placement = async () => assert.fail("placement must not run");
    await assert.rejects(() => agentRun(f.options, f.deps), /invalid --pi-context-file/);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.calls, []);
  }
});

test("Pi context rejects local placement, other harnesses, missing model and unsupported SDK pins", async () => {
  const local = remoteFixture();
  withPiContext(local);
  local.deps.placement = async () => ({ placement: "local" });
  await assert.rejects(() => agentRun(local.options, local.deps), /caller must keep the existing local session/);
  assert.deepEqual(local.calls, []);
  assert.deepEqual(local.events, []);
  for (const mutation of [{ harness: "grok" }, { model: undefined }, { thinking: "invented" }]) {
    const f = remoteFixture();
    withPiContext(f);
    await assert.rejects(() => agentRun({ ...f.options, ...mutation }, f.deps));
    assert.deepEqual(f.events, []);
  }
  const wrongPin = remoteFixture();
  withPiContext(wrongPin);
  wrongPin.deps.pins.harnesses.pi.version = "1.4.0";
  await assert.rejects(() => agentRun(wrongPin.options, wrongPin.deps), /pinned Pi SDK appliance/);
  assert.deepEqual(wrongPin.events, []);
});

test("loadConfig refuses a pin to the banned rp-kube-01 donor", () => {
  assert.throws(() => loadConfig({ HOME: "/h", AGENT_RUN_CRABBOX_MACHINE: "rp-kube-01" }), /rp-kube-01 is banned/);
  assert.equal(loadConfig({ HOME: "/h", AGENT_RUN_CRABBOX_MACHINE: "lue-dl360-worker-01-donor" }).crabboxMachine, "lue-dl360-worker-01-donor");
  assert.equal(loadConfig({ HOME: "/h" }).crabboxMachine, undefined);
});
