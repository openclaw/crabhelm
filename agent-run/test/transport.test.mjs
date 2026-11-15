import assert from "node:assert/strict";
import { test } from "node:test";
import { withServeProxy } from "../lib/crabbox.mjs";
import { quote, splitWords } from "../lib/shell.mjs";
import { run } from "../lib/proc.mjs";
import { loadConfig } from "../lib/config.mjs";

test("direct serve transport preserves pinned donor and lease authentication", () => {
  const donor = [
    "ssh", "-o", "HostKeyAlias=pinned-donor", "-o", "ProxyCommand=crabbox __serve-relay-proxy --lease cbx_1",
    "-i", "/private/lease key", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=/private/pins",
    "-p", "2222", "-W", "cbx_1:22", "crabbox@10.0.0.1",
  ];
  const original = [
    "ssh", "-i", "/private/lease key", "-o", "HostKeyAlias=cbx_1", "-o", "StrictHostKeyChecking=yes",
    "-o", "ProxyCommand=" + donor.map(quote).join(" "), "crabbox@cbx_1",
  ];
  const override = "ssh -o BatchMode=yes -W 10.0.0.1:2222 approved-donor";
  const mapped = withServeProxy(original, override);
  assert.deepEqual(mapped.slice(0, -2), original.slice(0, -2));
  assert.equal(mapped.at(-1), original.at(-1));
  const decoded = splitWords(mapped.at(-2).slice("ProxyCommand=".length));
  const expected = [...donor];
  expected[4] = "ProxyCommand=" + override;
  assert.deepEqual(decoded, expected);
  assert.ok(original.at(-2).includes("__serve-relay-proxy"));
  assert.throws(() => withServeProxy(["ssh", "host"], override), /no relay hop/);
  assert.throws(() => withServeProxy(["ssh", "-o", "ProxyCommand=nc host 22", "host"], override), /no recognized broker relay/);
});

test("command timeout kills descendants holding output pipes and reports exit 124", {
  skip: process.platform === "win32", timeout: 10000,
}, async () => {
  const descendant = 'process.stdout.write("descendant-ready\\n"); setInterval(()=>{},1000)';
  const parent = "require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(descendant) + "],{stdio:'inherit'})";
  const result = await run(process.execPath, ["-e", parent], { timeoutMs: 3000 });
  assert.match(result.stdout, /descendant-ready/);
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
});

test("configuration rejects invalid timeouts before run setup", () => {
  for (const value of ["0", "-1", "NaN", "1.5"]) {
    assert.throws(() => loadConfig({ AGENT_RUN_COMMAND_TIMEOUT_MS: value }), /positive integer/);
  }
  assert.equal(loadConfig({ AGENT_RUN_COMMAND_TIMEOUT_MS: "1234" }).commandTimeoutMs, 1234);
});

test("invalid command timeouts fail before spawning", () => {
  for (const timeoutMs of [0, -1, NaN, 1.5]) {
    assert.throws(() => run("must-not-spawn", [], { timeoutMs }), /positive integer/);
  }
});
