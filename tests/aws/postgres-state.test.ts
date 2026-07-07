import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { PostgresStateDatabase } from "../../aws/postgres-state.js";

const connectionString = process.env.CRABHELM_TEST_POSTGRES_URL?.trim();
const pool = connectionString
  ? new (await import("pg")).Pool({ connectionString, max: 4 })
  : undefined;
const database = pool ? new PostgresStateDatabase(pool) : undefined;
const integration = { skip: !pool || !database };
const namespaceSuffix = `${process.pid}-${Date.now().toString(36)}`;
const namespaces = new Set<string>();

if (pool) {
  const migration = await readFile(
    fileURLToPath(new URL("../../aws/migrations/0001_state.sql", import.meta.url)),
    "utf8",
  );
  await pool.query(migration);
}

after(async () => {
  if (pool && namespaces.size) {
    await pool.query(
      "DELETE FROM crabhelm_state_entries WHERE namespace = ANY($1::text[])",
      [[...namespaces]],
    );
  }
  await pool?.end();
});

test("Postgres state store validates namespaces and limits without connecting", () => {
  const disconnected = new PostgresStateDatabase({} as Pool);
  assert.throws(() => disconnected.store("Invalid", 1), /namespace is invalid/u);
  assert.throws(() => disconnected.store("valid", 0), /maxEntries must be a positive integer/u);
});

test("Postgres state serializes outer operations before checking out pool clients", async () => {
  let connectCount = 0;
  let activeClients = 0;
  let maximumActiveClients = 0;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstReady = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const fakePool = {
    async connect() {
      connectCount += 1;
      activeClients += 1;
      maximumActiveClients = Math.max(maximumActiveClients, activeClients);
      return {
        async query() {
          return { rows: [], rowCount: 0 };
        },
        release() {
          activeClients -= 1;
        },
      };
    },
  } as unknown as Pool;
  const queued = new PostgresStateDatabase(fakePool);

  const first = queued.transaction(async () => queued.transaction(async () => {
    firstStarted();
    await firstGate;
  }));
  await firstReady;
  const second = queued.transaction(async () => undefined);
  await Promise.resolve();

  assert.equal(connectCount, 1);
  assert.equal(activeClients, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(connectCount, 2);
  assert.equal(maximumActiveClients, 1);
  assert.equal(activeClients, 0);
});

test("Postgres state store preserves JSON values and ordered entries", integration, async () => {
  const store = database!.store<{ value: number }>(namespace("ordered"), 3);
  await store.register("a", { value: 1 });
  await store.register("b", { value: 2 });

  assert.deepEqual(await store.lookup("a"), { value: 1 });
  assert.deepEqual((await store.entries()).map((entry) => entry.key), ["a", "b"]);
  assert.equal(await store.delete("a"), true);
  assert.equal(await store.delete("a"), false);
});

test("Postgres state store enforces caps and evicts the oldest entry", integration, async () => {
  const limited = database!.store<number>(namespace("limited"), 1);
  await limited.register("a", 1);
  await limited.register("a", 2);
  assert.equal(await limited.lookup("a"), 2);
  await assert.rejects(limited.register("b", 2), /entry limit exceeded \(1\)/u);

  const evicting = database!.store<number>(namespace("evicting"), 2, { overflow: "evict-oldest" });
  await evicting.register("a", 1);
  await evicting.register("b", 2);
  await evicting.register("c", 3);
  assert.deepEqual((await evicting.entries()).map((entry) => entry.key), ["b", "c"]);
});

test("Postgres state cap is atomic across database instances", integration, async () => {
  const name = namespace("concurrent");
  const first = database!.store<number>(name, 1);
  const second = new PostgresStateDatabase(pool!).store<number>(name, 1);
  const results = await Promise.allSettled([
    first.register("a", 1),
    second.register("b", 2),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await first.entries()).length, 1);
});

test("Postgres state transaction commits and rolls back across stores", integration, async () => {
  const first = database!.store<number>(namespace("first"), 10);
  const second = database!.store<number>(namespace("second"), 10);

  await database!.transaction(async () => {
    await first.register("committed", 1);
    await second.register("committed", 2);
  });
  assert.equal(await first.lookup("committed"), 1);
  assert.equal(await second.lookup("committed"), 2);

  await assert.rejects(database!.transaction(async () => {
    await first.register("rolled-back", 3);
    await second.register("rolled-back", 4);
    throw new Error("rollback");
  }), /rollback/u);
  assert.equal(await first.lookup("rolled-back"), undefined);
  assert.equal(await second.lookup("rolled-back"), undefined);
});

function namespace(label: string): string {
  const value = `${label}-${namespaceSuffix}`;
  namespaces.add(value);
  return value;
}
