import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { RuntimeClaims } from "../src/governance-types.js";
import { slackDeliveryRetryable } from "../worker/slack-delivery.js";
import { signClaims, verifyClaims } from "../worker/security.js";
import { decryptTurnPayload, encryptTurnPayload } from "../worker/turn-envelope.js";

const tables = {
  claws: "crabhelm_coordinator_claws",
  grants: "crabhelm_coordinator_grants",
  runs: "crabhelm_coordinator_runs",
  refreshes: "crabhelm_coordinator_runtime_refreshes",
  tickets: "crabhelm_coordinator_runtime_tickets",
  jobs: "crabhelm_coordinator_turn_jobs",
} as const;

const offerLeaseMs = 30_000;
const deliveryLeaseMs = 60_000;
const runningTimeoutMs = 17 * 60 * 1000;
const cleanupBatchSize = 100;
const jobRetentionMs = 24 * 60 * 60 * 1000;
const runRetentionMs = 7 * 24 * 60 * 60 * 1000;
const encryptedTurnTokenMarker = "[encrypted]";

export type GrantRegistration = {
  invocationId: string;
  jti: string;
  argumentsDigest: string;
  expiresAt: number;
};

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

export type RuntimeAttachment = {
  runtimeId: string;
  clawId: string;
  refreshJti: string;
  disabled?: true;
};

type SocketListener = (...arguments_: unknown[]) => void;

export type AwsRuntimeSocket = {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
  on?: (event: string, listener: SocketListener) => unknown;
  addEventListener?: (event: string, listener: (event: unknown) => void) => unknown;
};

export type AwsCoordinatorDirectoryOptions = {
  pool: Pool;
  vaultMasterKey: string;
  runtimeSigningSecret: string;
  slackBotToken?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  scheduleCleanup?: (clawId: string, at: number) => Promise<void>;
};

export type AwsRuntimeStatus = {
  connected: number;
  pending: number;
  running: number;
  awaitingDelivery: number;
};

type TurnPayload = { prompt: string; turnToken?: string };

type JobDatabaseRow = QueryResultRow & {
  id: string;
  event_id: string;
  claw_id: string;
  requester_id: string;
  persona_id: string;
  status: string;
  payload_envelope: string | null;
  source_json: unknown;
  runtime_id: string | null;
  response_envelope: string | null;
  delivery_status: string;
  delivery_owner: string | null;
  delivery_claimed_at: string | number | null;
  delivery_attempts: string | number;
  created_at: string | number;
  claimed_at: string | number | null;
  completed_at: string | number | null;
  expires_at: string | number;
  error: string | null;
};

type JobRow = {
  id: string;
  event_id: string;
  claw_id: string;
  requester_id: string;
  persona_id: string;
  status: string;
  payload_envelope: string | null;
  source_json: unknown;
  runtime_id: string | null;
  response_envelope: string | null;
  delivery_status: string;
  delivery_owner: string | null;
  delivery_claimed_at: number | null;
  delivery_attempts: number;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  expires_at: number;
  error: string | null;
};

type CountRow = QueryResultRow & { count: string | number };
type CoordinatorStateRow = QueryResultRow & { reset_generation: string | number };
type CoordinatorRemovalRow = QueryResultRow & { removed_at: string | number | null };
type RefreshRow = QueryResultRow & {
  expires_at: string | number;
  consumed_at: string | number | null;
  response_envelope: string | null;
};

export class AwsCoordinatorDirectory {
  readonly #options: AwsCoordinatorDirectoryOptions;
  readonly #coordinators = new Map<string, AwsClawCoordinator>();

  constructor(options: AwsCoordinatorDirectoryOptions) {
    this.#options = options;
  }

  getByName(id: string): AwsClawCoordinator {
    requireIdentifier(id, "claw id", 200);
    let coordinator = this.#coordinators.get(id);
    if (!coordinator) {
      coordinator = new AwsClawCoordinator(id, this.#options);
      this.#coordinators.set(id, coordinator);
    }
    return coordinator;
  }

  async cleanupSweep(limit = 100, now = this.#options.now?.() ?? Date.now()): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("coordinator cleanup limit is invalid");
    }
    requireTimestamp(now, "coordinator cleanup time");
    let cursor = "";
    let swept = 0;
    while (true) {
      const result = await this.#options.pool.query<{ claw_id: string }>(
        `WITH candidates AS (
           SELECT claw_id FROM ${tables.jobs}
           WHERE status IN ('pending', 'offered', 'running')
              OR delivery_status IN ('pending', 'delivering')
              OR (completed_at IS NOT NULL AND completed_at < $3 AND delivery_status IN ('delivered', 'failed'))
           UNION
           SELECT claw_id FROM ${tables.grants} WHERE expires_at < $1
           UNION
           SELECT claw_id FROM ${tables.refreshes} WHERE expires_at < $1
           UNION
           SELECT claw_id FROM ${tables.tickets} WHERE expires_at < $1
           UNION
           SELECT claw_id FROM ${tables.runs}
           WHERE (status = 'running' AND started_at < $6)
              OR (completed_at IS NOT NULL AND completed_at < $2)
         )
         SELECT claw_id FROM candidates WHERE claw_id > $4 ORDER BY claw_id LIMIT $5`,
        [now, now - runRetentionMs, now - jobRetentionMs, cursor, limit, now - runningTimeoutMs],
      );
      for (const row of result.rows) {
        await this.getByName(row.claw_id).cleanupSweep(now);
      }
      swept += result.rows.length;
      if (result.rows.length < limit) return swept;
      cursor = result.rows.at(-1)!.claw_id;
    }
  }
}

export class AwsClawCoordinator {
  readonly #clawId: string;
  readonly #pool: Pool;
  readonly #vaultMasterKey: string;
  readonly #runtimeSigningSecret: string;
  readonly #slackBotToken?: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #scheduleCleanupCallback?: (clawId: string, at: number) => Promise<void>;
  readonly #deliveryOwner = randomUUID();
  readonly #sockets = new Map<AwsRuntimeSocket, RuntimeAttachment>();
  #tail: Promise<void> = Promise.resolve();

  constructor(clawId: string, options: AwsCoordinatorDirectoryOptions) {
    requireIdentifier(clawId, "claw id", 200);
    this.#clawId = clawId;
    this.#pool = options.pool;
    this.#vaultMasterKey = options.vaultMasterKey;
    this.#runtimeSigningSecret = options.runtimeSigningSecret;
    this.#slackBotToken = options.slackBotToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#scheduleCleanupCallback = options.scheduleCleanup;
  }

  async attachSocket(socket: AwsRuntimeSocket, input: RuntimeAttachment): Promise<void> {
    return this.#serialize(async () => {
      validateAttachment(input, this.#clawId);
      await this.#assertActive();
      for (const [existingSocket, attachment] of this.#sockets) {
        if (attachment.runtimeId !== input.runtimeId) continue;
        attachment.disabled = true;
        this.#sockets.delete(existingSocket);
        await this.#releaseOffers(attachment);
        existingSocket.close(4001, "runtime reconnected");
      }
      const attachment = { ...input };
      this.#sockets.set(socket, attachment);
      this.#bindSocket(socket);
      try {
        socket.send(JSON.stringify({
          type: "runtime.ready",
          clawId: this.#clawId,
          resetGeneration: await this.#resetGeneration(),
        }));
        if (await this.#pendingCount() > 0) {
          socket.send(JSON.stringify({ type: "job.available" }));
        }
      } catch (error) {
        this.#sockets.delete(socket);
        throw error;
      }
    });
  }

  async enqueueTurn(input: EnqueueTurnInput): Promise<{ id: string; duplicate: boolean }> {
    return this.#serialize(async () => this.#enqueueTurn(input));
  }

  async runtimeStatus(): Promise<AwsRuntimeStatus> {
    return this.#serialize(async () => {
      const result = await this.#pool.query<
        QueryResultRow & { pending: string | number; running: string | number; awaiting_delivery: string | number }
      >(
        `SELECT
           (COUNT(*) FILTER (WHERE status IN ('pending', 'offered')))::text AS pending,
           (COUNT(*) FILTER (WHERE status = 'running'))::text AS running,
           (COUNT(*) FILTER (WHERE delivery_status IN ('pending', 'delivering')))::text AS awaiting_delivery
         FROM ${tables.jobs}
         WHERE claw_id = $1`,
        [this.#clawId],
      );
      const row = result.rows[0];
      return {
        connected: [...this.#sockets.values()].filter((attachment) => !attachment.disabled).length,
        pending: decodeCount(row?.pending),
        running: decodeCount(row?.running),
        awaitingDelivery: decodeCount(row?.awaiting_delivery),
      };
    });
  }

  async jobStatus(id: string): Promise<{
    status: string;
    deliveryStatus: string;
    completedAt?: number;
    failed: boolean;
  } | undefined> {
    requireIdentifier(id, "job id", 200);
    return this.#serialize(async () => {
      const result = await this.#pool.query<
        QueryResultRow & {
          status: string;
          delivery_status: string;
          completed_at: string | number | null;
          error: string | null;
        }
      >(
        `SELECT status, delivery_status, completed_at::text AS completed_at, error
         FROM ${tables.jobs} WHERE claw_id = $1 AND id = $2`,
        [this.#clawId, id],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const completedAt = decodeNullableInteger(row.completed_at, "job completion time");
      return {
        status: row.status,
        deliveryStatus: row.delivery_status,
        ...(completedAt === null ? {} : { completedAt }),
        failed: row.error !== null,
      };
    });
  }

  async cancelPending(reason = "Claw disabled by an administrator"): Promise<number> {
    return this.#serialize(async () => this.#cancelPending(reason));
  }

  async cancelActiveTurns(reason = "Runtime reset by an administrator"): Promise<number> {
    return this.#serialize(async () => {
      await this.#incrementResetGeneration();
      const pending = await this.#cancelPending(reason);
      const running = await this.#jobs(
        `SELECT ${jobProjection()} FROM ${tables.jobs}
         WHERE claw_id = $1 AND status = 'running'`,
        [this.#clawId],
      );
      let failed = 0;
      for (const job of running) {
        if (await this.#failJob(job, reason)) failed += 1;
      }
      return pending + failed;
    });
  }

  async prepareForRemoval(reason = "Claw removed by an administrator"): Promise<number> {
    return this.#serialize(async () => {
      const now = this.#now();
      const affected = await this.#transaction(async (client) => {
        await client.query(
          `INSERT INTO ${tables.claws} (claw_id, reset_generation, removed_at) VALUES ($1, 1, $2)
           ON CONFLICT (claw_id) DO UPDATE
           SET reset_generation = ${tables.claws}.reset_generation + 1,
               removed_at = COALESCE(${tables.claws}.removed_at, EXCLUDED.removed_at)`,
          [this.#clawId, now],
        );
        await client.query(`DELETE FROM ${tables.grants} WHERE claw_id = $1`, [this.#clawId]);
        await client.query(`DELETE FROM ${tables.refreshes} WHERE claw_id = $1`, [this.#clawId]);
        await client.query(`DELETE FROM ${tables.tickets} WHERE claw_id = $1`, [this.#clawId]);
        const result = await client.query(
          `UPDATE ${tables.jobs}
           SET status = 'failed', completed_at = COALESCE(completed_at, $2), delivery_status = 'failed',
               delivery_owner = NULL, delivery_claimed_at = NULL,
               payload_envelope = NULL, response_envelope = NULL, error = $3
           WHERE claw_id = $1
             AND (status IN ('pending', 'offered', 'running') OR delivery_status IN ('pending', 'delivering'))
           RETURNING id`,
          [this.#clawId, now, reason.slice(0, 500)],
        );
        return rowCount(result);
      });
      for (const [socket, attachment] of this.#sockets) {
        attachment.disabled = true;
        this.#sockets.delete(socket);
        socket.close(4002, "claw removal requested");
      }
      return affected;
    });
  }

  async registerGrant(input: GrantRegistration): Promise<void> {
    return this.#serialize(async () => {
      validateGrant(input, this.#now());
      await this.#transaction(async (client) => {
        await this.#assertActive(client);
        await client.query(
          `INSERT INTO ${tables.grants}
             (claw_id, invocation_id, jti, arguments_digest, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [this.#clawId, input.invocationId, input.jti, input.argumentsDigest, input.expiresAt],
        );
      });
      await this.#scheduleCleanup();
    });
  }

  async registerRuntimeRefresh(input: { jti: string; expiresAt: number }): Promise<void> {
    return this.#serialize(async () => this.#registerRuntimeRefresh(input));
  }

  async registerRuntimeTicket(input: { jti: string; expiresAt: number }): Promise<void> {
    return this.#serialize(async () => {
      validateFence(input, "runtime ticket", this.#now());
      await this.#transaction(async (client) => {
        await this.#assertActive(client);
        await client.query(
          `INSERT INTO ${tables.tickets} (claw_id, jti, expires_at) VALUES ($1, $2, $3)`,
          [this.#clawId, input.jti, input.expiresAt],
        );
      });
      await this.#scheduleCleanup();
    });
  }

  async consumeRuntimeTicket(input: { jti: string; now: number }): Promise<boolean> {
    if (!input.jti || !Number.isInteger(input.now)) return false;
    return this.#serialize(async () => {
      return this.#transaction(async (client) => {
        if (await this.#isRemoved(client)) return false;
        const result = await client.query(
          `UPDATE ${tables.tickets}
           SET consumed_at = $3
           WHERE claw_id = $1 AND jti = $2 AND consumed_at IS NULL AND expires_at > $3`,
          [this.#clawId, input.jti, input.now],
        );
        return rowCount(result) === 1;
      });
    });
  }

  async consumeGrant(input: GrantRegistration): Promise<boolean> {
    return this.#serialize(async () => {
      const now = this.#now();
      return this.#transaction(async (client) => {
        if (await this.#isRemoved(client)) return false;
        const result = await client.query(
          `UPDATE ${tables.grants}
           SET consumed_at = $5
           WHERE claw_id = $1 AND invocation_id = $2 AND jti = $3 AND arguments_digest = $4
             AND expires_at > $5 AND consumed_at IS NULL`,
          [this.#clawId, input.invocationId, input.jti, input.argumentsDigest, now],
        );
        return rowCount(result) === 1;
      });
    });
  }

  async startRun(invocationId: string): Promise<void> {
    requireIdentifier(invocationId, "invocation id", 500);
    return this.#serialize(async () => {
      await this.#pool.query(
        `INSERT INTO ${tables.runs} (claw_id, invocation_id, status, started_at)
         VALUES ($1, $2, 'running', $3)`,
        [this.#clawId, invocationId, this.#now()],
      );
    });
  }

  async finishRun(invocationId: string, ok: boolean, error?: string): Promise<void> {
    requireIdentifier(invocationId, "invocation id", 500);
    return this.#serialize(async () => {
      await this.#pool.query(
        `UPDATE ${tables.runs}
         SET status = $3, completed_at = $4, error = $5
         WHERE claw_id = $1 AND invocation_id = $2 AND status = 'running'`,
        [this.#clawId, invocationId, ok ? "succeeded" : "failed", this.#now(), error?.slice(0, 500) ?? null],
      );
    });
  }

  async webSocketMessage(socket: AwsRuntimeSocket, message: string | ArrayBuffer): Promise<void> {
    return this.#serialize(async () => this.#webSocketMessage(socket, message));
  }

  async restartRuntimeConnections(): Promise<number> {
    return this.#serialize(async () => {
      const sockets = [...this.#sockets.entries()];
      for (const [socket, attachment] of sockets) {
        attachment.disabled = true;
        this.#sockets.delete(socket);
        socket.close(4002, "runtime reconnect requested");
      }
      await this.#pool.query(
        `UPDATE ${tables.jobs}
         SET status = 'pending', runtime_id = NULL, claimed_at = NULL
         WHERE claw_id = $1 AND status = 'offered'`,
        [this.#clawId],
      );
      if (await this.#hasWork()) await this.#scheduleCleanup();
      return sockets.length;
    });
  }

  async webSocketClose(socket: AwsRuntimeSocket): Promise<void> {
    return this.#serialize(async () => this.#detachSocket(socket));
  }

  async webSocketError(socket: AwsRuntimeSocket): Promise<void> {
    return this.#serialize(async () => this.#detachSocket(socket));
  }

  async alarm(): Promise<void> {
    return this.cleanupSweep();
  }

  async cleanupSweep(now = this.#now()): Promise<void> {
    requireTimestamp(now, "coordinator cleanup time");
    return this.#serialize(async () => {
      await this.#pool.query(
        `UPDATE ${tables.jobs}
         SET status = 'pending', runtime_id = NULL, claimed_at = NULL
         WHERE claw_id = $1 AND status = 'offered' AND claimed_at < $2`,
        [this.#clawId, now - offerLeaseMs],
      );

      const stalled = await this.#jobs(
        `SELECT ${jobProjection()} FROM ${tables.jobs}
         WHERE claw_id = $1 AND status = 'running' AND claimed_at < $2
         ORDER BY claimed_at, id LIMIT $3`,
        [this.#clawId, now - runningTimeoutMs, cleanupBatchSize],
      );
      for (const job of stalled) await this.#failJob(job, "runtime turn timed out", now);

      const expired = await this.#jobs(
        `SELECT ${jobProjection()} FROM ${tables.jobs}
         WHERE claw_id = $1 AND status IN ('pending', 'offered') AND expires_at <= $2
         ORDER BY expires_at, id LIMIT $3`,
        [this.#clawId, now, cleanupBatchSize],
      );
      for (const job of expired) await this.#expireJob(job, now);

      const deliveries = await this.#jobs(
        `SELECT ${jobProjection()} FROM ${tables.jobs}
         WHERE claw_id = $1
           AND (delivery_status = 'pending'
             OR (delivery_status = 'delivering' AND delivery_claimed_at < $2))
         ORDER BY completed_at, id LIMIT 20`,
        [this.#clawId, now - deliveryLeaseMs],
      );
      for (const job of deliveries) await this.#deliver(job, now);

      await Promise.all([
        this.#pool.query(`DELETE FROM ${tables.grants} WHERE claw_id = $1 AND expires_at < $2`, [this.#clawId, now]),
        this.#pool.query(`DELETE FROM ${tables.refreshes} WHERE claw_id = $1 AND expires_at < $2`, [this.#clawId, now]),
        this.#pool.query(`DELETE FROM ${tables.tickets} WHERE claw_id = $1 AND expires_at < $2`, [this.#clawId, now]),
        this.#pool.query(
          `UPDATE ${tables.runs}
           SET status = 'failed', completed_at = $2, error = 'governed run timed out'
           WHERE claw_id = $1 AND status = 'running' AND started_at < $3`,
          [this.#clawId, now, now - runningTimeoutMs],
        ),
        this.#pool.query(
          `DELETE FROM ${tables.runs}
           WHERE claw_id = $1 AND completed_at IS NOT NULL AND completed_at < $2`,
          [this.#clawId, now - runRetentionMs],
        ),
        this.#pool.query(
          `DELETE FROM ${tables.jobs}
           WHERE claw_id = $1 AND completed_at IS NOT NULL AND completed_at < $2
             AND delivery_status IN ('delivered', 'failed')`,
          [this.#clawId, now - jobRetentionMs],
        ),
      ]);
      if (await this.#hasWork()) await this.#scheduleCleanup();
    });
  }

  async #enqueueTurn(input: EnqueueTurnInput): Promise<{ id: string; duplicate: boolean }> {
    validateTurn(input, this.#clawId, this.#now());
    const payload = await encryptTurnPayload(
      this.#vaultMasterKey,
      input.id,
      { prompt: input.prompt, turnToken: input.turnToken } satisfies TurnPayload,
    );
    const inserted = await this.#transaction(async (client) => {
      await this.#assertActive(client);
      return client.query<{ id: string }>(
        `INSERT INTO ${tables.jobs}
           (claw_id, id, event_id, requester_id, persona_id, status, turn_token,
            payload_envelope, source_json, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8::jsonb, $9, $10)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          this.#clawId,
          input.id,
          input.eventId,
          input.requesterId,
          input.personaId,
          encryptedTurnTokenMarker,
          payload,
          JSON.stringify(input.source),
          this.#now(),
          input.expiresAt,
        ],
      );
    });
    if (inserted.rows[0]) {
      await this.#scheduleCleanup();
      this.#notifyAvailable();
      return { id: inserted.rows[0].id, duplicate: false };
    }
    const existing = await this.#pool.query<{ id: string }>(
      `SELECT id FROM ${tables.jobs} WHERE claw_id = $1 AND event_id = $2`,
      [this.#clawId, input.eventId],
    );
    if (!existing.rows[0]) throw new Error("turn job id already exists with a different event");
    return { id: existing.rows[0].id, duplicate: true };
  }

  async #cancelPending(reason: string): Promise<number> {
    const jobs = await this.#jobs(
      `SELECT ${jobProjection()} FROM ${tables.jobs}
       WHERE claw_id = $1 AND status IN ('pending', 'offered')`,
      [this.#clawId],
    );
    let cancelled = 0;
    for (const job of jobs) {
      const envelope = await encryptTurnPayload(
        this.#vaultMasterKey,
        `${job.id}:response`,
        { prompt: "This Crabhelm teammate is currently disabled. Please contact an administrator." } satisfies TurnPayload,
      );
      const result = await this.#pool.query(
        `UPDATE ${tables.jobs}
         SET status = 'failed', completed_at = $3, response_envelope = $4,
             payload_envelope = NULL, delivery_status = 'pending', error = $5
         WHERE claw_id = $1 AND id = $2 AND status IN ('pending', 'offered')`,
        [this.#clawId, job.id, this.#now(), envelope, reason.slice(0, 500)],
      );
      cancelled += rowCount(result);
    }
    if (cancelled > 0) await this.#scheduleCleanup();
    return cancelled;
  }

  async #registerRuntimeRefresh(input: { jti: string; expiresAt: number }): Promise<void> {
    validateFence(input, "runtime refresh", this.#now());
    await this.#transaction(async (client) => {
      await this.#assertActive(client);
      await client.query(
        `INSERT INTO ${tables.refreshes} (claw_id, jti, expires_at) VALUES ($1, $2, $3)`,
        [this.#clawId, input.jti, input.expiresAt],
      );
    });
    await this.#scheduleCleanup();
  }

  async #webSocketMessage(socket: AwsRuntimeSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.#socketAttachment(socket);
    if (attachment.disabled) return;
    if (typeof message !== "string" || Buffer.byteLength(message, "utf8") > 64 * 1024) {
      socket.close(1009, "invalid message");
      return;
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(message) as Record<string, unknown>;
    } catch {
      socket.close(1007, "invalid JSON");
      return;
    }
    if (input.type === "runtime.heartbeat") {
      socket.send(JSON.stringify({
        type: "runtime.heartbeat",
        at: this.#now(),
        resetGeneration: await this.#resetGeneration(),
      }));
      return;
    }
    if (input.type === "runtime.refresh") {
      await this.#refreshRuntime(socket, attachment);
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
      await this.#claim(socket, attachment);
      return;
    }
    if (input.type === "job.started") {
      await this.#start(socket, attachment, input);
      return;
    }
    if (input.type === "job.complete") {
      console.log(JSON.stringify({
        event: "runtime_completion_received",
        jobId: typeof input.id === "string" ? input.id : "invalid",
        runtimeId: attachment.runtimeId,
        ok: input.ok === true,
      }));
      await this.#complete(socket, attachment, input);
      return;
    }
    socket.send(JSON.stringify({ type: "runtime.error", error: "unsupported message type" }));
  }

  async #claim(socket: AwsRuntimeSocket, attachment: RuntimeAttachment): Promise<void> {
    const now = this.#now();
    const owned = await this.#jobs(
      `SELECT ${jobProjection()} FROM ${tables.jobs}
       WHERE claw_id = $1 AND status = 'offered' AND runtime_id = $2 AND expires_at > $3
       ORDER BY created_at, id LIMIT 1`,
      [this.#clawId, attachment.runtimeId, now],
    );
    if (owned[0]) {
      await this.#sendOffer(socket, attachment, owned[0]);
      return;
    }
    const offered = await this.#pool.query<{ id: string }>(
      `WITH candidate AS (
         SELECT id FROM ${tables.jobs}
         WHERE claw_id = $1 AND status = 'pending' AND expires_at > $3
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE ${tables.jobs} AS job
       SET status = 'offered', runtime_id = $2, claimed_at = $3
       FROM candidate
       WHERE job.claw_id = $1 AND job.id = candidate.id AND job.status = 'pending'
       RETURNING job.id`,
      [this.#clawId, attachment.runtimeId, now],
    );
    console.log(JSON.stringify({
      event: "runtime_claim_received",
      runtimeId: attachment.runtimeId,
      available: Boolean(offered.rows[0]),
    }));
    if (!offered.rows[0]) {
      socket.send(JSON.stringify({ type: "job.none" }));
      return;
    }
    // Preserve the existing two-message claim handshake. The retry causes the
    // runtime to claim again; that second claim reads and sends its owned offer.
    socket.send(JSON.stringify({ type: "job.retry" }));
  }

  async #sendOffer(socket: AwsRuntimeSocket, attachment: RuntimeAttachment, job: JobRow): Promise<void> {
    try {
      const payload = await decryptTurnPayload<TurnPayload>(
        this.#vaultMasterKey,
        job.id,
        job.payload_envelope ?? "",
      );
      if (!payload.turnToken) throw new Error("turn token is missing from encrypted payload");
      const encoded = Buffer.from(JSON.stringify({
        type: "job.turn",
        id: job.id,
        prompt: payload.prompt,
        requesterId: job.requester_id,
        personaId: job.persona_id,
        turnToken: payload.turnToken,
        sessionId: sessionId(job),
      }), "utf8").toString("base64url");
      const chunks = encoded.match(/.{1,512}/gu) ?? [];
      socket.send(JSON.stringify({ type: "job.preparing", id: job.id }));
      socket.send(JSON.stringify({ type: "job.turn.start", id: job.id, chunks: chunks.length }));
      for (let index = 0; index < chunks.length; index += 1) {
        socket.send(JSON.stringify({ type: "job.turn.chunk", id: job.id, index, data: chunks[index] }));
      }
      socket.send(JSON.stringify({ type: "job.turn.ready", id: job.id }));
      console.log(JSON.stringify({ event: "runtime_offer_sent", jobId: job.id, runtimeId: attachment.runtimeId }));
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "payload failure";
      console.error(JSON.stringify({
        event: "runtime_offer_failed",
        jobId: job.id,
        runtimeId: attachment.runtimeId,
        error: message,
      }));
      await this.#pool.query(
        `UPDATE ${tables.jobs}
         SET status = 'pending', runtime_id = NULL, claimed_at = NULL
         WHERE claw_id = $1 AND id = $2 AND status = 'offered' AND runtime_id = $3`,
        [this.#clawId, job.id, attachment.runtimeId],
      );
      try {
        socket.send(JSON.stringify({ type: "job.retry" }));
      } catch {
        // Socket detachment releases any remaining offer.
      }
      await this.#scheduleCleanup();
    }
  }

  async #refreshRuntime(
    socket: AwsRuntimeSocket,
    attachment: RuntimeAttachment,
    attempt = 0,
  ): Promise<void> {
    const now = this.#now();
    if (await this.#isRemoved()) {
      this.#rejectRuntimeRefresh(socket);
      return;
    }
    const currentResult = await this.#pool.query<RefreshRow>(
      `SELECT expires_at::text AS expires_at, consumed_at::text AS consumed_at, response_envelope
       FROM ${tables.refreshes} WHERE claw_id = $1 AND jti = $2`,
      [this.#clawId, attachment.refreshJti],
    );
    const current = currentResult.rows[0];
    if (!current || decodeInteger(current.expires_at, "runtime refresh expiry") <= now) {
      socket.send(JSON.stringify({ type: "runtime.error", error: "runtime refresh was already used" }));
      socket.close(4003, "runtime refresh rejected");
      return;
    }
    if (current.response_envelope) {
      const replay = await decryptTurnPayload<{ token: string; expiresInSeconds: number }>(
        this.#vaultMasterKey,
        `runtime-refresh:${attachment.refreshJti}`,
        current.response_envelope,
      );
      const next = await verifyClaims<RuntimeClaims>(
        this.#runtimeSigningSecret,
        replay.token,
        { typ: "runtime", aud: "crabhelm-runtime" },
      );
      attachment.refreshJti = next.jti;
      socket.send(JSON.stringify({ type: "runtime.token", ...replay }));
      return;
    }

    const token = await signClaims<RuntimeClaims>(this.#runtimeSigningSecret, {
      typ: "runtime",
      aud: "crabhelm-runtime",
      clawId: this.#clawId,
      runtimeId: attachment.runtimeId,
    }, 10 * 60);
    const next = await verifyClaims<RuntimeClaims>(
      this.#runtimeSigningSecret,
      token,
      { typ: "runtime", aud: "crabhelm-runtime" },
    );
    const response = { token, expiresInSeconds: 10 * 60 };
    const envelope = await encryptTurnPayload(
      this.#vaultMasterKey,
      `runtime-refresh:${attachment.refreshJti}`,
      response,
    );
    const rotated = await this.#transaction(async (client) => {
      if (await this.#isRemoved(client)) return "removed" as const;
      const updated = await client.query(
        `UPDATE ${tables.refreshes}
         SET consumed_at = COALESCE(consumed_at, $3), response_envelope = $4
         WHERE claw_id = $1 AND jti = $2 AND response_envelope IS NULL AND expires_at > $3`,
        [this.#clawId, attachment.refreshJti, now, envelope],
      );
      if (rowCount(updated) !== 1) return "contended" as const;
      await client.query(
        `INSERT INTO ${tables.refreshes} (claw_id, jti, expires_at) VALUES ($1, $2, $3)`,
        [this.#clawId, next.jti, next.exp * 1000],
      );
      return "rotated" as const;
    });
    if (rotated === "removed") {
      this.#rejectRuntimeRefresh(socket);
      return;
    }
    if (rotated === "contended") {
      if (attempt >= 3) throw new Error("runtime refresh contention did not converge");
      await this.#refreshRuntime(socket, attachment, attempt + 1);
      return;
    }
    attachment.refreshJti = next.jti;
    await this.#scheduleCleanup();
    socket.send(JSON.stringify({ type: "runtime.token", ...response }));
  }

  async #start(
    socket: AwsRuntimeSocket,
    attachment: RuntimeAttachment,
    input: Record<string, unknown>,
  ): Promise<void> {
    const id = typeof input.id === "string" ? input.id : "";
    console.log(JSON.stringify({
      event: "runtime_started_received",
      jobId: id || "invalid",
      runtimeId: attachment.runtimeId,
    }));
    const updated = id
      ? await this.#pool.query(
        `UPDATE ${tables.jobs}
         SET status = 'running', claimed_at = $4
         WHERE claw_id = $1 AND id = $2 AND status = 'offered' AND runtime_id = $3`,
        [this.#clawId, id, attachment.runtimeId, this.#now()],
      )
      : undefined;
    if (rowCount(updated) !== 1) {
      const existing = id
        ? await this.#pool.query<{ status: string; runtime_id: string | null }>(
          `SELECT status, runtime_id FROM ${tables.jobs} WHERE claw_id = $1 AND id = $2`,
          [this.#clawId, id],
        )
        : undefined;
      if (existing?.rows[0]?.status === "running" && existing.rows[0].runtime_id === attachment.runtimeId) {
        socket.send(JSON.stringify({ type: "job.started.ack", id }));
        return;
      }
      socket.send(JSON.stringify({ type: "runtime.error", error: "job offer is not owned by this runtime" }));
      return;
    }
    socket.send(JSON.stringify({ type: "job.started.ack", id }));
  }

  async #complete(
    socket: AwsRuntimeSocket,
    attachment: RuntimeAttachment,
    input: Record<string, unknown>,
  ): Promise<void> {
    const id = typeof input.id === "string" ? input.id : "";
    const ok = input.ok === true;
    const output = typeof input.output === "string" ? input.output.trim() : "";
    const error = typeof input.error === "string" ? input.error.trim().slice(0, 500) : "runtime turn failed";
    if (!id || (ok && (!output || Buffer.byteLength(output, "utf8") > 24 * 1024))) {
      socket.send(JSON.stringify({ type: "runtime.error", error: "invalid completion" }));
      return;
    }
    const existing = await this.#job(id);
    if (
      existing &&
      (existing.status === "completed" || existing.status === "failed") &&
      existing.runtime_id === attachment.runtimeId
    ) {
      if (existing.delivery_status === "pending") await this.#deliver(existing);
      socket.send(JSON.stringify({ type: "job.ack", id }));
      return;
    }
    if (!existing || existing.status !== "running" || existing.runtime_id !== attachment.runtimeId) {
      console.warn(JSON.stringify({
        event: "runtime_completion_rejected",
        jobId: id,
        runtimeId: attachment.runtimeId,
        status: existing?.status ?? "missing",
        owner: existing?.runtime_id ?? "missing",
      }));
      socket.send(JSON.stringify({ type: "runtime.error", error: "job is not owned by this runtime" }));
      return;
    }
    const response = ok ? output : "Crabhelm could not complete this request. Please retry.";
    const envelope = await encryptTurnPayload(
      this.#vaultMasterKey,
      `${id}:response`,
      { prompt: response } satisfies TurnPayload,
    );
    const completed = await this.#pool.query<JobDatabaseRow>(
      `UPDATE ${tables.jobs}
       SET status = $4, completed_at = $5, response_envelope = $6,
           payload_envelope = NULL, delivery_status = 'pending', error = $7
       WHERE claw_id = $1 AND id = $2 AND runtime_id = $3 AND status = 'running'
       RETURNING ${jobProjection()}`,
      [this.#clawId, id, attachment.runtimeId, ok ? "completed" : "failed", this.#now(), envelope, ok ? null : error],
    );
    const job = completed.rows[0] ? decodeJob(completed.rows[0]) : undefined;
    if (!job) {
      socket.send(JSON.stringify({ type: "runtime.error", error: "job is not owned by this runtime" }));
      return;
    }
    console.log(JSON.stringify({ event: "runtime_completion_recorded", jobId: id, runtimeId: attachment.runtimeId, ok }));
    await this.#deliver(job);
    socket.send(JSON.stringify({ type: "job.ack", id }));
    if (await this.#pendingCount() > 0) socket.send(JSON.stringify({ type: "job.available" }));
  }

  async #failJob(job: JobRow, reason: string, now = this.#now()): Promise<boolean> {
    const envelope = await encryptTurnPayload(
      this.#vaultMasterKey,
      `${job.id}:response`,
      { prompt: "Crabhelm could not complete this request. Please retry." } satisfies TurnPayload,
    );
    const result = await this.#pool.query<JobDatabaseRow>(
      `UPDATE ${tables.jobs}
       SET status = 'failed', completed_at = $3, response_envelope = $4,
           payload_envelope = NULL, delivery_status = 'pending', error = $5
       WHERE claw_id = $1 AND id = $2 AND status = 'running'
       RETURNING ${jobProjection()}`,
      [this.#clawId, job.id, now, envelope, reason.slice(0, 500)],
    );
    const failed = result.rows[0] ? decodeJob(result.rows[0]) : undefined;
    if (!failed) return false;
    await this.#deliver(failed, now);
    return true;
  }

  async #expireJob(job: JobRow, now: number): Promise<void> {
    const envelope = await encryptTurnPayload(
      this.#vaultMasterKey,
      `${job.id}:response`,
      { prompt: "This request expired before the teammate could process it. Please retry." } satisfies TurnPayload,
    );
    const result = await this.#pool.query<JobDatabaseRow>(
      `UPDATE ${tables.jobs}
       SET status = 'failed', completed_at = $3, response_envelope = $4,
           payload_envelope = NULL, delivery_status = 'pending', error = 'turn expired'
       WHERE claw_id = $1 AND id = $2 AND status IN ('pending', 'offered')
       RETURNING ${jobProjection()}`,
      [this.#clawId, job.id, now, envelope],
    );
    if (result.rows[0]) await this.#deliver(decodeJob(result.rows[0]), now);
  }

  async #deliver(candidate: JobRow, now = this.#now()): Promise<void> {
    const claimedResult = await this.#pool.query<JobDatabaseRow>(
      `UPDATE ${tables.jobs}
       SET delivery_status = 'delivering', delivery_owner = $3, delivery_claimed_at = $4
       WHERE claw_id = $1 AND id = $2
         AND (delivery_status = 'pending'
           OR (delivery_status = 'delivering' AND delivery_claimed_at < $5))
       RETURNING ${jobProjection()}`,
      [this.#clawId, candidate.id, this.#deliveryOwner, now, now - deliveryLeaseMs],
    );
    const job = claimedResult.rows[0] ? decodeJob(claimedResult.rows[0]) : undefined;
    if (!job) return;

    let source: SlackTurnSource;
    try {
      source = decodeSlackSource(job.source_json);
    } catch {
      await this.#markDeliveryFailed(job.id);
      return;
    }
    if (!this.#slackBotToken?.trim()) {
      await this.#markDeliveryFailed(job.id);
      return;
    }
    try {
      const payload = await decryptTurnPayload<TurnPayload>(
        this.#vaultMasterKey,
        `${job.id}:response`,
        job.response_envelope ?? "",
      );
      const response = await this.#fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${this.#slackBotToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: source.channelId,
          thread_ts: source.threadTs,
          text: payload.prompt,
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
      const result = await boundedSlackResponse(response);
      if (!response.ok || result.ok !== true) throw slackDeliveryError(response.status, result.error);
      await this.#pool.query(
        `UPDATE ${tables.jobs}
         SET delivery_status = 'delivered', delivery_owner = NULL, delivery_claimed_at = NULL,
             payload_envelope = NULL, response_envelope = NULL
         WHERE claw_id = $1 AND id = $2 AND delivery_status = 'delivering' AND delivery_owner = $3`,
        [this.#clawId, job.id, this.#deliveryOwner],
      );
    } catch (error) {
      const attempts = job.delivery_attempts + 1;
      const terminal = (error instanceof SlackDeliveryError && !error.retryable) || attempts >= 5;
      console.error(JSON.stringify({
        event: "slack_turn_delivery_failed",
        jobId: job.id,
        attempt: attempts,
        terminal,
        error: error instanceof Error ? error.message : String(error),
      }));
      await this.#pool.query(
        terminal
          ? `UPDATE ${tables.jobs}
             SET delivery_status = 'failed', delivery_attempts = $4,
                 delivery_owner = NULL, delivery_claimed_at = NULL,
                 payload_envelope = NULL, response_envelope = NULL
             WHERE claw_id = $1 AND id = $2 AND delivery_status = 'delivering' AND delivery_owner = $3`
          : `UPDATE ${tables.jobs}
             SET delivery_status = 'pending', delivery_attempts = $4,
                 delivery_owner = NULL, delivery_claimed_at = NULL
             WHERE claw_id = $1 AND id = $2 AND delivery_status = 'delivering' AND delivery_owner = $3`,
        [this.#clawId, job.id, this.#deliveryOwner, attempts],
      );
      if (!terminal) await this.#scheduleCleanup();
    }
  }

  async #markDeliveryFailed(id: string): Promise<void> {
    await this.#pool.query(
      `UPDATE ${tables.jobs}
       SET delivery_status = 'failed', delivery_owner = NULL, delivery_claimed_at = NULL,
           payload_envelope = NULL, response_envelope = NULL
       WHERE claw_id = $1 AND id = $2 AND delivery_status = 'delivering' AND delivery_owner = $3`,
      [this.#clawId, id, this.#deliveryOwner],
    );
  }

  async #detachSocket(socket: AwsRuntimeSocket): Promise<void> {
    const attachment = this.#sockets.get(socket);
    if (!attachment) return;
    this.#sockets.delete(socket);
    await this.#releaseOffers(attachment);
    if (await this.#hasWork()) await this.#scheduleCleanup();
  }

  async #releaseOffers(attachment: RuntimeAttachment): Promise<void> {
    const released = await this.#pool.query(
      `UPDATE ${tables.jobs}
       SET status = 'pending', runtime_id = NULL, claimed_at = NULL
       WHERE claw_id = $1 AND status = 'offered' AND runtime_id = $2`,
      [this.#clawId, attachment.runtimeId],
    );
    console.log(JSON.stringify({
      event: "runtime_offers_released",
      runtimeId: attachment.runtimeId,
      count: rowCount(released),
    }));
  }

  #notifyAvailable(): void {
    for (const [socket, attachment] of this.#sockets) {
      if (attachment.disabled) continue;
      try {
        socket.send(JSON.stringify({ type: "job.available" }));
      } catch {
        // Detachment or polling recovers the notification.
      }
    }
  }

  #bindSocket(socket: AwsRuntimeSocket): void {
    if (socket.on) {
      socket.on("message", (data, isBinary) => {
        const message = isBinary === true ? toArrayBuffer(data) : socketText(data);
        this.#handleSocketEvent(this.webSocketMessage(socket, message), socket);
      });
      socket.on("close", () => this.#handleSocketEvent(this.webSocketClose(socket), socket));
      socket.on("error", () => this.#handleSocketEvent(this.webSocketError(socket), socket));
      return;
    }
    if (socket.addEventListener) {
      socket.addEventListener("message", (event) => {
        const data = event && typeof event === "object" && "data" in event
          ? (event as { data: unknown }).data
          : event;
        const message = typeof data === "string" ? data : toArrayBuffer(data);
        this.#handleSocketEvent(this.webSocketMessage(socket, message), socket);
      });
      socket.addEventListener("close", () => this.#handleSocketEvent(this.webSocketClose(socket), socket));
      socket.addEventListener("error", () => this.#handleSocketEvent(this.webSocketError(socket), socket));
    }
  }

  #handleSocketEvent(operation: Promise<void>, socket: AwsRuntimeSocket): void {
    void operation.catch((error: unknown) => {
      console.error(JSON.stringify({
        event: "aws_runtime_socket_failed",
        clawId: this.#clawId,
        error: error instanceof Error ? error.message.slice(0, 500) : "runtime socket failure",
      }));
      try {
        socket.close(1011, "runtime coordinator failed");
      } catch {
        // The socket may already be closed.
      }
    });
  }

  #socketAttachment(socket: AwsRuntimeSocket): RuntimeAttachment {
    const attachment = this.#sockets.get(socket);
    if (!attachment) throw new Error("runtime socket attachment is invalid");
    return attachment;
  }

  async #resetGeneration(): Promise<number> {
    const result = await this.#pool.query<CoordinatorStateRow>(
      `INSERT INTO ${tables.claws} (claw_id, reset_generation) VALUES ($1, 0)
       ON CONFLICT (claw_id) DO UPDATE SET claw_id = EXCLUDED.claw_id
       RETURNING reset_generation::text AS reset_generation`,
      [this.#clawId],
    );
    return decodeInteger(result.rows[0]?.reset_generation, "runtime reset generation");
  }

  async #incrementResetGeneration(): Promise<number> {
    const result = await this.#pool.query<CoordinatorStateRow>(
      `INSERT INTO ${tables.claws} (claw_id, reset_generation) VALUES ($1, 1)
       ON CONFLICT (claw_id) DO UPDATE SET reset_generation = ${tables.claws}.reset_generation + 1
       RETURNING reset_generation::text AS reset_generation`,
      [this.#clawId],
    );
    return decodeInteger(result.rows[0]?.reset_generation, "runtime reset generation");
  }

  async #isRemoved(client: Pick<PoolClient, "query"> | Pool = this.#pool): Promise<boolean> {
    const result = await client.query(
      `SELECT removed_at::text AS removed_at FROM ${tables.claws} WHERE claw_id = $1`,
      [this.#clawId],
    ) as { rows: CoordinatorRemovalRow[] };
    return result.rows[0]?.removed_at !== null && result.rows[0]?.removed_at !== undefined;
  }

  async #assertActive(client: Pick<PoolClient, "query"> | Pool = this.#pool): Promise<void> {
    if (await this.#isRemoved(client)) throw new Error("claw has been removed");
  }

  #rejectRuntimeRefresh(socket: AwsRuntimeSocket): void {
    socket.send(JSON.stringify({ type: "runtime.error", error: "runtime refresh was already used" }));
    socket.close(4003, "runtime refresh rejected");
  }

  async #pendingCount(): Promise<number> {
    return this.#count("pending");
  }

  async #count(status: string): Promise<number> {
    const result = await this.#pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count FROM ${tables.jobs} WHERE claw_id = $1 AND status = $2`,
      [this.#clawId, status],
    );
    return decodeCount(result.rows[0]?.count);
  }

  async #hasWork(): Promise<boolean> {
    const result = await this.#pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count FROM ${tables.jobs}
       WHERE claw_id = $1
         AND (status IN ('pending', 'offered', 'running') OR delivery_status IN ('pending', 'delivering'))`,
      [this.#clawId],
    );
    return decodeCount(result.rows[0]?.count) > 0;
  }

  async #job(id: string): Promise<JobRow | undefined> {
    const jobs = await this.#jobs(
      `SELECT ${jobProjection()} FROM ${tables.jobs} WHERE claw_id = $1 AND id = $2`,
      [this.#clawId, id],
    );
    return jobs[0];
  }

  async #jobs(sql: string, values: unknown[]): Promise<JobRow[]> {
    const result = await this.#pool.query<JobDatabaseRow>(sql, values);
    return result.rows.map(decodeJob);
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `crabhelm:coordinator:${this.#clawId}`,
      ]);
      try {
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the operation error if PostgreSQL already aborted.
        }
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async #scheduleCleanup(): Promise<void> {
    if (!this.#scheduleCleanupCallback) return;
    const at = this.#now() + 60_000;
    await this.#scheduleCleanupCallback(this.#clawId, at);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(
      () => operation(),
      () => operation(),
    );
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function jobProjection(): string {
  return [
    "id",
    "event_id",
    "claw_id",
    "requester_id",
    "persona_id",
    "status",
    "payload_envelope",
    "source_json",
    "runtime_id",
    "response_envelope",
    "delivery_status",
    "delivery_owner",
    "delivery_claimed_at::text AS delivery_claimed_at",
    "delivery_attempts",
    "created_at::text AS created_at",
    "claimed_at::text AS claimed_at",
    "completed_at::text AS completed_at",
    "expires_at::text AS expires_at",
    "error",
  ].join(", ");
}

function decodeJob(row: JobDatabaseRow): JobRow {
  return {
    ...row,
    delivery_claimed_at: decodeNullableInteger(row.delivery_claimed_at, "delivery claim time"),
    delivery_attempts: decodeInteger(row.delivery_attempts, "delivery attempts"),
    created_at: decodeInteger(row.created_at, "job creation time"),
    claimed_at: decodeNullableInteger(row.claimed_at, "job claim time"),
    completed_at: decodeNullableInteger(row.completed_at, "job completion time"),
    expires_at: decodeInteger(row.expires_at, "job expiry"),
  };
}

function rowCount(result: { rowCount?: number | null } | undefined): number {
  return result?.rowCount ?? 0;
}

function decodeCount(value: unknown): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("PostgreSQL count is invalid");
  return count;
}

function decodeInteger(value: unknown, label: string): number {
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded) || decoded < 0) throw new Error(`${label} is invalid`);
  return decoded;
}

function decodeNullableInteger(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : decodeInteger(value, label);
}

async function boundedSlackResponse(response: Response): Promise<{ ok?: boolean; error?: string }> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 128 * 1024) throw new Error("Slack delivery response is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 128 * 1024) throw new Error("Slack delivery response is too large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as { ok?: boolean; error?: string };
  } catch {
    throw new Error(`Slack delivery returned invalid JSON (${response.status})`);
  }
}

class SlackDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

function slackDeliveryError(status: number, code?: string): SlackDeliveryError {
  return new SlackDeliveryError(
    `Slack delivery failed: ${code ?? status}`,
    slackDeliveryRetryable(status, code),
  );
}

function validateAttachment(input: RuntimeAttachment, clawId: string): void {
  if (input.clawId !== clawId) throw new Error("runtime socket claw identity does not match coordinator");
  requireIdentifier(input.runtimeId, "runtime id", 500);
  requireIdentifier(input.refreshJti, "runtime refresh id", 500);
}

function validateTurn(input: EnqueueTurnInput, clawId: string, now: number): void {
  if (input.clawId !== clawId) throw new Error("turn claw identity does not match coordinator");
  requireIdentifier(input.id, "turn id", 200);
  requireIdentifier(input.eventId, "turn event id", 500);
  requireIdentifier(input.requesterId, "turn requester id", 500);
  requireIdentifier(input.personaId, "turn persona id", 500);
  requireIdentifier(input.turnToken, "turn token", 20_000);
  if (!input.prompt.trim() || Buffer.byteLength(input.prompt, "utf8") > 48 * 1024) {
    throw new Error("turn prompt is invalid");
  }
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + 60 * 60 * 1000) {
    throw new Error("turn expiry is invalid");
  }
  if (
    input.source.surface !== "slack" ||
    !input.source.workspaceId ||
    !input.source.channelId ||
    !input.source.threadTs
  ) {
    throw new Error("turn source is invalid");
  }
}

function validateGrant(input: GrantRegistration, now: number): void {
  requireIdentifier(input.invocationId, "grant invocation id", 500);
  requireIdentifier(input.jti, "grant id", 500);
  if (!/^[0-9a-f]{64}$/u.test(input.argumentsDigest)) throw new Error("grant registration is invalid");
  requireFutureTimestamp(input.expiresAt, now, "grant registration");
}

function validateFence(
  input: { jti: string; expiresAt: number },
  label: string,
  now: number,
): void {
  requireIdentifier(input.jti, `${label} id`, 500);
  requireFutureTimestamp(input.expiresAt, now, label);
}

function requireFutureTimestamp(value: number, now: number, label: string): void {
  if (!Number.isInteger(value) || value <= now) throw new Error(`${label} is invalid`);
}

function requireTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

function requireIdentifier(value: string, label: string, maxLength: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
}

function decodeSlackSource(value: unknown): SlackTurnSource {
  const source = typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("turn source is invalid");
  const record = source as Record<string, unknown>;
  if (
    record.surface !== "slack" ||
    typeof record.workspaceId !== "string" || !record.workspaceId ||
    typeof record.channelId !== "string" || !record.channelId ||
    typeof record.threadTs !== "string" || !record.threadTs
  ) {
    throw new Error("turn source is invalid");
  }
  return {
    surface: "slack",
    workspaceId: record.workspaceId,
    channelId: record.channelId,
    threadTs: record.threadTs,
  };
}

function sessionId(job: JobRow): string {
  const source = decodeSlackSource(job.source_json);
  return `crabhelm-slack-${source.workspaceId}-${source.channelId}-${source.threadTs}`
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .slice(0, 180);
}

function socketText(value: unknown): string | ArrayBuffer {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return toArrayBuffer(value);
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer;
  }
  return new ArrayBuffer(0);
}
