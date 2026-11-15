// Appliance cache concurrency, tested with real processes.
//
// This file is also the child process: with APPLIANCE_CHILD set it calls
// ensureAppliance once and prints the result. The parent holds every build
// open with a gate file, so the overlap does not depend on timing.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applianceKey, ensureAppliance } from "../lib/appliance.mjs";
import { run } from "../lib/proc.mjs";

const self = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixtureBytes = (harness) => Buffer.from("fixture binary for " + harness + "\n");

function fixturePins(harnesses) {
  const pins = { node: { version: "0.0.0" }, harnesses: {} };
  for (const harness of harnesses) {
    pins.harnesses[harness] = {
      package: "fixture-" + harness, version: "1.0.0", bin: "fixture", platform: "linux-x64",
      artifact: { format: "binary", url: "https://fixture.invalid/" + harness, sha256: createHash("sha256").update(fixtureBytes(harness)).digest("hex") },
    };
  }
  return pins;
}

if (process.env.APPLIANCE_CHILD) {
  const { cacheDir, harness, harnesses, trace, gate, fail } = JSON.parse(process.env.APPLIANCE_CHILD);
  // The fake download: record the build, wait for the parent's gate, then succeed or fail.
  const fetcher = async () => {
    appendFileSync(trace, harness + " " + process.pid + "\n");
    while (!existsSync(gate)) await sleep(10);
    if (fail) return { ok: false, status: 500 };
    return { ok: true, arrayBuffer: async () => fixtureBytes(harness) };
  };
  try {
    const appliance = await ensureAppliance({ config: { cacheDir }, pins: fixturePins(harnesses), harness, log: process.stderr, runner: run, fetcher });
    process.stdout.write(JSON.stringify(appliance));
  } catch (error) {
    process.stderr.write("child failed: " + error.message + "\n");
    process.exitCode = 1;
  }
} else {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");

  function scene(t, harnesses) {
    const root = mkdtempSync(join(tmpdir(), "agent-run-conc-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const made = { root, cacheDir: join(root, "cache"), trace: join(root, "trace"), gate: join(root, "gate"), harnesses, children: [] };
    writeFileSync(made.trace, "");
    t.after(() => { for (const child of made.children) child.proc.kill("SIGKILL"); });
    return made;
  }

  function start(made, harness, extra = {}) {
    const env = { ...process.env, APPLIANCE_CHILD: JSON.stringify({ cacheDir: made.cacheDir, harness, harnesses: made.harnesses, trace: made.trace, gate: made.gate, ...extra }) };
    delete env.NODE_TEST_CONTEXT;
    const proc = spawn(process.execPath, [self], { env, stdio: ["ignore", "pipe", "pipe"] });
    const child = { proc, harness, stdout: "", stderr: "" };
    proc.stdout.on("data", (chunk) => { child.stdout += chunk; });
    proc.stderr.on("data", (chunk) => { child.stderr += chunk; });
    child.done = new Promise((resolve) => proc.on("close", (code, signal) => resolve({ code, signal })));
    made.children.push(child);
    return child;
  }

  const builds = (made) => readFileSync(made.trace, "utf8").split("\n").filter(Boolean);
  const waiting = (child) => child.stderr.includes("agent-run: waiting for pid ");
  const index = (made) => JSON.parse(readFileSync(join(made.cacheDir, "appliances", "index.json"), "utf8"));

  async function until(condition, what) {
    const deadline = Date.now() + 30_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
      await sleep(10);
    }
  }

  // Nothing temporary is left in the shared directories, and no lock is held.
  function assertClean(made) {
    const leftovers = [];
    for (const dir of ["appliances", "artifacts"]) {
      for (const name of readdirSync(join(made.cacheDir, dir))) if (/partial|\.tmp$|^download-/.test(name)) leftovers.push(dir + "/" + name);
    }
    for (const name of readdirSync(made.cacheDir)) if (name.startsWith("build-")) leftovers.push(name);
    for (const lock of readdirSync(join(made.cacheDir, "locks"))) {
      for (const name of readdirSync(join(made.cacheDir, "locks", lock))) leftovers.push("locks/" + lock + "/" + name);
    }
    assert.deepEqual(leftovers, []);
  }

  test("concurrent ensureAppliance calls from separate processes share one cold build", async (t) => {
    const made = scene(t, ["alpha"]);
    const children = Array.from({ length: 4 }, () => start(made, "alpha"));
    // Every process has either started a build or is waiting for the builder.
    await until(() => builds(made).length + children.filter(waiting).length >= children.length, "all processes to build or wait");
    assert.equal(builds(made).length, 1, "exactly one process builds");
    writeFileSync(made.gate, "");
    const exits = await Promise.all(children.map((child) => child.done));
    assert.deepEqual(exits.map((exit) => exit.code), [0, 0, 0, 0], children.map((child) => child.stderr).join("\n"));
    assert.equal(builds(made).length, 1, "no process builds again after the lock is released");
    const results = children.map((child) => JSON.parse(child.stdout));
    const key = applianceKey(fixturePins(["alpha"]), "alpha");
    for (const result of results) {
      assert.equal(result.key, key);
      assert.equal(result.path, results[0].path);
      assert.equal(result.sha256, results[0].sha256);
    }
    assert.equal(createHash("sha256").update(readFileSync(results[0].path)).digest("hex"), results[0].sha256);
    assert.deepEqual(Object.keys(index(made)), [key]);
    assertClean(made);
  });

  test("concurrent builds of different harnesses all keep their index entries", async (t) => {
    const harnesses = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const made = scene(t, harnesses);
    const children = harnesses.map((harness) => start(made, harness));
    // Different appliances do not wait for each other: all six builds are open at once.
    await until(() => builds(made).length === harnesses.length, "all builds to start");
    assert.equal(children.filter(waiting).length, 0);
    writeFileSync(made.gate, "");
    const exits = await Promise.all(children.map((child) => child.done));
    assert.deepEqual(exits.map((exit) => exit.code), harnesses.map(() => 0), children.map((child) => child.stderr).join("\n"));
    const pins = fixturePins(harnesses);
    const recorded = index(made);
    assert.deepEqual(Object.keys(recorded).sort(), harnesses.map((harness) => applianceKey(pins, harness)).sort());
    for (const child of children) {
      const result = JSON.parse(child.stdout);
      assert.equal(recorded[result.key].path, result.path);
      assert.equal(recorded[result.key].harness, child.harness);
      assert.ok(existsSync(result.path));
    }
    assertClean(made);
  });

  test("a failed build releases the lock, leaves no partial files, and the waiter retries", async (t) => {
    const made = scene(t, ["alpha"]);
    const failing = start(made, "alpha", { fail: true });
    await until(() => builds(made).length === 1, "the failing build to start");
    const retrying = start(made, "alpha");
    await until(() => waiting(retrying), "the second process to wait");
    writeFileSync(made.gate, "");
    const [failed, retried] = await Promise.all([failing.done, retrying.done]);
    assert.equal(failed.code, 1);
    assert.match(failing.stderr, /child failed: release artifact download failed: HTTP 500/);
    assert.equal(retried.code, 0, retrying.stderr);
    assert.equal(builds(made).length, 2, "the waiter builds after the failure");
    const result = JSON.parse(retrying.stdout);
    assert.deepEqual(Object.keys(index(made)), [result.key]);
    assert.ok(existsSync(result.path));
    assertClean(made);
  });

  test("a killed builder does not block the next process", async (t) => {
    const made = scene(t, ["alpha"]);
    const doomed = start(made, "alpha");
    await until(() => builds(made).length === 1, "the first build to start");
    const next = start(made, "alpha");
    await until(() => waiting(next), "the second process to wait");
    // SIGKILL: the builder cannot release its lock or clean up.
    doomed.proc.kill("SIGKILL");
    assert.equal((await doomed.done).signal, "SIGKILL");
    await until(() => builds(made).length === 2, "the second process to take over the build");
    writeFileSync(made.gate, "");
    assert.equal((await next.done).code, 0, next.stderr);
    const result = JSON.parse(next.stdout);
    assert.deepEqual(Object.keys(index(made)), [result.key]);
    assert.ok(existsSync(result.path));
    // The dead owner's lock file is gone; only its staging directory remains.
    assert.deepEqual(readdirSync(join(made.cacheDir, "locks", "appliance-build-" + result.key)), []);
    assert.equal(readdirSync(join(made.cacheDir, "appliances")).filter((name) => /partial|\.tmp$/.test(name)).length, 0);
  });
}
