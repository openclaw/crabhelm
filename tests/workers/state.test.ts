import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { DurableObjectStateDatabase } from "../../worker/state.js";

async function seed(storage: DurableObjectStorage) {
  for (let start = 0; start < 260; start += 128) {
    await storage.put(Object.fromEntries(Array.from(
      { length: Math.min(128, 260 - start) }, (_, offset) => {
        const index = start + offset;
        const key = index.toString().padStart(3, "0");
        return [`state:paged:${key}`, { key, value: index, createdAt: 260 - index }];
      },
    )));
  }
}

it("pages real Durable Object storage inside a transaction before evicting its oldest entry", async () => {
  await runInDurableObject(env.CONTROL_PLANE.getByName("state-pagination"), async (_instance, state) => {
    await seed(state.storage);
    const database = new DurableObjectStateDatabase(state.storage);
    const store = database.store<number>("paged", 260, { overflow: "evict-oldest" });
    await database.transaction(() => store.register("new", 999));
    expect(await store.lookup("new")).toBe(999);
    expect(await store.lookup("259")).toBeUndefined();
    expect(await store.lookup("000")).toBe(0);
    expect((await store.entries()).length).toBe(260);
  });
});

it("rolls back eviction when a caller without an outer transaction cannot store its replacement", async () => {
  await runInDurableObject(env.CONTROL_PLANE.getByName("state-rollback"), async (_instance, state) => {
    await seed(state.storage);
    const store = new DurableObjectStateDatabase(state.storage)
      .store<unknown>("paged", 260, { overflow: "evict-oldest" });
    await expect(store.register("new", () => undefined)).rejects.toThrow();
    expect(await store.lookup("new")).toBeUndefined();
    expect(await store.lookup("259")).toBe(259);
    expect((await store.entries()).length).toBe(260);
  });
});
