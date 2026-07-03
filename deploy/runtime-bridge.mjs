import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

// Outbound-only bridge: the runtime never exposes an inbound child endpoint.
const childId = required("CRABHELM_CHILD_ID");
const controlUrl = secureOrigin(required("CRABHELM_CONTROL_URL"));
const openclaw = process.env.CRABHELM_OPENCLAW_BINARY || "openclaw";
const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(homedir(), ".openclaw");
const turnFile = path.join(stateDir, "crabhelm-current-turn.json");
const runtimeLockFile = path.join(stateDir, "crabhelm-runtime-bridge.lock");
const runtimeTokenFile = requiredPath("CRABHELM_RUNTIME_TOKEN_FILE");
if (!acquireRuntimeLock(runtimeLockFile)) process.exit(0);
let runtimeToken = runtimeCredential();
let socket;
let working = false;
let claiming = false;
let pendingCompletion;
let incomingTurn;
let preparingJobId;
let stopped = false;
let reconnectDelay = 1000;
let resetGeneration;
let activeRunCancel;
let refreshPending = false;
let refreshRetry;

metadataInfo("runtime_bridge_started", { transport: "websocket" });

process.on("SIGTERM", () => { stopped = true; activeRunCancel?.("runtime bridge stopped"); socket?.close(1000, "shutdown"); });
process.on("SIGINT", () => { stopped = true; activeRunCancel?.("runtime bridge stopped"); socket?.close(1000, "shutdown"); });

setInterval(() => {
  requestRefresh();
}, 5 * 60 * 1000).unref();
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "runtime.heartbeat" }));
}, 45_000).unref();
setInterval(() => {
  if (pendingCompletion && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(pendingCompletion));
}, 10_000).unref();

try {
  while (!stopped) {
    try {
      await connect();
      reconnectDelay = 1000;
    } catch (error) {
      metadataLog("runtime_bridge_connection_failed", error);
    }
    if (!stopped) {
      await delay(reconnectDelay + Math.floor(Math.random() * 500));
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    }
  }
} finally {
  releaseRuntimeLock(runtimeLockFile);
}

async function connect() {
  const url = new URL("/api/runtime/connect", controlUrl);
  url.searchParams.set("clawId", childId);
  const ticket = await connectionTicket();
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ["crabhelm.runtime.v1", `crabhelm.ticket.${ticket}`]);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      metadataInfo("runtime_socket_opened");
      claiming = false;
      if (refreshPending) requestRefresh();
      else if (pendingCompletion) ws.send(JSON.stringify(pendingCompletion));
      else requestJob(ws);
    });
    ws.addEventListener("message", (event) => {
      void messageText(event.data).then((raw) => onMessage(ws, raw)).catch((error) => {
        metadataLog("runtime_bridge_message_failed", error);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "runtime.client_error", error: error instanceof Error ? error.message.slice(0, 500) : "runtime message failed" }));
      });
    });
    ws.addEventListener("error", () => { if (!opened) reject(new Error("runtime websocket failed before opening")); });
    ws.addEventListener("close", () => {
      socket = undefined;
      claiming = false;
      if (!working) {
        preparingJobId = undefined;
        incomingTurn = undefined;
      }
      resolve();
    });
  });
}

async function connectionTicket() {
  const response = await fetch(new URL("/api/runtime/ticket", controlUrl), {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${runtimeToken}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`runtime ticket request failed (${response.status})`);
  const value = await response.json();
  if (typeof value?.ticket !== "string" || value.ticket.length > 4096) throw new Error("runtime ticket response is invalid");
  return value.ticket;
}

async function onMessage(ws, raw) {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("runtime message exceeds 64 KiB");
  const message = JSON.parse(raw);
  if (message.type === "runtime.ready" || message.type === "runtime.heartbeat") {
    applyResetGeneration(message.resetGeneration);
    return;
  }
  if (message.type === "runtime.token") {
    if (typeof message.token !== "string" || message.token.length > 4096) throw new Error("runtime refresh returned an invalid token");
    runtimeToken = message.token;
    await writeAtomic(runtimeTokenFile, `${message.token}\n`);
    refreshPending = false;
    clearTimeout(refreshRetry);
    metadataInfo("runtime_token_refreshed");
    if (pendingCompletion) ws.send(JSON.stringify(pendingCompletion));
    else requestJob(ws);
    return;
  }
  if (message.type === "job.available") {
    requestJob(ws);
    return;
  }
  if (message.type === "job.none" || message.type === "job.retry") {
    if (preparingJobId) return;
    claiming = false;
    setTimeout(() => requestJob(socket), 2_000).unref();
    return;
  }
  if (message.type === "job.started.ack") return;
  if (message.type === "job.preparing") {
    if (typeof message.id !== "string" || !message.id) throw new Error("runtime preparing frame is invalid");
    preparingJobId = message.id;
    claiming = true;
    return;
  }
  if (message.type === "job.ack") {
    if (pendingCompletion?.id === message.id) {
      metadataInfo("runtime_completion_acknowledged", { jobId: message.id });
      pendingCompletion = undefined;
      working = false;
      requestJob(ws);
    }
    return;
  }
  if (message.type === "job.turn.start") {
    if (typeof message.id !== "string" || !Number.isSafeInteger(message.chunks) || message.chunks < 1 || message.chunks > 160) throw new Error("runtime turn frame header is invalid");
    if (preparingJobId && message.id !== preparingJobId) throw new Error("runtime turn frame identity changed");
    incomingTurn = { id: message.id, expected: message.chunks, chunks: [] };
    return;
  }
  if (message.type === "job.turn.chunk") {
    if (!incomingTurn || message.id !== incomingTurn.id || message.index !== incomingTurn.chunks.length || typeof message.data !== "string" || message.data.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(message.data)) throw new Error("runtime turn frame is invalid");
    incomingTurn.chunks.push(message.data);
    return;
  }
  if (message.type === "job.turn.ready") {
    if (!incomingTurn || message.id !== incomingTurn.id || incomingTurn.chunks.length !== incomingTurn.expected) throw new Error("runtime turn frame sequence is incomplete");
    const encoded = incomingTurn.chunks.join("");
    incomingTurn = undefined;
    preparingJobId = undefined;
    if (encoded.length > 80 * 1024) throw new Error("runtime turn frame sequence is too large");
    const job = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    await handleTurn(ws, job);
    return;
  }
  if (message.type === "job.turn") {
    throw new Error("unchunked runtime turn is unsupported");
  }
  if (message.type === "runtime.error") {
    claiming = false;
    metadataLog("runtime_server_rejected_message", new Error(typeof message.error === "string" ? message.error : "runtime server error"));
    return;
  }
}

async function handleTurn(ws, message) {
    claiming = false;
    if (working) throw new Error("runtime received a concurrent job");
    working = true;
    ws.send(JSON.stringify({ type: "job.started", id: message.id }));
    metadataInfo("runtime_turn_received", { jobId: String(message.id || "unknown") });
    pendingCompletion = await runTurn(message);
    metadataInfo("runtime_completion_prepared", { jobId: pendingCompletion.id, ok: pendingCompletion.ok });
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(pendingCompletion));
}

function requestJob(ws) {
  if (stopped || working || claiming || ws?.readyState !== WebSocket.OPEN) return;
  claiming = true;
  ws.send(JSON.stringify({ type: "job.claim" }));
}

function requestRefresh() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  refreshPending = true;
  socket.send(JSON.stringify({ type: "runtime.refresh" }));
  clearTimeout(refreshRetry);
  refreshRetry = setTimeout(requestRefresh, 15_000);
  refreshRetry.unref();
}

function applyResetGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) return;
  if (resetGeneration !== undefined && value !== resetGeneration) activeRunCancel?.("runtime reset by administrator");
  resetGeneration = value;
}

async function messageText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data.text === "function") return data.text();
  throw new Error("runtime message payload is unsupported");
}

async function runTurn(job) {
  if (!job.id || !job.turnToken || !job.sessionId || typeof job.prompt !== "string" || Buffer.byteLength(job.prompt, "utf8") > 48 * 1024) {
    return { type: "job.complete", id: String(job.id || "invalid"), ok: false, error: "invalid runtime job" };
  }
  await writeAtomic(turnFile, `${JSON.stringify({ jobId: job.id, turnToken: job.turnToken })}\n`);
  try {
    const result = await run(openclaw, [
      "agent", "--agent", "main", "--session-id", job.sessionId,
      "--message", job.prompt, "--thinking", "off", "--timeout", "840", "--json",
    // A governed write can wait up to nine minutes for requester approval.
    ], 15 * 60 * 1000, hasAgentOutput);
    const output = extractAgentText(result.stdout);
    return { type: "job.complete", id: job.id, ok: true, output };
  } catch (error) {
    metadataLog("runtime_turn_failed", error, { jobId: job.id });
    return { type: "job.complete", id: job.id, ok: false, error: error instanceof Error ? error.message.slice(0, 500) : "agent turn failed" };
  } finally {
    await rm(turnFile, { force: true });
  }
}

async function run(command, args, timeoutMs, stdoutReady) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: process.platform !== "win32", env: agentEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    let stdoutSize = 0, stderrSize = 0, settled = false, failure;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeRunCancel === cancel) activeRunCancel = undefined;
      child.stdout.destroy();
      child.stderr.destroy();
      callback();
    };
    const cancel = (reason) => {
      if (failure) return;
      failure = new Error(reason);
      terminateChild(child, "SIGTERM");
      setTimeout(() => terminateChild(child, "SIGKILL"), 10_000).unref();
    };
    activeRunCancel = cancel;
    const timer = setTimeout(() => cancel("OpenClaw agent timed out"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > 2 * 1024 * 1024) { cancel("OpenClaw agent output is too large"); return; }
      stdout.push(chunk);
      const output = Buffer.concat(stdout).toString("utf8");
      if (stdoutReady?.(output)) {
        terminateChild(child, "SIGTERM");
        setTimeout(() => terminateChild(child, "SIGKILL"), 1_000).unref();
        settle(() => resolve({ stdout: output }));
      }
    });
    child.stderr.on("data", (chunk) => { stderrSize += chunk.length; if (stderrSize <= 64 * 1024) stderr.push(chunk); });
    child.on("error", (error) => settle(() => reject(error)));
    // OpenClaw descendants may inherit the pipes. Accept a complete JSON envelope
    // or the CLI exit; waiting for ChildProcess "close" can hang on those FDs.
    child.on("exit", (code, signal) => setTimeout(() => settle(() => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`OpenClaw agent exited ${code ?? signal ?? "unknown"}: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 300)}`));
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
    }), 100));
  });
}

function hasAgentOutput(raw) {
  try { extractAgentText(raw); return true; }
  catch { return false; }
}

function terminateChild(child, signal) {
  try {
    if (process.platform === "win32" || !child.pid) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") metadataLog("runtime_process_termination_failed", error);
  }
}

function extractAgentText(raw) {
  for (let start = raw.indexOf("{"); start >= 0; start = raw.indexOf("{", start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < raw.length; index++) {
      const char = raw[index];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === "\\") { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (char === "{") depth++;
      else if (char === "}") depth--;
      if (depth === 0) {
        try {
          const value = JSON.parse(raw.slice(start, index + 1));
          if (!Array.isArray(value.payloads)) break;
          const texts = value.payloads.map((payload) => payload?.text).filter((text) => typeof text === "string" && text.trim()).map((text) => text.trim());
          const output = texts.join("\n").trim();
          if (!output || Buffer.byteLength(output, "utf8") > 24 * 1024) throw new Error("agent output is empty or too large");
          return output;
        } catch (error) {
          if (error instanceof SyntaxError) break;
          throw error;
        }
      }
    }
  }
  throw new Error("OpenClaw agent output schema is invalid");
}

async function writeAtomic(file, value) {
  const temporary = `${file}.new-${process.pid}`;
  await writeFile(temporary, value, { mode: 0o600, flag: "w" });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function requiredPath(name) { const value = required(name); if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`); return value; }
function runtimeCredential() {
  const raw = process.env.CRABHELM_RUNTIME_TOKEN_FD?.trim();
  delete process.env.CRABHELM_RUNTIME_TOKEN_FD;
  if (!raw || !/^[0-9]{1,3}$/u.test(raw)) throw new Error("CRABHELM_RUNTIME_TOKEN_FD is required");
  const descriptor = Number(raw);
  let value;
  try { value = readFileSync(descriptor, "utf8").trim(); }
  finally { closeSync(descriptor); }
  if (!value || value.length > 4096) throw new Error("runtime credential is invalid");
  return value;
}
function acquireRuntimeLock(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const descriptor = openSync(file, "wx", 0o600);
      try { writeFileSync(descriptor, `${process.pid}\n`); }
      finally { closeSync(descriptor); }
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        const info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error("runtime lock is unsafe");
        const raw = readFileSync(file, "utf8").trim();
        if (!raw && Date.now() - info.mtimeMs < 30_000) return false;
        if (raw && !/^[0-9]+$/u.test(raw)) throw new Error("runtime lock owner is invalid");
        if (raw) owner = Number(raw);
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (owner) {
        try { process.kill(owner, 0); return false; }
        catch (killError) {
          if (killError?.code === "EPERM") return false;
          if (killError?.code !== "ESRCH") throw killError;
        }
      }
      try { unlinkSync(file); }
      catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
    }
  }
  throw new Error("runtime lock could not be acquired");
}
function releaseRuntimeLock(file) {
  try {
    if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") metadataLog("runtime_lock_release_failed", error);
  }
}
function agentEnvironment() {
  const env = { ...process.env };
  delete env.CRABHELM_RUNTIME_TOKEN;
  delete env.CRABHELM_RUNTIME_TOKEN_FD;
  delete env.CRABHELM_RUNTIME_TOKEN_FILE;
  return env;
}
function secureOrigin(value) { const url = new URL(value); if (url.protocol !== "https:") throw new Error("CRABHELM_CONTROL_URL must use HTTPS"); return url.origin; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function metadataInfo(event, extra = {}) { console.log(JSON.stringify({ event, ...extra })); }
function metadataLog(event, error, extra = {}) { console.error(JSON.stringify({ event, ...extra, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) })); }
