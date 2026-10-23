import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { inferenceProbeCommand } from "../worker/bootstrap.js";

const run = promisify(execFile);
const oldNodeId = "d".repeat(64);
const newNodeId = "e".repeat(64);
const policy = "c".repeat(64);

test("inference uses each selected appliance runtime after model, policy and credential changes", async (t) => {
  const fixture = await appliance(t);
  for (const [version, nodeId] of [["22.23.1", oldNodeId], ["22.23.4", newNodeId]] as const) {
    const node = await fixture.install(version, nodeId);
    for (const [model, credentials, policyHash] of [
      ["openai/gpt-5.5", 1, policy],
      ["openai/gpt-5.6", 1, policy],
      ["openai/gpt-5.6", 1, "b".repeat(64)],
      ["openai/gpt-5.6", 2, "b".repeat(64)],
    ] as const) {
      await writeFile(fixture.calls, "");
      const observed = await fixture.probe(nodeId, model, credentials, policyHash);
      assert.match(observed.stdout, /^SELECTED_RUNTIME_READY$/mu);
      const calls = (await readFile(fixture.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(calls.some((call) => call.args[0] === "agent"));
      assert.ok(calls.every((call) => call.node === node), "OpenClaw and restart must use the selected runtime");
    }
  }
});

test("cached inference rejects missing, mismatched or malformed runtime locators", async (t) => {
  const fixture = await appliance(t);
  const node = await fixture.install("22.23.1", oldNodeId);
  const locator = await readFile(fixture.launcher, "utf8");
  const sentinel = path.join(fixture.home, "injected");
  const marker = `v5:${fixture.release(oldNodeId)}:p${policy}:openai/gpt-5.5\n`;
  const otherNode = path.join(fixture.home, ".local/share/crabhelm", `node-v22.23.4-${newNodeId}-linux-x64/bin/node`);
  await mkdir(path.dirname(otherNode), { recursive: true });
  await writeFile(otherNode, "#!/bin/sh\nexit 99\n", { mode: 0o700 });

  for (const scenario of ["missing", "wrong-digest", "duplicate", "injection", "launcher-symlink", "node-symlink"] as const) {
    await t.test(scenario, async () => {
      await writeFile(fixture.marker, marker, { mode: 0o600 });
      await writeFile(fixture.calls, "");
      if (scenario === "missing") await unlink(node);
      if (scenario === "wrong-digest") {
        await unlink(fixture.launcher);
        await writeFile(fixture.launcher, locator.replaceAll(oldNodeId, newNodeId), { mode: 0o500 });
      }
      if (scenario === "duplicate") {
        const assignment = locator.split("\n").find((line) => line.startsWith("node_binary="));
        assert.ok(assignment);
        await unlink(fixture.launcher);
        await writeFile(fixture.launcher, `${locator}${assignment}`, { mode: 0o500 });
      }
      if (scenario === "injection") {
        await unlink(fixture.launcher);
        await writeFile(fixture.launcher, locator.replace(/^node_binary=.*$/mu, `node_binary=$(touch ${quote(sentinel)})`), { mode: 0o500 });
      }
      if (scenario === "launcher-symlink") {
        const target = `${fixture.launcher}.target`;
        await writeFile(target, locator, { mode: 0o500 });
        await unlink(fixture.launcher);
        await symlink(target, fixture.launcher);
      }
      if (scenario === "node-symlink") {
        await unlink(node);
        await symlink(otherNode, node);
      }
      const observed = await fixture.probe(oldNodeId);
      assert.match(observed.stdout, /^SELECTED_RUNTIME_RUNTIME_FAILED$/mu);
      assert.match(observed.stderr, /reinstall the selected appliance/u);
      assert.equal(await readFile(fixture.calls, "utf8"), "");
      await assert.rejects(readFile(sentinel), /ENOENT/u);
      await rm(fixture.launcher);
      await rm(node, { force: true });
      await fixture.install("22.23.1", oldNodeId);
    });
  }
});

async function appliance(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "crabhelm-selected-runtime-"));
  const home = path.join(root, "home with 'quotes'");
  const state = path.join(home, ".openclaw");
  const bin = path.join(root, "bin");
  const calls = path.join(root, "calls.jsonl");
  const bridge = path.join(root, "runtime-bridge.mjs");
  const openclaw = path.join(home, ".local/share/crabhelm/openclaw-2026.7.1/bin/openclaw");
  const launcher = path.join(home, ".local/share/crabhelm/runtime/start-runtime-bridge.sh");
  const plugin = path.join(root, "plugin.tgz");
  await mkdir(state, { recursive: true });
  await mkdir(path.dirname(openclaw), { recursive: true });
  await mkdir(bin);
  await writeFile(plugin, "fixed plugin I/O fixture\n");
  await writeFile(bridge, "setInterval(() => {}, 60_000);\n");
  await writeFile(calls, "");
  await writeFile(path.join(state, "crabhelm-runtime.env"), "CRABHELM_CONTROL_URL=https://fixture.example.test\n", { mode: 0o600 });
  await writeFile(path.join(state, "crabhelm-runtime-token"), "fixture-runtime-token\n", { mode: 0o600 });
  await writeFile(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  // External CLI/model I/O is fixed. The installer, locator, generated shell,
  // runtime selection and inference response validator remain production code.
  await writeFile(openclaw, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CRABHELM_TEST_CALLS, JSON.stringify({ node: process.env.CRABHELM_TEST_NODE, args }) + "\\n");
if (args[0] === "agent") console.log('{"payloads":[{"text":"671789"}]}');
`, { mode: 0o700 });
  const digest = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
  const release = (id: string) => `${"a".repeat(64)}.${"b".repeat(64)}.${id}`;
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    CRABHELM_TEST_CALLS: calls,
  };
  t.after(async () => {
    try {
      const pid = Number((await readFile(path.join(state, "crabhelm-runtime-bridge.pid"), "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw error;
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    home, calls, launcher, release,
    marker: path.join(state, "crabhelm-inference-ready"),
    async install(version: string, nodeId: string) {
      const node = path.join(home, ".local/share/crabhelm", `node-v${version}-${nodeId}-linux-x64/bin/node`);
      await mkdir(path.dirname(node), { recursive: true });
      await writeFile(node, `#!/bin/bash\nexport CRABHELM_TEST_NODE=${quote(node)}\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
      await run("/bin/bash", [path.resolve("deploy/bootstrap-child.sh")], {
        env: {
          ...env,
          PATH: `${path.dirname(node)}:${env.PATH}`,
          CRABBOX_ADAPTER_ROOT_SESSION_ID: "11111111-1111-4111-8111-111111111111",
          CRABHELM_STANDALONE: "true",
          CRABHELM_OPENCLAW_BINARY: openclaw,
          CRABHELM_PLUGIN_TARBALL: plugin,
          CRABHELM_PLUGIN_SHA256: await digest(plugin),
          CRABHELM_SLACK_PLUGIN_TARBALL: plugin,
          CRABHELM_SLACK_PLUGIN_SHA256: await digest(plugin),
          CRABHELM_RUNTIME_BRIDGE: bridge,
          CRABHELM_RUNTIME_BRIDGE_SHA256: await digest(bridge),
          CRABHELM_RELEASE_ID: release(nodeId),
          CRABHELM_POLICY_HASH: policy,
        },
      });
      return node;
    },
    probe(nodeId: string, model = "openai/gpt-5.5", credentials = 1, policyHash = policy) {
      return run("/bin/bash", ["-c", inferenceProbeCommand(model, release(nodeId), nodeId, "SELECTED_RUNTIME", credentials, policyHash)], { env });
    },
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
