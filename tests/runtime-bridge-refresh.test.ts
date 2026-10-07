import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:https";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bridgeScript = path.join(repoRoot, "deploy/runtime-bridge.mjs");
const childId = "22222222-2222-4222-8222-222222222222";

type ControlServer = {
  url: string;
  posts: () => number;
  frames: () => string[];
  protocol: () => string | undefined;
  send: (message: unknown) => void;
  close: () => Promise<void>;
};

function pidAlive(pid: string): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(file: string, timeoutMs: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = readFileSync(file, "utf8").trim();
      if (value) return value;
    } catch {
      // The file has not been written yet.
    }
    await delay(25);
  }
  return "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeCertificate(directory: string): { key: Buffer; cert: Buffer } {
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "1",
    "-subj", "/CN=127.0.0.1",
  ], { stdio: "ignore" });
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

async function startControl(status: number, body: unknown): Promise<ControlServer> {
  const posts: string[] = [];
  const frames: string[] = [];
  let protocol: string | undefined;
  const certDir = mkdtempSync(path.join(tmpdir(), "crabhelm-bridge-cert-"));
  const server = createServer(writeCertificate(certDir), (request, response) => {
    const pathname = new URL(request.url ?? "/", "https://127.0.0.1").pathname;
    if (request.method !== "POST" || pathname !== "/api/runtime/ticket") {
      response.writeHead(404);
      response.end();
      request.resume();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      posts.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  const sockets = new WebSocketServer({
    server,
    handleProtocols(protocols) {
      if (!protocols.has("crabhelm.runtime.v1")) return false;
      for (const protocolName of protocols) {
        if (protocolName.startsWith("crabhelm.ticket.") && protocolName.length > "crabhelm.ticket.".length) {
          return "crabhelm.runtime.v1";
        }
      }
      return false;
    },
  });
  sockets.on("connection", (socket) => {
    protocol = socket.protocol;
    socket.on("message", (data) => frames.push(data.toString()));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("control server did not bind");
  return {
    url: `https://127.0.0.1:${address.port}`,
    posts: () => posts.length,
    frames: () => frames,
    protocol: () => protocol,
    send: (message) => {
      for (const socket of sockets.clients) socket.send(JSON.stringify(message));
    },
    close: async () => {
      await closeControl(server, sockets);
      rmSync(certDir, { recursive: true, force: true });
    },
  };
}

function closeControl(server: Server, sockets: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.closeAllConnections();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function spawnBridge(stateDir: string, tokenFile: string, controlUrl: string): { child: ChildProcess; output: () => string } {
  const tokenFd = openSync(tokenFile, "r");
  let output = "";
  const env = { ...process.env };
  delete env.CRABHELM_RUNTIME_TOKEN;
  delete env.CRABHELM_RUNTIME_TOKEN_FD;
  const child = spawn(process.execPath, [bridgeScript], {
    cwd: repoRoot,
    env: {
      ...env,
      CRABHELM_CHILD_ID: childId,
      CRABHELM_CONTROL_URL: controlUrl,
      CRABHELM_RUNTIME_TOKEN_FILE: tokenFile,
      CRABHELM_RUNTIME_TOKEN_FD: "3",
      CRABHELM_OPENCLAW_BINARY: "/usr/bin/true",
      OPENCLAW_STATE_DIR: stateDir,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stdio: ["ignore", "pipe", "pipe", tokenFd],
  });
  closeSync(tokenFd);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { output += chunk; });
  child.stderr?.on("data", (chunk: string) => { output += chunk; });
  child.on("error", (error) => { output += String(error); });
  return { child, output: () => output };
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForFrame(frames: () => string[], timeoutMs: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const first = frames()[0];
    if (first !== undefined) return first;
    await delay(25);
  }
  throw new Error("timed out waiting for a runtime frame");
}

function prepareRuntime(tokenAgeMs: number | undefined): { root: string; stateDir: string; tokenFile: string } {
  const root = mkdtempSync(path.join(tmpdir(), "crabhelm-bridge-"));
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(root, "crabhelm-runtime-token");
  writeFileSync(tokenFile, "runtime-token-value\n", { mode: 0o600 });
  if (tokenAgeMs !== undefined) {
    const when = new Date(Date.now() - tokenAgeMs);
    utimesSync(tokenFile, when, when);
  }
  return { root, stateDir, tokenFile };
}

async function withBridge(
  t: { after: (fn: () => Promise<void> | void) => void },
  status: number,
  body: unknown,
  tokenAgeMs: number | undefined,
): Promise<{ child: ChildProcess; control: ControlServer; output: () => string }> {
  const runtime = prepareRuntime(tokenAgeMs);
  const control = await startControl(status, body);
  const bridge = spawnBridge(runtime.stateDir, runtime.tokenFile, control.url);
  t.after(async () => {
    stopChild(bridge.child);
    await waitForExit(bridge.child, 1_000);
    if (bridge.child.exitCode === null && bridge.child.signalCode === null) bridge.child.kill("SIGKILL");
    await control.close();
    rmSync(runtime.root, { recursive: true, force: true });
  });
  return { child: bridge.child, control, output: bridge.output };
}

test("stops an active agent before exiting on a rejected replacement ticket", { timeout: 15_000 }, async (t) => {
  const runtime = prepareRuntime(undefined);
  const pidFile = path.join(runtime.root, "agent.pid");
  const agent = path.join(runtime.root, "agent.mjs");
  writeFileSync(agent, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.AGENT_PID_FILE, String(process.pid));
setInterval(() => {}, 1_000);
`, { mode: 0o700 });
  let posts = 0;
  const certDir = mkdtempSync(path.join(tmpdir(), "crabhelm-bridge-cert-"));
  const server = createServer(writeCertificate(certDir), (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      request.resume();
      return;
    }
    posts += 1;
    request.resume();
    request.on("end", () => {
      if (posts === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ticket: "first-ticket" }));
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "rejected" }));
    });
  });
  const sockets = new WebSocketServer({
    server,
    handleProtocols(protocols) {
      if (!protocols.has("crabhelm.runtime.v1")) return false;
      for (const protocolName of protocols) {
        if (protocolName.startsWith("crabhelm.ticket.")) return "crabhelm.runtime.v1";
      }
      return false;
    },
  });
  const job = { id: "job-1", turnToken: "turn-token", sessionId: "session-1", prompt: "stay" };
  const encoded = Buffer.from(JSON.stringify(job)).toString("base64url");
  sockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type !== "job.claim") return;
      socket.send(JSON.stringify({ type: "job.turn.start", id: job.id, chunks: 1 }));
      socket.send(JSON.stringify({ type: "job.turn.chunk", id: job.id, index: 0, data: encoded }));
      socket.send(JSON.stringify({ type: "job.turn.ready", id: job.id }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("control server did not bind");
  const bridge = spawn(process.execPath, [bridgeScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CRABHELM_CHILD_ID: childId,
      CRABHELM_CONTROL_URL: `https://127.0.0.1:${address.port}`,
      CRABHELM_RUNTIME_TOKEN_FILE: runtime.tokenFile,
      CRABHELM_RUNTIME_TOKEN_FD: "3",
      CRABHELM_OPENCLAW_BINARY: agent,
      AGENT_PID_FILE: pidFile,
      OPENCLAW_STATE_DIR: runtime.stateDir,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stdio: ["ignore", "pipe", "pipe", openSync(runtime.tokenFile, "r")],
  });
  let bridgeOutput = "";
  bridge.stdout?.setEncoding("utf8");
  bridge.stderr?.setEncoding("utf8");
  bridge.stdout?.on("data", (chunk: string) => { bridgeOutput += chunk; });
  bridge.stderr?.on("data", (chunk: string) => { bridgeOutput += chunk; });
  t.after(async () => {
    stopChild(bridge);
    await waitForExit(bridge, 1_000);
    server.closeAllConnections();
    server.close();
    sockets.close();
    rmSync(runtime.root, { recursive: true, force: true });
    rmSync(certDir, { recursive: true, force: true });
  });
  const started = Date.now();
  let agentPid = "";
  while (Date.now() - started < 5_000) {
    try {
      agentPid = readFileSync(pidFile, "utf8").trim();
      if (agentPid) break;
    } catch {
      // The agent has not written its pid yet.
    }
    await delay(25);
  }
  assert.notEqual(agentPid, "", `agent did not start; output=${bridgeOutput}`);
  for (const socket of sockets.clients) socket.close(1000, "reconnect");
  const code = await waitForExit(bridge, 5_000);
  assert.equal(code, 1);
  let alive = true;
  try {
    process.kill(Number(agentPid), 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `agent ${agentPid} still running after ticket rejection`);
});

test("kills a SIGTERM-resistant agent group before exiting on a rejected ticket", { timeout: 15_000 }, async (t) => {
  const runtime = prepareRuntime(undefined);
  const pidFile = path.join(runtime.root, "agent.pid");
  const childPidFile = path.join(runtime.root, "child.pid");
  const signalFile = path.join(runtime.root, "signal");
  const sideEffectFile = path.join(runtime.root, "side-effect");
  const agent = path.join(runtime.root, "agent.mjs");
  writeFileSync(agent, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(process.env.AGENT_SIGNAL_FILE, "term");
  setTimeout(() => writeFileSync(process.env.AGENT_SIDE_EFFECT_FILE, "late"), 2_000);
});
writeFileSync(process.env.AGENT_PID_FILE, String(process.pid));
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"], { stdio: "ignore" });
writeFileSync(process.env.AGENT_CHILD_PID_FILE, String(child.pid));
setInterval(() => {}, 1_000);
`, { mode: 0o700 });
  let posts = 0;
  const certDir = mkdtempSync(path.join(tmpdir(), "crabhelm-bridge-cert-"));
  const server = createServer(writeCertificate(certDir), (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      request.resume();
      return;
    }
    posts += 1;
    request.resume();
    request.on("end", () => {
      if (posts === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ticket: "first-ticket" }));
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "rejected" }));
    });
  });
  const sockets = new WebSocketServer({
    server,
    handleProtocols(protocols) {
      if (!protocols.has("crabhelm.runtime.v1")) return false;
      for (const protocolName of protocols) {
        if (protocolName.startsWith("crabhelm.ticket.")) return "crabhelm.runtime.v1";
      }
      return false;
    },
  });
  const job = { id: "job-1", turnToken: "turn-token", sessionId: "session-1", prompt: "stay" };
  const encoded = Buffer.from(JSON.stringify(job)).toString("base64url");
  sockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type !== "job.claim") return;
      socket.send(JSON.stringify({ type: "job.turn.start", id: job.id, chunks: 1 }));
      socket.send(JSON.stringify({ type: "job.turn.chunk", id: job.id, index: 0, data: encoded }));
      socket.send(JSON.stringify({ type: "job.turn.ready", id: job.id }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("control server did not bind");
  const bridge = spawn(process.execPath, [bridgeScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CRABHELM_CHILD_ID: childId,
      CRABHELM_CONTROL_URL: `https://127.0.0.1:${address.port}`,
      CRABHELM_RUNTIME_TOKEN_FILE: runtime.tokenFile,
      CRABHELM_RUNTIME_TOKEN_FD: "3",
      CRABHELM_OPENCLAW_BINARY: agent,
      AGENT_PID_FILE: pidFile,
      AGENT_CHILD_PID_FILE: childPidFile,
      AGENT_SIGNAL_FILE: signalFile,
      AGENT_SIDE_EFFECT_FILE: sideEffectFile,
      OPENCLAW_STATE_DIR: runtime.stateDir,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stdio: ["ignore", "pipe", "pipe", openSync(runtime.tokenFile, "r")],
  });
  let bridgeOutput = "";
  bridge.stdout?.setEncoding("utf8");
  bridge.stderr?.setEncoding("utf8");
  bridge.stdout?.on("data", (chunk: string) => { bridgeOutput += chunk; });
  bridge.stderr?.on("data", (chunk: string) => { bridgeOutput += chunk; });
  t.after(async () => {
    stopChild(bridge);
    await waitForExit(bridge, 1_000);
    server.closeAllConnections();
    server.close();
    sockets.close();
    rmSync(runtime.root, { recursive: true, force: true });
    rmSync(certDir, { recursive: true, force: true });
  });
  const agentPid = await waitForFile(pidFile, 5_000);
  const childPid = await waitForFile(childPidFile, 5_000);
  assert.notEqual(agentPid, "", `agent did not start; output=${bridgeOutput}`);
  assert.notEqual(childPid, "", `child did not start; output=${bridgeOutput}`);
  for (const socket of sockets.clients) socket.close(1000, "reconnect");
  const signal = await waitForFile(signalFile, 5_000);
  assert.equal(signal, "term");
  assert.equal(pidAlive(agentPid), true, "agent died on SIGTERM");
  assert.equal(pidAlive(childPid), true, "descendant died on SIGTERM");
  const code = await waitForExit(bridge, 5_000);
  assert.equal(code, 1, `bridge exit ${code}; output=${bridgeOutput}`);
  const goneAt = Date.now();
  while (Date.now() - goneAt < 1_000 && (pidAlive(agentPid) || pidAlive(childPid))) await delay(25);
  assert.equal(pidAlive(agentPid), false, `agent ${agentPid} still running`);
  assert.equal(pidAlive(childPid), false, `descendant ${childPid} still running`);
  await delay(2_500);
  assert.equal(existsSync(sideEffectFile), false, "agent wrote a file after the bridge exited");
});

async function launchJobBridge(
  t: { after: (fn: () => Promise<void> | void) => void },
  agentSource: string,
  options?: { holdSecondTicket?: boolean; replaceJob?: boolean },
): Promise<{
  bridge: ChildProcess;
  sockets: WebSocketServer;
  output: () => string;
  pidFile: string;
  childPidFile: string;
  signalFile: string;
  sideEffectFile: string;
  childReadyFile: string;
  secondPidFile: string;
  releaseSecondTicket: () => void;
}> {
  const runtime = prepareRuntime(undefined);
  const pidFile = path.join(runtime.root, "agent.pid");
  const childPidFile = path.join(runtime.root, "child.pid");
  const signalFile = path.join(runtime.root, "signal");
  const sideEffectFile = path.join(runtime.root, "side-effect");
  const childReadyFile = path.join(runtime.root, "child-ready");
  const secondPidFile = path.join(runtime.root, "second.pid");
  const agent = path.join(runtime.root, "agent.mjs");
  writeFileSync(agent, agentSource, { mode: 0o700 });
  let posts = 0;
  let secondTicketReady = options?.holdSecondTicket !== true;
  let sendSecondTicket = () => {};
  const certDir = mkdtempSync(path.join(tmpdir(), "crabhelm-bridge-cert-"));
  const server = createServer(writeCertificate(certDir), (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      request.resume();
      return;
    }
    posts += 1;
    request.resume();
    request.on("end", () => {
      if (posts === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ticket: "first-ticket" }));
        return;
      }
      const rejectTicket = () => {
        if (response.writableEnded) return;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "rejected" }));
      };
      if (secondTicketReady) {
        rejectTicket();
        return;
      }
      sendSecondTicket = rejectTicket;
    });
  });
  const sockets = new WebSocketServer({
    server,
    handleProtocols(protocols) {
      if (!protocols.has("crabhelm.runtime.v1")) return false;
      for (const protocolName of protocols) {
        if (protocolName.startsWith("crabhelm.ticket.")) return "crabhelm.runtime.v1";
      }
      return false;
    },
  });
  let claims = 0;
  sockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: string; id?: string };
      if (message.type === "job.complete" && options?.replaceJob) {
        socket.send(JSON.stringify({ type: "job.ack", id: message.id }));
        return;
      }
      if (message.type !== "job.claim") return;
      const job = claims === 0 || !options?.replaceJob
        ? { id: "job-1", turnToken: "turn-token", sessionId: "session-1", prompt: "stay" }
        : { id: "job-2", turnToken: "turn-token-2", sessionId: "session-2", prompt: "next" };
      claims += 1;
      const encoded = Buffer.from(JSON.stringify(job)).toString("base64url");
      socket.send(JSON.stringify({ type: "runtime.ready", resetGeneration: 1 }));
      socket.send(JSON.stringify({ type: "job.turn.start", id: job.id, chunks: 1 }));
      socket.send(JSON.stringify({ type: "job.turn.chunk", id: job.id, index: 0, data: encoded }));
      socket.send(JSON.stringify({ type: "job.turn.ready", id: job.id }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("control server did not bind");
  const bridge = spawn(process.execPath, [bridgeScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CRABHELM_CHILD_ID: childId,
      CRABHELM_CONTROL_URL: `https://127.0.0.1:${address.port}`,
      CRABHELM_RUNTIME_TOKEN_FILE: runtime.tokenFile,
      CRABHELM_RUNTIME_TOKEN_FD: "3",
      CRABHELM_OPENCLAW_BINARY: agent,
      AGENT_PID_FILE: pidFile,
      AGENT_CHILD_PID_FILE: childPidFile,
      AGENT_SIGNAL_FILE: signalFile,
      AGENT_SIDE_EFFECT_FILE: sideEffectFile,
      AGENT_CHILD_READY_FILE: childReadyFile,
      AGENT_GENERATION_FILE: path.join(runtime.root, "generation"),
      AGENT_SECOND_PID_FILE: secondPidFile,
      OPENCLAW_STATE_DIR: runtime.stateDir,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stdio: ["ignore", "pipe", "pipe", openSync(runtime.tokenFile, "r")],
  });
  let bridgeOutput = "";
  bridge.stdout?.setEncoding("utf8");
  bridge.stderr?.setEncoding("utf8");
  bridge.stdout?.on("data", (chunk: string) => { bridgeOutput += chunk; });
  bridge.stderr?.on("data", (chunk: string) => { bridgeOutput += chunk; });
  t.after(async () => {
    stopChild(bridge);
    await waitForExit(bridge, 1_000);
    server.closeAllConnections();
    server.close();
    sockets.close();
    rmSync(runtime.root, { recursive: true, force: true });
    rmSync(certDir, { recursive: true, force: true });
  });
  return {
    bridge,
    sockets,
    output: () => bridgeOutput,
    pidFile,
    childPidFile,
    signalFile,
    sideEffectFile,
    childReadyFile,
    secondPidFile,
    releaseSecondTicket: () => {
      secondTicketReady = true;
      sendSecondTicket();
    },
  };
}

const resistantAgent = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(process.env.AGENT_SIGNAL_FILE, "term");
  setTimeout(() => writeFileSync(process.env.AGENT_SIDE_EFFECT_FILE, "late"), 20_000);
});
writeFileSync(process.env.AGENT_PID_FILE, String(process.pid));
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"], { stdio: "ignore" });
writeFileSync(process.env.AGENT_CHILD_PID_FILE, String(child.pid));
setInterval(() => {}, 1_000);
`;

const leaderExitsAgent = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(process.env.AGENT_SIGNAL_FILE, "term");
  process.exit(0);
});
writeFileSync(process.env.AGENT_PID_FILE, String(process.pid));
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.on('SIGHUP',()=>{}); require('node:fs').writeFileSync(process.env.AGENT_CHILD_READY_FILE, 'ready'); setTimeout(() => { require('node:fs').writeFileSync(process.env.AGENT_SIDE_EFFECT_FILE, 'late'); }, 20000); setInterval(()=>{}, 1000);"], {
  stdio: "ignore",
  env: process.env,
});
writeFileSync(process.env.AGENT_CHILD_PID_FILE, String(child.pid));
setInterval(() => {}, 1_000);
`;

function sendRuntimeReady(sockets: WebSocketServer, resetGeneration: number): void {
  for (const socket of sockets.clients) {
    socket.send(JSON.stringify({ type: "runtime.ready", resetGeneration }));
  }
}

test("a rejected ticket waits for a stop that is already running", { timeout: 25_000 }, async (t) => {
  const harness = await launchJobBridge(t, resistantAgent);
  const agentPid = await waitForFile(harness.pidFile, 5_000);
  const childPid = await waitForFile(harness.childPidFile, 5_000);
  assert.notEqual(agentPid, "", harness.output());
  assert.notEqual(childPid, "", harness.output());
  sendRuntimeReady(harness.sockets, 2);
  const signaledAt = Date.now();
  assert.equal(await waitForFile(harness.signalFile, 5_000), "term");
  for (const socket of harness.sockets.clients) socket.close(1000, "reconnect");
  const code = await waitForExit(harness.bridge, 20_000);
  const elapsed = Date.now() - signaledAt;
  assert.equal(code, 1, harness.output());
  assert.equal(elapsed >= 8_000, true, `bridge exited after ${elapsed}ms`);
  assert.equal(pidAlive(agentPid), false, `agent ${agentPid} still running`);
  assert.equal(pidAlive(childPid), false, `descendant ${childPid} still running`);
  assert.equal(existsSync(harness.sideEffectFile), false);
});

test("a rejected ticket still kills descendants after the leader exits", { timeout: 25_000 }, async (t) => {
  const harness = await launchJobBridge(t, leaderExitsAgent);
  const agentPid = await waitForFile(harness.pidFile, 5_000);
  const childPid = await waitForFile(harness.childPidFile, 5_000);
  assert.notEqual(agentPid, "", harness.output());
  assert.notEqual(childPid, "", harness.output());
  assert.equal(await waitForFile(harness.childReadyFile, 5_000), "ready", harness.output());
  sendRuntimeReady(harness.sockets, 2);
  const signaledAt = Date.now();
  assert.equal(await waitForFile(harness.signalFile, 5_000), "term", harness.output());
  const leaderGone = Date.now();
  while (Date.now() - leaderGone < 1_000 && pidAlive(agentPid)) await delay(25);
  assert.equal(pidAlive(agentPid), false, `leader stayed up after SIGTERM; output=${harness.output()}`);
  await delay(400);
  assert.equal(pidAlive(childPid), true, `descendant died with the leader; output=${harness.output()}`);
  for (const socket of harness.sockets.clients) socket.close(1000, "reconnect");
  const code = await waitForExit(harness.bridge, 20_000);
  const elapsed = Date.now() - signaledAt;
  assert.equal(code, 1, harness.output());
  assert.equal(elapsed >= 8_000, true, `bridge exited after ${elapsed}ms`);
  const goneAt = Date.now();
  while (Date.now() - goneAt < 1_000 && pidAlive(childPid)) await delay(25);
  assert.equal(pidAlive(childPid), false, `descendant ${childPid} still running`);
  assert.equal(existsSync(harness.sideEffectFile), false);
});

const finishedAnswerAgent = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(process.env.AGENT_SIGNAL_FILE, "term");
});
setTimeout(() => {
  process.stdout.write(JSON.stringify({ payloads: [{ text: "done" }] }) + "\\n");
}, 300);
writeFileSync(process.env.AGENT_PID_FILE, String(process.pid));
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.on('SIGHUP',()=>{}); require('node:fs').writeFileSync(process.env.AGENT_CHILD_READY_FILE, 'ready'); setTimeout(() => { require('node:fs').writeFileSync(process.env.AGENT_SIDE_EFFECT_FILE, 'late'); }, 8000); setInterval(()=>{}, 1000);"], {
  stdio: "ignore",
  env: process.env,
});
writeFileSync(process.env.AGENT_CHILD_PID_FILE, String(child.pid));
setInterval(() => {}, 1_000);
`;

const overlapAgent = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const first = !existsSync(process.env.AGENT_GENERATION_FILE);
writeFileSync(process.env.AGENT_GENERATION_FILE, first ? "1" : "2");
if (first) {
  process.on("SIGTERM", () => {
    writeFileSync(process.env.AGENT_SIGNAL_FILE, "term");
  });
  writeFileSync(process.env.AGENT_PID_FILE, String(process.pid));
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.on('SIGHUP',()=>{}); require('node:fs').writeFileSync(process.env.AGENT_CHILD_READY_FILE, 'ready'); setTimeout(() => { require('node:fs').writeFileSync(process.env.AGENT_SIDE_EFFECT_FILE, 'late'); }, 8000); setInterval(()=>{}, 1000);"], {
    stdio: "ignore",
    env: process.env,
  });
  writeFileSync(process.env.AGENT_CHILD_PID_FILE, String(child.pid));
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ payloads: [{ text: "done" }] }) + "\\n");
  }, 200);
} else {
  process.on("SIGTERM", () => process.exit(0));
  writeFileSync(process.env.AGENT_SECOND_PID_FILE, String(process.pid));
}
setInterval(() => {}, 1_000);
`;

test("a rejected ticket waits for an older group after a newer job starts", { timeout: 20_000 }, async (t) => {
  const harness = await launchJobBridge(t, overlapAgent, { holdSecondTicket: true, replaceJob: true });
  const childPid = await waitForFile(harness.childPidFile, 5_000);
  assert.equal(await waitForFile(harness.childReadyFile, 5_000), "ready", harness.output());
  assert.equal(await waitForFile(harness.signalFile, 5_000), "term", harness.output());
  const secondPid = await waitForFile(harness.secondPidFile, 5_000);
  assert.equal(pidAlive(childPid), true, "older descendant died before the newer job");
  assert.equal(pidAlive(secondPid), true, "newer job was not running");
  for (const socket of harness.sockets.clients) socket.close(1000, "reconnect");
  const started = Date.now();
  harness.releaseSecondTicket();
  const code = await waitForExit(harness.bridge, 15_000);
  const elapsed = Date.now() - started;
  assert.equal(code, 1, harness.output());
  const goneAt = Date.now();
  while (Date.now() - goneAt < 1_000 && (pidAlive(childPid) || pidAlive(secondPid))) await delay(25);
  assert.equal(pidAlive(childPid), false, `older descendant ${childPid} still running`);
  assert.equal(pidAlive(secondPid), false, `newer job ${secondPid} still running`);
  assert.equal(existsSync(harness.sideEffectFile), false);
  console.log(JSON.stringify({
    event: "rejected_ticket_older_group",
    elapsedMs: elapsed,
    olderChildDead: !pidAlive(childPid),
    newerJobDead: !pidAlive(secondPid),
    sideEffect: false,
  }));
});

test("a rejected ticket waits for cleanup after a finished answer", { timeout: 20_000 }, async (t) => {
  const harness = await launchJobBridge(t, finishedAnswerAgent, { holdSecondTicket: true });
  const childPid = await waitForFile(harness.childPidFile, 5_000);
  assert.equal(await waitForFile(harness.childReadyFile, 5_000), "ready", harness.output());
  for (const socket of harness.sockets.clients) socket.close(1000, "reconnect");
  const signaledAt = Date.now();
  assert.equal(await waitForFile(harness.signalFile, 5_000), "term", harness.output());
  assert.equal(pidAlive(childPid), true, "descendant died before the rejected ticket");
  harness.releaseSecondTicket();
  const code = await waitForExit(harness.bridge, 15_000);
  const elapsed = Date.now() - signaledAt;
  assert.equal(code, 1, harness.output());
  assert.equal(elapsed >= 700, true, `bridge exited after ${elapsed}ms`);
  const goneAt = Date.now();
  while (Date.now() - goneAt < 1_000 && pidAlive(childPid)) await delay(25);
  assert.equal(pidAlive(childPid), false, `descendant ${childPid} still running`);
  assert.equal(existsSync(harness.sideEffectFile), false);
});

test("exits when the runtime ticket is rejected with 401", { timeout: 15_000 }, async (t) => {
  const { child, control, output } = await withBridge(t, 401, { error: "rejected" }, undefined);
  const code = await waitForExit(child, 5_000);
  assert.equal(code, 1, `bridge still running or exited ${code}; posts=${control.posts()}; output=${output()}`);
  assert.equal(control.posts(), 1, `ticket posts=${control.posts()}; output=${output()}`);
});

test("exits when the runtime ticket is rejected with 403", { timeout: 15_000 }, async (t) => {
  const { child, control, output } = await withBridge(t, 403, { error: "forbidden" }, undefined);
  const code = await waitForExit(child, 5_000);
  assert.equal(code, 1, `bridge still running or exited ${code}; posts=${control.posts()}; output=${output()}`);
  assert.equal(control.posts(), 1, `ticket posts=${control.posts()}; output=${output()}`);
});

test("sends runtime.refresh first when the token file is at least five minutes old", { timeout: 15_000 }, async (t) => {
  const { control, output } = await withBridge(t, 200, { ticket: "ok-ticket" }, 10 * 60 * 1000);
  let frame: string;
  try {
    frame = await waitForFrame(control.frames, 5_000);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; posts=${control.posts()}; protocol=${control.protocol() ?? ""}; output=${output()}`);
  }
  assert.equal(control.protocol(), "crabhelm.runtime.v1", output());
  assert.equal(frame, JSON.stringify({ type: "runtime.refresh" }), output());
  assert.equal(control.posts(), 1, output());
});

test("claims a job when the token file is fresh", { timeout: 15_000 }, async (t) => {
  const { control, output } = await withBridge(t, 200, { ticket: "ok-ticket" }, 0);
  let frame: string;
  try {
    frame = await waitForFrame(control.frames, 5_000);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; posts=${control.posts()}; protocol=${control.protocol() ?? ""}; output=${output()}`);
  }
  assert.equal(control.protocol(), "crabhelm.runtime.v1", output());
  assert.equal(frame, JSON.stringify({ type: "job.claim" }), output());
  assert.equal(control.posts(), 1, output());
});

test("job availability waits for an outstanding credential refresh", { timeout: 15_000 }, async (t) => {
  const { control, output } = await withBridge(t, 200, { ticket: "ok-ticket" }, 6 * 60 * 1000);
  assert.equal(await waitForFrame(control.frames, 5_000), JSON.stringify({ type: "runtime.refresh" }), output());
  control.send({ type: "job.available" });
  await delay(100);
  assert.equal(control.frames().some((frame) => JSON.parse(frame).type === "job.claim"), false, output());
  control.send({ type: "runtime.token", token: "renewed-test-token" });
  const started = Date.now();
  while (!control.frames().some((frame) => JSON.parse(frame).type === "job.claim") && Date.now() - started < 5_000) await delay(25);
  assert.equal(control.frames().filter((frame) => JSON.parse(frame).type === "job.claim").length, 1, output());
});

test("delayed shutdown timers still kill a resistant agent group", { timeout: 20_000, skip: process.platform === "win32" }, async (t) => {
  const harness = await launchJobBridge(t, resistantAgent);
  const agentPid = await waitForFile(harness.pidFile, 5_000);
  const childPid = await waitForFile(harness.childPidFile, 5_000);
  assert.notEqual(agentPid, "", harness.output());
  assert.notEqual(childPid, "", harness.output());
  t.after(() => {
    harness.bridge.kill("SIGCONT");
    try { process.kill(-Number(agentPid), "SIGKILL"); } catch {}
  });
  for (const socket of harness.sockets.clients) socket.close(1000, "reconnect");
  assert.equal(await waitForFile(harness.signalFile, 5_000), "term", harness.output());
  harness.bridge.kill("SIGSTOP");
  await delay(3_500);
  harness.bridge.kill("SIGCONT");
  assert.equal(await waitForExit(harness.bridge, 5_000), 1, harness.output());
  const started = Date.now();
  while ((pidAlive(agentPid) || pidAlive(childPid)) && Date.now() - started < 1_000) await delay(25);
  assert.equal(pidAlive(agentPid), false, "agent survived delayed shutdown timers");
  assert.equal(pidAlive(childPid), false, "descendant survived delayed shutdown timers");
});
