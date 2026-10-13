/// <reference types="@cloudflare/workers-types" />

import assert from "node:assert/strict";
import test from "node:test";
import type { StateEntry } from "../src/state.js";
import { DurableObjectStateDatabase } from "../worker/state.js";

function fixture(count: number) {
  const values = new Map<string, StateEntry<number>>();
  for (let index = 0; index < count; index++) {
    const key = index.toString().padStart(3, "0");
    values.set(`state:test:${key}`, { key, value: index, createdAt: count - index });
  }
  const pages: number[] = [];
  const deleted: string[] = [];
  let transactionCalls = 0;
  let failPut = false;
  const storage = {
    async get(key: string) { return values.get(key); },
    async put(key: string, value: StateEntry<number>) {
      if (failPut) throw new Error("write failed");
      values.set(key, value);
    },
    async delete(key: string) {
      deleted.push(key);
      return values.delete(key);
    },
    async list(options: { prefix: string; startAfter?: string; limit: number; noCache: boolean }) {
      assert.ok(options.limit > 0 && options.limit <= 128, "capacity scans must be bounded");
      assert.equal(options.noCache, true);
      const page = [...values.entries()]
        .filter(([key]) => key.startsWith(options.prefix) &&
          (options.startAfter === undefined || key > options.startAfter))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .slice(0, options.limit);
      pages.push(page.length);
      return new Map(page);
    },
    async transaction<T>(operation: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> {
      transactionCalls++;
      const snapshot = structuredClone(values);
      try {
        return await operation(storage as unknown as DurableObjectTransaction);
      } catch (error) {
        values.clear();
        for (const [key, value] of snapshot) values.set(key, value);
        throw error;
      }
    },
  };
  return {
    values, pages, deleted,
    transactionCalls: () => transactionCalls,
    failWrites: () => { failPut = true; },
    database: new DurableObjectStateDatabase(storage as unknown as DurableObjectStorage),
  };
}

test("Durable Object insertion finds an oldest entry beyond the first bounded page", async () => {
  const { database, values, pages, deleted, transactionCalls } = fixture(260);
  const store = database.store<number>("test", 260, { overflow: "evict-oldest" });
  await store.register("new", 999);
  assert.deepEqual(pages, [128, 128, 4]);
  assert.deepEqual(deleted, ["state:test:259"]);
  assert.equal(values.size, 260);
  assert.equal(await store.lookup("new"), 999);
  assert.equal(await store.lookup("000"), 0);
  assert.equal(transactionCalls(), 1);
});

test("Durable Object registration joins an existing transaction", async () => {
  const { database, transactionCalls } = fixture(260);
  const store = database.store<number>("test", 260, { overflow: "evict-oldest" });
  await database.transaction(() => store.register("new", 999));
  assert.equal(transactionCalls(), 1);
});

test("Durable Object registration rolls back eviction if the replacement write fails", async () => {
  const { database, values, failWrites } = fixture(260);
  failWrites();
  await assert.rejects(
    database.store<number>("test", 260, { overflow: "evict-oldest" }).register("new", 999),
    /write failed/,
  );
  assert.equal(values.size, 260);
  assert.equal(values.has("state:test:259"), true);
  assert.equal(values.has("state:test:new"), false);
});

test("Durable Object eviction preserves created-time and key tie ordering across pages", async () => {
  const { database, values, deleted } = fixture(260);
  values.get("state:test:000")!.createdAt = 0;
  values.get("state:test:259")!.createdAt = 0;
  await database.store<number>("test", 260, { overflow: "evict-oldest" }).register("new", 999);
  assert.deepEqual(deleted, ["state:test:000"]);
  assert.equal(values.has("state:test:259"), true);
});

test("Durable Object capacity rejection stops scanning without deleting or writing", async () => {
  const { database, values, pages, deleted } = fixture(300);
  await assert.rejects(database.store<number>("test", 200).register("new", 999), /entry limit/);
  assert.deepEqual(pages, [128, 128]);
  assert.deepEqual(deleted, []);
  assert.equal(values.has("state:test:new"), false);
  assert.equal(values.size, 300);
});

test("Durable Object replacement skips the capacity scan and eviction", async () => {
  const { database, values, pages, deleted } = fixture(260);
  const store = database.store<number>("test", 260, { overflow: "evict-oldest" });
  await store.register("000", 999);
  assert.deepEqual(pages, []);
  assert.deepEqual(deleted, []);
  assert.equal(values.size, 260);
  assert.equal(await store.lookup("000"), 999);
});

test("Durable Object insertion handles an empty or exactly full scan page without eviction", async () => {
  for (const count of [0, 128]) {
    const { database, values, pages, deleted } = fixture(count);
    await database.store<number>("test", 260, { overflow: "evict-oldest" }).register("new", 999);
    assert.deepEqual(pages, count === 0 ? [0] : [128, 0]);
    assert.deepEqual(deleted, []);
    assert.equal(values.size, count + 1);
  }
});
