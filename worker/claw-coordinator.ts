import { DurableObject } from "cloudflare:workers";
import type { RuntimeClaims } from "../src/governance-types.js";
import { decryptTurnPayload, encryptTurnPayload } from "./turn-envelope.js";
import { slackDeliveryRetryable } from "./slack-delivery.js";
import { signClaims, verifyClaims } from "./security.js";

type GrantRegistration = { invocationId: string; jti: string; argumentsDigest: string; expiresAt: number };

export type SlackTurnSource = {
  surface: "slack";
  workspaceId: string;
  channelId: string;
  threadTs: string;
};

export type EnqueueTurnInput = {
  id: string;
  eventId: string;
  clawId: string;
  requesterId: string;
  personaId: string;
  prompt: string;
  turnToken: string;
  source: SlackTurnSource;
  expiresAt: number;
};

type TurnPayload = { prompt: string };
type RuntimeAttachment = { runtimeId: string; clawId: string; refreshJti: string; disabled?: true };
type JobRow = {
  id: string;
  event_id: string;
  claw_id: string;
  requester_id: string;
  persona_id: string;
  status: string;
  turn_token: string;
  payload_envelope: string | null;
  source_json: string;
  runtime_id: string | null;
  response_envelope: string | null;
  delivery_status: string;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  expires_at: number;
  error: string | null;
  delivery_attempts: number;
};

export class CrabhelmClawCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS grants (
          invocation_id TEXT PRIMARY KEY,
          jti TEXT UNIQUE NOT NULL,
          arguments_digest TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS runs (
          invocation_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS runtime_refreshes (
          jti TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER,
          response_envelope TEXT
        );
        CREATE TABLE IF NOT EXISTS runtime_tickets (
          jti TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS turn_jobs (
          id TEXT PRIMARY KEY,
          event_id TEXT UNIQUE NOT NULL,
          claw_id TEXT NOT NULL,
          requester_id TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          status TEXT NOT NULL,
          turn_token TEXT NOT NULL,
          payload_envelope TEXT,
          source_json TEXT NOT NULL,
          runtime_id TEXT,
          response_envelope TEXT,
          delivery_status TEXT NOT NULL DEFAULT 'none',
          created_at INTEGER NOT NULL,
          claimed_at INTEGER,
          completed_at INTEGER,
          expires_at INTEGER NOT NULL,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_turn_jobs_status_created ON turn_jobs(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_turn_jobs_delivery ON turn_jobs(delivery_status, completed_at);
      `);
      const jobColumns = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(turn_jobs)").toArray();
      if (!jobColumns.some((column) => column.name === "delivery_attempts")) {
        ctx.storage.sql.exec("ALTER TABLE turn_jobs ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0");
      }
      const refreshColumns = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(runtime_refreshes)").toArray();
      if (!refreshColumns.some((column) => column.name === "response_envelope")) {
        ctx.storage.sql.exec("ALTER TABLE runtime_refreshes ADD COLUMN response_envelope TEXT");
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("websocket required", { status: 426 });
    const runtimeId = request.headers.get("x-crabhelm-runtime-id")?.trim();
    const clawId = request.headers.get("x-crabhelm-claw-id")?.trim();
    const refreshJti = request.headers.get("x-crabhelm-refresh-jti")?.trim();
    if (!runtimeId || !clawId || !refreshJti) return new Response("runtime identity required", { status: 401 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    for (const socket of this.ctx.getWebSockets("runtime")) {
      try {
        const attachment = attachmentFrom(socket);
        if (attachment.runtimeId === runtimeId) {
          this.#releaseOffers(attachment);
          socket.close(4001, "runtime reconnected");
        }
      } catch { socket.close(1011, "invalid runtime attachment"); }
    }
    server.serializeAttachment({ runtimeId, clawId, refreshJti } satisfies RuntimeAttachment);
    this.ctx.acceptWebSocket(server, ["runtime"]);
    server.send(JSON.stringify({ type: "runtime.ready", clawId, resetGeneration: await this.ctx.storage.get<number>("runtime-reset-generation") ?? 0 }));
    if (this.#pendingCount() > 0) server.send(JSON.stringify({ type: "job.available" }));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "crabhelm.runtime.v1" },
    });
  }

  async enqueueTurn(input: EnqueueTurnInput): Promise<{ id: string; duplicate: boolean }> {
    validateTurn(input);
    const existing = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM turn_jobs WHERE event_id = ?", input.eventId).toArray()[0];
    if (existing) return { id: existing.id, duplicate: true };
    const payload = await encryptTurnPayload(this.env.VAULT_MASTER_KEY, input.id, { prompt: input.prompt } satisfies TurnPayload);
    this.ctx.storage.sql.exec(
      "INSERT INTO turn_jobs (id, event_id, claw_id, requester_id, persona_id, status, turn_token, payload_envelope, source_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
      input.id,
      input.eventId,
      input.clawId,
      input.requesterId,
      input.personaId,
      input.turnToken,
      payload,
      JSON.stringify(input.source),
      Date.now(),
      input.expiresAt,
    );
    await this.#scheduleCleanup();
    this.#notifyAvailable();
    return { id: input.id, duplicate: false };
  }

  async runtimeStatus(): Promise<{ connected: number; pending: number; running: number; awaitingDelivery: number }> {
    return {
      connected: this.ctx.getWebSockets("runtime").length,
      pending: this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM turn_jobs WHERE status IN ('pending', 'offered')").one().count,
      running: this.#count("running"),
      awaitingDelivery: this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM turn_jobs WHERE delivery_status = 'pending'").one().count,
    };
  }

  async jobStatus(id: string): Promise<{ status: string; deliveryStatus: string; completedAt?: number; failed: boolean } | undefined> {
    if (!id || id.length > 200) throw new Error("invalid job id");
    const row = this.ctx.storage.sql.exec<Pick<JobRow, "status" | "delivery_status" | "completed_at" | "error">>(
      "SELECT status, delivery_status, completed_at, error FROM turn_jobs WHERE id = ?",
      id,
    ).toArray()[0];
    if (!row) return undefined;
    return {
      status: row.status,
      deliveryStatus: row.delivery_status,
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      failed: row.error !== null,
    };
  }

  async cancelPending(reason = "Claw disabled by an administrator"): Promise<number> {
    const jobs = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM turn_jobs WHERE status IN ('pending', 'offered')").toArray();
    for (const job of jobs) {
      const envelope = await encryptTurnPayload(this.env.VAULT_MASTER_KEY, `${job.id}:response`, { prompt: "This Crabhelm teammate is currently disabled. Please contact an administrator." } satisfies TurnPayload);
      this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = 'failed', completed_at = ?, response_envelope = ?, delivery_status = 'pending', error = ? WHERE id = ? AND status IN ('pending', 'offered')", Date.now(), envelope, reason.slice(0, 500), job.id);
    }
    if (jobs.length) await this.#scheduleCleanup();
    return jobs.length;
  }

  async cancelActiveTurns(reason = "Runtime reset by an administrator"): Promise<number> {
    const generation = await this.ctx.storage.get<number>("runtime-reset-generation") ?? 0;
    await this.ctx.storage.put("runtime-reset-generation", generation + 1);
    const pending = await this.cancelPending(reason);
    const running = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM turn_jobs WHERE status = 'running'").toArray();
    for (const job of running) await this.#failJob(job, reason);
    return pending + running.length;
  }

  async prepareForRemoval(reason = "Claw removed by an administrator"): Promise<number> {
    const generation = await this.ctx.storage.get<number>("runtime-reset-generation") ?? 0;
    await this.ctx.storage.put("runtime-reset-generation", generation + 1);
    const active = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM turn_jobs WHERE status IN ('pending', 'offered', 'running') OR delivery_status = 'pending'",
    ).one().count;
    this.ctx.storage.sql.exec(
      "UPDATE turn_jobs SET status = 'failed', completed_at = COALESCE(completed_at, ?), delivery_status = 'failed', payload_envelope = NULL, response_envelope = NULL, error = ? WHERE status IN ('pending', 'offered', 'running') OR delivery_status = 'pending'",
      Date.now(),
      reason.slice(0, 500),
    );
    for (const socket of this.ctx.getWebSockets("runtime")) socket.close(4002, "claw removal requested");
    return active;
  }

  async registerGrant(input: GrantRegistration): Promise<void> {
    if (!input.invocationId || !input.jti || !/^[0-9a-f]{64}$/u.test(input.argumentsDigest) || !Number.isInteger(input.expiresAt) || input.expiresAt <= Date.now()) throw new Error("grant registration is invalid");
    this.ctx.storage.sql.exec("INSERT INTO grants (invocation_id, jti, arguments_digest, expires_at) VALUES (?, ?, ?, ?)", input.invocationId, input.jti, input.argumentsDigest, input.expiresAt);
    await this.#scheduleCleanup();
  }

  async registerRuntimeRefresh(input: { jti: string; expiresAt: number }): Promise<void> {
    if (!input.jti || !Number.isInteger(input.expiresAt) || input.expiresAt <= Date.now()) throw new Error("runtime refresh is invalid");
    this.ctx.storage.sql.exec("INSERT INTO runtime_refreshes (jti, expires_at) VALUES (?, ?)", input.jti, input.expiresAt);
    await this.#scheduleCleanup();
  }

  async registerRuntimeTicket(input: { jti: string; expiresAt: number }): Promise<void> {
    if (!input.jti || !Number.isInteger(input.expiresAt) || input.expiresAt <= Date.now()) throw new Error("runtime ticket is invalid");
    this.ctx.storage.sql.exec("INSERT INTO runtime_tickets (jti, expires_at) VALUES (?, ?)", input.jti, input.expiresAt);
    await this.#scheduleCleanup();
  }

  async consumeRuntimeTicket(input: { jti: string; now: number }): Promise<boolean> {
    if (!input.jti || !Number.isInteger(input.now)) return false;
    return this.ctx.storage.sql.exec("UPDATE runtime_tickets SET consumed_at = ? WHERE jti = ? AND consumed_at IS NULL AND expires_at > ?", input.now, input.jti, input.now).rowsWritten === 1;
  }

  async consumeGrant(input: GrantRegistration): Promise<boolean> {
    const result = this.ctx.storage.sql.exec("UPDATE grants SET consumed_at = ? WHERE invocation_id = ? AND jti = ? AND arguments_digest = ? AND expires_at > ? AND consumed_at IS NULL", Date.now(), input.invocationId, input.jti, input.argumentsDigest, Date.now());
    return result.rowsWritten === 1;
  }

  async startRun(invocationId: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO runs (invocation_id, status, started_at) VALUES (?, 'running', ?)", invocationId, Date.now());
  }

  async finishRun(invocationId: string, ok: boolean, error?: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE runs SET status = ?, completed_at = ?, error = ? WHERE invocation_id = ? AND status = 'running'", ok ? "succeeded" : "failed", Date.now(), error?.slice(0, 500) ?? null, invocationId);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentFrom(ws);
    if (attachment.disabled) return;
    if (typeof message !== "string" || Buffer.byteLength(message, "utf8") > 64 * 1024) {
      ws.close(1009, "invalid message");
      return;
    }
    let input: Record<string, unknown>;
    try { input = JSON.parse(message) as Record<string, unknown>; } catch { ws.close(1007, "invalid JSON"); return; }
    if (input.type === "runtime.heartbeat") {
      ws.send(JSON.stringify({ type: "runtime.heartbeat", at: Date.now(), resetGeneration: await this.ctx.storage.get<number>("runtime-reset-generation") ?? 0 }));
      return;
    }
    if (input.type === "runtime.refresh") {
      await this.#refreshRuntime(ws, attachment);
      return;
    }
    if (input.type === "runtime.client_error") {
      const error = typeof input.error === "string" ? input.error.slice(0, 500) : "runtime client error";
      console.error(JSON.stringify({ event: "runtime_client_error", runtimeId: attachment.runtimeId, error }));
      return;
    }
    if (input.type === "runtime.client_event") {
      const event = input.event === "job.turn" ? input.event : "unsupported";
      const id = typeof input.id === "string" ? input.id.slice(0, 100) : "invalid";
      console.log(JSON.stringify({ event: "runtime_client_event", runtimeId: attachment.runtimeId, clientEvent: event, jobId: id }));
      return;
    }
    if (input.type === "job.claim") {
      await this.#claim(ws, attachment);
      return;
    }
    if (input.type === "job.started") {
      this.#start(ws, attachment, input);
      return;
    }
    if (input.type === "job.complete") {
      console.log(JSON.stringify({ event: "runtime_completion_received", jobId: typeof input.id === "string" ? input.id : "invalid", runtimeId: attachment.runtimeId, ok: input.ok === true }));
      await this.#complete(ws, attachment, input);
      return;
    }
    ws.send(JSON.stringify({ type: "runtime.error", error: "unsupported message type" }));
  }

  async restartRuntimeConnections(): Promise<number> {
    const sockets = this.ctx.getWebSockets("runtime");
    for (const socket of sockets) {
      const attachment = attachmentFrom(socket);
      socket.serializeAttachment({ ...attachment, disabled: true } satisfies RuntimeAttachment);
      this.#releaseOffers(attachment);
      socket.close(4002, "runtime reconnect requested");
    }
    this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = 'pending', runtime_id = NULL, claimed_at = NULL WHERE status = 'offered'");
    if (this.#hasWork()) await this.#scheduleCleanup();
    return sockets.length;
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { this.#releaseOffers(attachmentFrom(ws)); } catch { /* Invalid attachments cannot own valid offers. */ }
    if (this.#hasWork()) await this.#scheduleCleanup();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { this.#releaseOffers(attachmentFrom(ws)); } catch { /* Invalid attachments cannot own valid offers. */ }
    if (this.#hasWork()) await this.#scheduleCleanup();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = 'pending', runtime_id = NULL, claimed_at = NULL WHERE status = 'offered' AND claimed_at < ?", now - 30_000);
    // Keep this above the appliance's 15-minute turn limit so a ten-minute
    // requester-confirmation window cannot be reaped while the tool is waiting.
    const stalled = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM turn_jobs WHERE status = 'running' AND claimed_at < ?", now - 17 * 60 * 1000).toArray();
    for (const job of stalled) await this.#failJob(job, "runtime turn timed out");
    const expired = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM turn_jobs WHERE status IN ('pending', 'offered') AND expires_at <= ?", now).toArray();
    for (const job of expired) {
      const envelope = await encryptTurnPayload(this.env.VAULT_MASTER_KEY, `${job.id}:response`, { prompt: "This request expired before the teammate could process it. Please retry." } satisfies TurnPayload);
      this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = 'failed', completed_at = ?, response_envelope = ?, delivery_status = 'pending', error = 'turn expired' WHERE id = ? AND status IN ('pending', 'offered')", now, envelope, job.id);
    }
    const pendingDelivery = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM turn_jobs WHERE delivery_status = 'pending' ORDER BY completed_at LIMIT 20").toArray();
    for (const job of pendingDelivery) await this.#deliver(job);
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.ctx.storage.sql.exec("DELETE FROM grants WHERE expires_at < ?", now);
    this.ctx.storage.sql.exec("DELETE FROM runtime_refreshes WHERE expires_at < ?", now);
    this.ctx.storage.sql.exec("DELETE FROM runtime_tickets WHERE expires_at < ?", now);
    this.ctx.storage.sql.exec("DELETE FROM runs WHERE completed_at IS NOT NULL AND completed_at < ?", now - 7 * 24 * 60 * 60 * 1000);
    this.ctx.storage.sql.exec("DELETE FROM turn_jobs WHERE completed_at IS NOT NULL AND completed_at < ? AND delivery_status IN ('delivered', 'failed')", cutoff);
    if (this.#hasWork()) await this.ctx.storage.setAlarm(now + 60_000);
  }

  async #claim(ws: WebSocket, attachment: RuntimeAttachment): Promise<void> {
    const owned = this.ctx.storage.sql.exec<JobRow>(
      "SELECT * FROM turn_jobs WHERE status = 'offered' AND runtime_id = ? AND expires_at > ? ORDER BY created_at LIMIT 1",
      attachment.runtimeId,
      Date.now(),
    ).toArray()[0];
    if (owned) {
      try {
        const payload = await decryptTurnPayload<TurnPayload>(this.env.VAULT_MASTER_KEY, owned.id, owned.payload_envelope ?? "");
        const encoded = Buffer.from(JSON.stringify({
          type: "job.turn",
          id: owned.id,
          prompt: payload.prompt,
          requesterId: owned.requester_id,
          personaId: owned.persona_id,
          turnToken: owned.turn_token,
          sessionId: sessionId(owned),
        }), "utf8").toString("base64url");
        const chunks = encoded.match(/.{1,512}/gu) ?? [];
        ws.send(JSON.stringify({ type: "job.preparing", id: owned.id }));
        ws.send(JSON.stringify({ type: "job.turn.start", id: owned.id, chunks: chunks.length }));
        for (let index = 0; index < chunks.length; index++) {
          ws.send(JSON.stringify({ type: "job.turn.chunk", id: owned.id, index, data: chunks[index] }));
        }
        ws.send(JSON.stringify({ type: "job.turn.ready", id: owned.id }));
        console.log(JSON.stringify({ event: "runtime_offer_sent", jobId: owned.id, runtimeId: attachment.runtimeId }));
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "payload failure";
        console.error(JSON.stringify({ event: "runtime_offer_failed", jobId: owned.id, runtimeId: attachment.runtimeId, error: message }));
        this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = 'pending', runtime_id = NULL, claimed_at = NULL WHERE id = ? AND status = 'offered' AND runtime_id = ?", owned.id, attachment.runtimeId);
        try { ws.send(JSON.stringify({ type: "job.retry" })); } catch { /* The offer is pending for another runtime. */ }
        await this.#scheduleCleanup();
      }
      return;
    }
    const row = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM turn_jobs WHERE status = 'pending' AND expires_at > ? ORDER BY created_at LIMIT 1", Date.now()).toArray()[0];
    console.log(JSON.stringify({ event: "runtime_claim_received", runtimeId: attachment.runtimeId, available: Boolean(row) }));
    if (!row) { ws.send(JSON.stringify({ type: "job.none" })); return; }
    try {
      // Schedule the retry before the conditional write so the next socket
      // message observes a committed offer without mixing delivery and state.
      ws.send(JSON.stringify({ type: "job.retry" }));
      const updated = this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = 'offered', runtime_id = ?, claimed_at = ? WHERE id = ? AND status = 'pending'", attachment.runtimeId, Date.now(), row.id);
      if (updated.rowsWritten !== 1) return;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "payload failure";
      console.error(JSON.stringify({ event: "runtime_offer_failed", jobId: row.id, runtimeId: attachment.runtimeId, error: message }));
      this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = 'failed', completed_at = ?, delivery_status = 'pending', error = ? WHERE id = ? AND status = 'pending'", Date.now(), message, row.id);
      this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = 'pending', runtime_id = NULL, claimed_at = NULL WHERE id = ? AND status = 'offered'", row.id);
      try { ws.send(JSON.stringify({ type: "job.retry" })); } catch { /* The offer is pending for another runtime. */ }
      await this.#scheduleCleanup();
    }
  }

  async #refreshRuntime(ws: WebSocket, attachment: RuntimeAttachment): Promise<void> {
    const now = Date.now();
    const current = this.ctx.storage.sql.exec<{ expires_at: number; consumed_at: number | null; response_envelope: string | null }>(
      "SELECT expires_at, consumed_at, response_envelope FROM runtime_refreshes WHERE jti = ?",
      attachment.refreshJti,
    ).toArray()[0];
    if (!current || current.expires_at <= now) {
      ws.send(JSON.stringify({ type: "runtime.error", error: "runtime refresh was already used" }));
      ws.close(4003, "runtime refresh rejected");
      return;
    }
    if (current.response_envelope) {
      const replay = await decryptTurnPayload<{ token: string; expiresInSeconds: number }>(
        this.env.VAULT_MASTER_KEY,
        `runtime-refresh:${attachment.refreshJti}`,
        current.response_envelope,
      );
      const next = await verifyClaims<RuntimeClaims>(this.env.RUNTIME_SIGNING_SECRET, replay.token, { typ: "runtime", aud: "crabhelm-runtime" });
      ws.serializeAttachment({ ...attachment, refreshJti: next.jti } satisfies RuntimeAttachment);
      ws.send(JSON.stringify({ type: "runtime.token", ...replay }));
      return;
    }
    const token = await signClaims<RuntimeClaims>(this.env.RUNTIME_SIGNING_SECRET, {
      typ: "runtime", aud: "crabhelm-runtime", clawId: attachment.clawId, runtimeId: attachment.runtimeId,
    }, 10 * 60);
    const next = await verifyClaims<RuntimeClaims>(this.env.RUNTIME_SIGNING_SECRET, token, { typ: "runtime", aud: "crabhelm-runtime" });
    await this.registerRuntimeRefresh({ jti: next.jti, expiresAt: next.exp * 1000 });
    const response = { token, expiresInSeconds: 10 * 60 };
    const envelope = await encryptTurnPayload(this.env.VAULT_MASTER_KEY, `runtime-refresh:${attachment.refreshJti}`, response);
    const updated = current.consumed_at === null
      ? this.ctx.storage.sql.exec(
        "UPDATE runtime_refreshes SET consumed_at = ?, response_envelope = ? WHERE jti = ? AND consumed_at IS NULL AND response_envelope IS NULL AND expires_at > ?",
        now, envelope, attachment.refreshJti, now,
      )
      : this.ctx.storage.sql.exec(
        "UPDATE runtime_refreshes SET response_envelope = ? WHERE jti = ? AND response_envelope IS NULL AND expires_at > ?",
        envelope, attachment.refreshJti, now,
      );
    if (updated.rowsWritten !== 1) {
      this.ctx.storage.sql.exec("DELETE FROM runtime_refreshes WHERE jti = ? AND consumed_at IS NULL", next.jti);
      await this.#refreshRuntime(ws, attachment);
      return;
    }
    ws.serializeAttachment({ ...attachment, refreshJti: next.jti } satisfies RuntimeAttachment);
    ws.send(JSON.stringify({ type: "runtime.token", ...response }));
  }

  #start(ws: WebSocket, attachment: RuntimeAttachment, input: Record<string, unknown>): void {
    const id = typeof input.id === "string" ? input.id : "";
    console.log(JSON.stringify({ event: "runtime_started_received", jobId: id || "invalid", runtimeId: attachment.runtimeId }));
    const updated = id
      ? this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = 'running', claimed_at = ? WHERE id = ? AND status = 'offered' AND runtime_id = ?", Date.now(), id, attachment.runtimeId)
      : undefined;
    if (updated?.rowsWritten !== 1) {
      const existing = id
        ? this.ctx.storage.sql.exec<Pick<JobRow, "status" | "runtime_id">>("SELECT status, runtime_id FROM turn_jobs WHERE id = ?", id).toArray()[0]
        : undefined;
      if (existing?.status === "running" && existing.runtime_id === attachment.runtimeId) {
        ws.send(JSON.stringify({ type: "job.started.ack", id }));
        return;
      }
      ws.send(JSON.stringify({ type: "runtime.error", error: "job offer is not owned by this runtime" }));
      return;
    }
    ws.send(JSON.stringify({ type: "job.started.ack", id }));
  }

  #releaseOffers(attachment: RuntimeAttachment): void {
    const released = this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = 'pending', runtime_id = NULL, claimed_at = NULL WHERE status = 'offered' AND runtime_id = ?", attachment.runtimeId);
    console.log(JSON.stringify({ event: "runtime_offers_released", runtimeId: attachment.runtimeId, count: released.rowsWritten }));
  }

  async #complete(ws: WebSocket, attachment: RuntimeAttachment, input: Record<string, unknown>): Promise<void> {
    const id = typeof input.id === "string" ? input.id : "";
    const ok = input.ok === true;
    const output = typeof input.output === "string" ? input.output.trim() : "";
    const error = typeof input.error === "string" ? input.error.trim().slice(0, 500) : "runtime turn failed";
    if (!id || (ok && (!output || Buffer.byteLength(output, "utf8") > 24 * 1024))) {
      ws.send(JSON.stringify({ type: "runtime.error", error: "invalid completion" }));
      return;
    }
    const job = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM turn_jobs WHERE id = ?", id).toArray()[0];
    if (job && (job.status === "completed" || job.status === "failed") && job.runtime_id === attachment.runtimeId) {
      if (job.delivery_status === "pending") await this.#deliver(job);
      ws.send(JSON.stringify({ type: "job.ack", id }));
      return;
    }
    if (!job || job.status !== "running" || job.runtime_id !== attachment.runtimeId) {
      console.warn(JSON.stringify({ event: "runtime_completion_rejected", jobId: id, runtimeId: attachment.runtimeId, status: job?.status ?? "missing", owner: job?.runtime_id ?? "missing" }));
      ws.send(JSON.stringify({ type: "runtime.error", error: "job is not owned by this runtime" }));
      return;
    }
    const response = ok ? output : "Crabhelm could not complete this request. Please retry.";
    const envelope = await encryptTurnPayload(this.env.VAULT_MASTER_KEY, `${id}:response`, { prompt: response } satisfies TurnPayload);
    this.ctx.storage.sql.exec("UPDATE turn_jobs SET status = ?, completed_at = ?, response_envelope = ?, delivery_status = 'pending', error = ? WHERE id = ? AND status = 'running'", ok ? "completed" : "failed", Date.now(), envelope, ok ? null : error, id);
    console.log(JSON.stringify({ event: "runtime_completion_recorded", jobId: id, runtimeId: attachment.runtimeId, ok }));
    await this.#deliver(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM turn_jobs WHERE id = ?", id).one());
    ws.send(JSON.stringify({ type: "job.ack", id }));
    if (this.#pendingCount() > 0) ws.send(JSON.stringify({ type: "job.available" }));
  }

  async #failJob(job: JobRow, reason: string): Promise<void> {
    const envelope = await encryptTurnPayload(this.env.VAULT_MASTER_KEY, `${job.id}:response`, { prompt: "Crabhelm could not complete this request. Please retry." } satisfies TurnPayload);
    const updated = this.ctx.storage.sql.exec(
      "UPDATE turn_jobs SET status = 'failed', completed_at = ?, response_envelope = ?, delivery_status = 'pending', error = ? WHERE id = ? AND status = 'running'",
      Date.now(),
      envelope,
      reason.slice(0, 500),
      job.id,
    );
    if (updated.rowsWritten === 1) await this.#deliver(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM turn_jobs WHERE id = ?", job.id).one());
  }

  async #deliver(job: JobRow): Promise<void> {
    const source = JSON.parse(job.source_json) as SlackTurnSource;
    if (source.surface !== "slack" || !this.env.SLACK_BOT_TOKEN?.trim()) {
      this.ctx.storage.sql.exec("UPDATE turn_jobs SET delivery_status = 'failed' WHERE id = ?", job.id);
      return;
    }
    try {
      const payload = await decryptTurnPayload<TurnPayload>(this.env.VAULT_MASTER_KEY, `${job.id}:response`, job.response_envelope ?? "");
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: source.channelId, thread_ts: source.threadTs, text: payload.prompt, unfurl_links: false, unfurl_media: false }),
      });
      const result = await boundedSlackResponse(response);
      if (!response.ok || result.ok !== true) throw slackDeliveryError(response.status, result.error);
      this.ctx.storage.sql.exec("UPDATE turn_jobs SET delivery_status = 'delivered', payload_envelope = NULL, response_envelope = NULL WHERE id = ?", job.id);
    } catch (error) {
      const attempts = (Number.isInteger(job.delivery_attempts) ? job.delivery_attempts : 0) + 1;
      const terminal = (error instanceof SlackDeliveryError && !error.retryable) || attempts >= 5;
      console.error(JSON.stringify({ event: "slack_turn_delivery_failed", jobId: job.id, attempt: attempts, terminal, error: error instanceof Error ? error.message : String(error) }));
      this.ctx.storage.sql.exec(
        terminal
          ? "UPDATE turn_jobs SET delivery_status = 'failed', delivery_attempts = ?, payload_envelope = NULL, response_envelope = NULL WHERE id = ?"
          : "UPDATE turn_jobs SET delivery_attempts = ? WHERE id = ? AND delivery_status = 'pending'",
        attempts,
        job.id,
      );
      if (!terminal) await this.#scheduleCleanup();
    }
  }

  #notifyAvailable(): void {
    for (const socket of this.ctx.getWebSockets("runtime")) {
      try { socket.send(JSON.stringify({ type: "job.available" })); } catch { /* Socket cleanup is handled by the platform. */ }
    }
  }

  #count(status: string): number { return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM turn_jobs WHERE status = ?", status).one().count; }
  #pendingCount(): number { return this.#count("pending"); }
  #hasWork(): boolean { return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM turn_jobs WHERE status IN ('pending', 'offered', 'running') OR delivery_status = 'pending'").one().count > 0; }
  async #scheduleCleanup(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + 60_000) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
}

async function boundedSlackResponse(response: Response): Promise<{ ok?: boolean; error?: string }> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 128 * 1024) throw new Error("Slack delivery response is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 128 * 1024) throw new Error("Slack delivery response is too large");
  try { return JSON.parse(new TextDecoder().decode(bytes)) as { ok?: boolean; error?: string }; }
  catch { throw new Error(`Slack delivery returned invalid JSON (${response.status})`); }
}

class SlackDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

function slackDeliveryError(status: number, code?: string): SlackDeliveryError {
  return new SlackDeliveryError(`Slack delivery failed: ${code ?? status}`, slackDeliveryRetryable(status, code));
}

function attachmentFrom(ws: WebSocket): RuntimeAttachment {
  const value = ws.deserializeAttachment() as RuntimeAttachment | null;
  if (!value?.runtimeId || !value.clawId || !value.refreshJti) throw new Error("runtime socket attachment is invalid");
  return value;
}

function validateTurn(input: EnqueueTurnInput): void {
  if (!input.id || !input.eventId || !input.clawId || !input.requesterId || !input.personaId || !input.turnToken) throw new Error("turn identity is incomplete");
  if (!input.prompt.trim() || Buffer.byteLength(input.prompt, "utf8") > 48 * 1024) throw new Error("turn prompt is invalid");
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 60 * 60 * 1000) throw new Error("turn expiry is invalid");
  if (input.source.surface !== "slack" || !input.source.workspaceId || !input.source.channelId || !input.source.threadTs) throw new Error("turn source is invalid");
}

function sessionId(job: JobRow): string {
  const source = JSON.parse(job.source_json) as SlackTurnSource;
  return `crabhelm-slack-${source.workspaceId}-${source.channelId}-${source.threadTs}`.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 180);
}
