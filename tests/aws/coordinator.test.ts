import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Pool } from "pg";
import {
  AwsCoordinatorDirectory,
  type AwsRuntimeSocket,
} from "../../aws/postgres-coordinator.js";
import { decryptTurnPayload } from "../../worker/turn-envelope.js";

const now = 1_800_000_000_000;
const vaultMasterKey = Buffer.alloc(32, 7).toString("base64url");
const runtimeSigningSecret = "r".repeat(32);

type RecordedQuery = { sql: string; values: unknown[] };
type FakeResponse = { rows?: unknown[]; rowCount?: number | null };
type FakeResponder = (query: RecordedQuery) => FakeResponse;

class FakePool {
  readonly queries: RecordedQuery[] = [];
  readonly #respond: FakeResponder;

  constructor(respond: FakeResponder = () => ({ rows: [], rowCount: 0 })) {
    this.#respond = respond;
  }

  async query(sql: string, values: unknown[] = []): Promise<unknown> {
    const query = { sql: sql.replace(/\s+/gu, " ").trim(), values };
    this.queries.push(query);
    const response = this.#respond(query);
    return {
      command: "",
      fields: [],
      oid: 0,
      rows: response.rows ?? [],
      rowCount: response.rowCount ?? 0,
    };
  }

  async connect(): Promise<unknown> {
    return {
      query: (sql: string, values: unknown[] = []) => this.query(sql, values),
      release() {},
    };
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

class FakeSocket implements AwsRuntimeSocket {
  readonly sent: string[] = [];
  readonly closes: Array<[number | undefined, string | undefined]> = [];
  readonly listeners = new Map<string, Array<(...arguments_: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
  }

  on(event: string, listener: (...arguments_: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }
}

function directory(pool: FakePool): AwsCoordinatorDirectory {
  return new AwsCoordinatorDirectory({
    pool: pool.asPool(),
    vaultMasterKey,
    runtimeSigningSecret,
    now: () => now,
  });
}

test("AWS coordinator directory caches one coordinator per exact claw id", () => {
  const coordinators = directory(new FakePool());
  assert.strictEqual(coordinators.getByName("claw-a"), coordinators.getByName("claw-a"));
  assert.notStrictEqual(coordinators.getByName("claw-a"), coordinators.getByName("claw-b"));
  assert.throws(() => coordinators.getByName(""), /claw id is invalid/u);
});

test("runtime ticket consumption is atomic and claw-fenced", async () => {
  let attempts = 0;
  const pool = new FakePool(({ sql }) => {
    if (sql.includes("SELECT removed_at::text AS removed_at")) return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE crabhelm_coordinator_runtime_tickets")) {
      return { rows: [], rowCount: attempts++ === 0 ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const coordinator = directory(pool).getByName("claw-a");

  assert.equal(await coordinator.consumeRuntimeTicket({ jti: "ticket-a", now }), true);
  assert.equal(await coordinator.consumeRuntimeTicket({ jti: "ticket-a", now }), false);
  assert.equal(await coordinator.consumeRuntimeTicket({ jti: "", now }), false);
  const updates = pool.queries.filter((query) => query.sql.includes("UPDATE crabhelm_coordinator_runtime_tickets"));
  assert.equal(updates.length, 2);

  const query = updates[0]!;
  assert.match(query.sql, /UPDATE crabhelm_coordinator_runtime_tickets/u);
  assert.match(query.sql, /claw_id = \$1 AND jti = \$2/u);
  assert.match(query.sql, /consumed_at IS NULL AND expires_at > \$3/u);
  assert.deepEqual(query.values, ["claw-a", "ticket-a", now]);
});

test("turn enqueue encrypts the bearer token and stores only a redacted marker", async () => {
  const turnToken = "turn-secret-token";
  const pool = new FakePool(({ sql }) => {
    if (sql.includes("SELECT removed_at::text AS removed_at")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO crabhelm_coordinator_turn_jobs")) {
      return { rows: [{ id: "job-a" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const coordinator = directory(pool).getByName("claw-a");

  assert.deepEqual(await coordinator.enqueueTurn({
    id: "job-a",
    eventId: "event-a",
    clawId: "claw-a",
    requesterId: "requester-a",
    personaId: "persona-a",
    prompt: "hello",
    turnToken,
    source: {
      surface: "slack",
      workspaceId: "workspace-a",
      channelId: "channel-a",
      threadTs: "thread-a",
    },
    expiresAt: now + 60_000,
  }), { id: "job-a", duplicate: false });

  const insert = pool.queries.find((query) => query.sql.startsWith("INSERT INTO crabhelm_coordinator_turn_jobs"));
  assert.ok(insert);
  assert.equal(insert.values[5], "[encrypted]");
  assert.equal(JSON.stringify(insert.values).includes(turnToken), false);
  const payload = await decryptTurnPayload<{ prompt: string; turnToken: string }>(
    vaultMasterKey,
    "job-a",
    String(insert.values[6]),
  );
  assert.deepEqual(payload, { prompt: "hello", turnToken });

  const begin = pool.queries.findIndex((query) => query.sql === "BEGIN");
  const activeCheck = pool.queries.findIndex((query) => query.sql.includes("SELECT removed_at::text AS removed_at"));
  const insertIndex = pool.queries.indexOf(insert);
  const commit = pool.queries.findIndex((query) => query.sql === "COMMIT");
  assert.ok(begin >= 0 && activeCheck > begin && insertIndex > activeCheck && commit > insertIndex);
});

test("socket attach rejects cross-claw identity and replaces only the same runtime", async () => {
  const pool = new FakePool(({ sql }) => {
    if (sql.includes("RETURNING reset_generation::text")) {
      return { rows: [{ reset_generation: "0" }], rowCount: 1 };
    }
    if (sql.includes("AS pending") && sql.includes("AS awaiting_delivery")) {
      return { rows: [{ pending: "0", running: "0", awaiting_delivery: "0" }], rowCount: 1 };
    }
    if (sql.includes("COUNT(*)::text AS count")) {
      return { rows: [{ count: "0" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const coordinator = directory(pool).getByName("claw-a");
  const wrong = new FakeSocket();
  await assert.rejects(
    coordinator.attachSocket(wrong, { runtimeId: "runtime-a", clawId: "claw-b", refreshJti: "refresh-a" }),
    /does not match coordinator/u,
  );
  assert.equal(wrong.sent.length, 0);

  const first = new FakeSocket();
  await coordinator.attachSocket(first, {
    runtimeId: "runtime-a",
    clawId: "claw-a",
    refreshJti: "refresh-a",
  });
  assert.deepEqual(JSON.parse(first.sent[0]!), {
    type: "runtime.ready",
    clawId: "claw-a",
    resetGeneration: 0,
  });

  const replacement = new FakeSocket();
  await coordinator.attachSocket(replacement, {
    runtimeId: "runtime-a",
    clawId: "claw-a",
    refreshJti: "refresh-b",
  });
  assert.deepEqual(first.closes, [[4001, "runtime reconnected"]]);

  const peer = new FakeSocket();
  await coordinator.attachSocket(peer, {
    runtimeId: "runtime-b",
    clawId: "claw-a",
    refreshJti: "refresh-c",
  });
  assert.deepEqual(replacement.closes, []);
  assert.deepEqual(peer.closes, []);
  assert.equal((await coordinator.runtimeStatus()).connected, 2);
});

test("removal tombstones the claw and atomically revokes runtime credentials", async () => {
  let removed = false;
  const pool = new FakePool(({ sql, values }) => {
    if (sql.includes("INSERT INTO crabhelm_coordinator_claws") && sql.includes("removed_at")) {
      if (values[0] === "claw-a") removed = true;
      return { rowCount: 1 };
    }
    if (sql.includes("SELECT removed_at::text AS removed_at")) {
      return removed && values[0] === "claw-a"
        ? { rows: [{ removed_at: String(now) }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("RETURNING reset_generation::text")) {
      return { rows: [{ reset_generation: "0" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE crabhelm_coordinator_turn_jobs") && sql.includes("RETURNING id")) {
      return { rows: [{ id: "job-a" }, { id: "job-b" }], rowCount: 2 };
    }
    if (sql.includes("COUNT(*)::text AS count")) {
      return { rows: [{ count: "0" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const coordinators = directory(pool);
  const coordinator = coordinators.getByName("claw-a");
  const grant = {
    invocationId: "invocation-before",
    jti: "grant-before",
    argumentsDigest: "a".repeat(64),
    expiresAt: now + 60_000,
  };

  await coordinator.registerGrant(grant);
  await coordinator.registerRuntimeRefresh({ jti: "refresh-before", expiresAt: now + 60_000 });
  await coordinator.registerRuntimeTicket({ jti: "ticket-before", expiresAt: now + 60_000 });
  const socket = new FakeSocket();
  await coordinator.attachSocket(socket, {
    runtimeId: "runtime-a",
    clawId: "claw-a",
    refreshJti: "refresh-before",
  });

  assert.equal(await coordinator.prepareForRemoval(), 2);
  assert.deepEqual(socket.closes, [[4002, "claw removal requested"]]);

  const removalQueries = pool.queries.map((query) => query.sql);
  const tombstone = removalQueries.findIndex((sql) => sql.includes("removed_at = COALESCE"));
  const grantRevoke = removalQueries.findIndex((sql) => sql === "DELETE FROM crabhelm_coordinator_grants WHERE claw_id = $1");
  const refreshRevoke = removalQueries.findIndex((sql) => sql === "DELETE FROM crabhelm_coordinator_runtime_refreshes WHERE claw_id = $1");
  const ticketRevoke = removalQueries.findIndex((sql) => sql === "DELETE FROM crabhelm_coordinator_runtime_tickets WHERE claw_id = $1");
  const jobRevoke = removalQueries.findIndex((sql) => sql.includes("UPDATE crabhelm_coordinator_turn_jobs") && sql.includes("RETURNING id"));
  const begin = removalQueries.slice(0, tombstone).lastIndexOf("BEGIN");
  const commitOffset = removalQueries.slice(jobRevoke + 1).indexOf("COMMIT");
  const commit = commitOffset < 0 ? -1 : jobRevoke + 1 + commitOffset;
  assert.ok(begin >= 0);
  assert.ok(tombstone >= 0);
  assert.ok(grantRevoke > tombstone);
  assert.ok(refreshRevoke > grantRevoke);
  assert.ok(ticketRevoke > refreshRevoke);
  assert.ok(jobRevoke > ticketRevoke);
  assert.ok(commit > jobRevoke);

  await assert.rejects(
    coordinator.registerGrant({ ...grant, invocationId: "invocation-after", jti: "grant-after" }),
    /claw has been removed/u,
  );
  assert.equal(await coordinator.consumeGrant(grant), false);
  await assert.rejects(
    coordinator.attachSocket(new FakeSocket(), {
      runtimeId: "runtime-b",
      clawId: "claw-a",
      refreshJti: "refresh-after",
    }),
    /claw has been removed/u,
  );
  await assert.rejects(
    coordinator.registerRuntimeRefresh({ jti: "refresh-after", expiresAt: now + 60_000 }),
    /claw has been removed/u,
  );
  await assert.rejects(
    coordinator.registerRuntimeTicket({ jti: "ticket-after", expiresAt: now + 60_000 }),
    /claw has been removed/u,
  );
  await assert.rejects(
    coordinator.enqueueTurn({
      id: "job-after",
      eventId: "event-after",
      clawId: "claw-a",
      requesterId: "requester-after",
      personaId: "persona-after",
      prompt: "hello",
      turnToken: "turn-after",
      source: {
        surface: "slack",
        workspaceId: "workspace-a",
        channelId: "channel-a",
        threadTs: "thread-a",
      },
      expiresAt: now + 60_000,
    }),
    /claw has been removed/u,
  );
  assert.equal(await coordinator.consumeRuntimeTicket({ jti: "ticket-before", now }), false);

  await coordinator.cancelActiveTurns();
  await assert.rejects(
    coordinator.attachSocket(new FakeSocket(), {
      runtimeId: "runtime-after-reset",
      clawId: "claw-a",
      refreshJti: "refresh-after-reset",
    }),
    /claw has been removed/u,
  );
  const recreated = new FakeSocket();
  await coordinators.getByName("claw-b").attachSocket(recreated, {
    runtimeId: "runtime-new-claw",
    clawId: "claw-b",
    refreshJti: "refresh-new-claw",
  });
  assert.equal(JSON.parse(recreated.sent[0]!).clawId, "claw-b");

  const postRemovalInserts = pool.queries.filter((query) =>
    (query.sql.startsWith("INSERT INTO crabhelm_coordinator_runtime_refreshes") && query.values[1] === "refresh-after") ||
    (query.sql.startsWith("INSERT INTO crabhelm_coordinator_runtime_tickets") && query.values[1] === "ticket-after") ||
    query.sql.startsWith("INSERT INTO crabhelm_coordinator_turn_jobs")
  );
  assert.deepEqual(postRemovalInserts, []);
});

test("runtime refresh rotation rejects a persistently removed claw", async () => {
  let removed = false;
  const pool = new FakePool(({ sql }) => {
    if (sql.includes("SELECT removed_at::text AS removed_at")) {
      return removed
        ? { rows: [{ removed_at: String(now) }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("RETURNING reset_generation::text")) {
      return { rows: [{ reset_generation: "0" }], rowCount: 1 };
    }
    if (sql.includes("COUNT(*)::text AS count")) {
      return { rows: [{ count: "0" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const coordinator = directory(pool).getByName("claw-a");
  const socket = new FakeSocket();
  await coordinator.attachSocket(socket, {
    runtimeId: "runtime-a",
    clawId: "claw-a",
    refreshJti: "refresh-a",
  });

  removed = true;
  await coordinator.webSocketMessage(socket, JSON.stringify({ type: "runtime.refresh" }));

  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
    type: "runtime.error",
    error: "runtime refresh was already used",
  });
  assert.deepEqual(socket.closes, [[4003, "runtime refresh rejected"]]);
});

test("directory cleanup cursor-paginates every candidate in one sweep", async () => {
  const candidates = ["claw-a", "claw-b", "claw-c"];
  const pool = new FakePool(({ sql, values }) => {
    if (sql.startsWith("WITH candidates AS")) {
      const cursor = String(values[3]);
      const limit = Number(values[4]);
      const rows = candidates.filter((id) => id > cursor).slice(0, limit).map((claw_id) => ({ claw_id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("COUNT(*)::text AS count")) {
      return { rows: [{ count: "0" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  assert.equal(await directory(pool).cleanupSweep(2, now), 3);
  const pages = pool.queries.filter((query) => query.sql.startsWith("WITH candidates AS"));
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => page.values.slice(3, 5)), [["", 2], ["claw-b", 2]]);
  assert.deepEqual(pages.map((page) => page.values[5]), [now - 17 * 60 * 1000, now - 17 * 60 * 1000]);
  const stalled = pool.queries.find((query) =>
    query.sql.startsWith("SELECT id, event_id") && query.sql.includes("status = 'running' AND claimed_at <")
  );
  const expired = pool.queries.find((query) =>
    query.sql.startsWith("SELECT id, event_id") && query.sql.includes("status IN ('pending', 'offered') AND expires_at <=")
  );
  assert.match(stalled?.sql ?? "", /ORDER BY claimed_at, id LIMIT \$3/u);
  assert.deepEqual(stalled?.values.slice(1), [now - 17 * 60 * 1000, 100]);
  assert.match(expired?.sql ?? "", /ORDER BY expires_at, id LIMIT \$3/u);
  assert.deepEqual(expired?.values.slice(1), [now, 100]);
  assert.ok(pool.queries.some((query) =>
    query.sql.startsWith("UPDATE crabhelm_coordinator_runs") && query.sql.includes("status = 'running'")
  ));
});

test("coordinator tombstone migration persists removed state", async () => {
  const migration = await readFile(new URL("../../aws/migrations/0003_coordinator_tombstones.sql", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS removed_at BIGINT/u);
});

test("coordinator cleanup migration redacts tokens and indexes stale runs", async () => {
  const migration = await readFile(new URL("../../aws/migrations/0004_coordinator_cleanup.sql", import.meta.url), "utf8");
  assert.match(migration, /SET turn_token = '\[encrypted\]'/u);
  assert.match(migration, /CHECK \(turn_token = '\[encrypted\]'\)/u);
  assert.match(migration, /\(started_at, claw_id\)/u);
  assert.match(migration, /\(claw_id, expires_at, id\)/u);
  assert.match(migration, /WHERE status = 'running'/u);
});

test("AWS server runs cleanup on an independent periodic sweep", async () => {
  const source = await readFile(new URL("../../aws/server.ts", import.meta.url), "utf8");
  assert.match(source, /setInterval\(runCoordinatorSweep, coordinatorSweepIntervalMs\)/u);
  assert.doesNotMatch(source, /scheduleCleanup:\s*\(/u);
  assert.match(
    source,
    /createServer\(\{ maxHeaderSize: maxHttpHeaderBytes \}, listener\)/u,
    "Node must accept ALB's bounded aggregate request-header envelope",
  );
  assert.match(source, /const maxHttpHeaderBytes = 64 \* 1024;/u);
});
