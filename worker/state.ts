import { AsyncLocalStorage } from "node:async_hooks";
import type { StateEntry, StateStore, StateTransaction } from "../src/state.js";

type Storage = Pick<
  DurableObjectStorage,
  "delete" | "get" | "list" | "put"
> | Pick<DurableObjectTransaction, "delete" | "get" | "list" | "put">;

export class DurableObjectStateDatabase {
  readonly #storage: DurableObjectStorage;
  readonly #transaction = new AsyncLocalStorage<DurableObjectTransaction>();

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  store<T>(
    namespace: string,
    maxEntries: number,
    options: { overflow?: "error" | "evict-oldest" } = {},
  ): StateStore<T> {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(namespace)) {
      throw new Error("state namespace is invalid");
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("state store maxEntries must be a positive integer");
    }
    const prefix = `state:${namespace}:`;
    return {
      // Governance also writes outside registry transactions. Keep every page,
      // capacity decision, eviction, and replacement in the same snapshot.
      register: (key, value) => this.transaction(async () => {
        requireKey(key);
        const storage = this.#activeStorage();
        const storageKey = `${prefix}${encodeURIComponent(key)}`;
        const existing = await storage.get<StateEntry<T>>(storageKey);
        if (!existing) {
          let count = 0;
          let startAfter: string | undefined;
          let oldest: { key: string; createdAt: number } | undefined;
          // A namespace can hold 50,000 payloads. Bound live pages and avoid
          // filling the storage cache just to enforce capacity or find one victim.
          for (;;) {
            const entries = await storage.list<StateEntry<T>>({
              prefix, startAfter, limit: 128, noCache: true,
            });
            count += entries.size;
            if (count >= maxEntries && options.overflow !== "evict-oldest") {
              throw new Error(`state store entry limit exceeded (${maxEntries})`);
            }
            for (const [entryKey, entry] of entries) {
              startAfter = entryKey;
              if (!oldest || (entry.createdAt - oldest.createdAt ||
                entryKey.localeCompare(oldest.key)) < 0) {
                oldest = { key: entryKey, createdAt: entry.createdAt };
              }
            }
            if (entries.size < 128) break;
          }
          if (count >= maxEntries && oldest) await storage.delete(oldest.key);
        }
        await storage.put(storageKey, {
          key,
          value: structuredClone(value),
          createdAt: Date.now(),
        } satisfies StateEntry<T>);
      }),
      lookup: async (key) => {
        requireKey(key);
        const entry = await this.#activeStorage().get<StateEntry<T>>(
          `${prefix}${encodeURIComponent(key)}`,
        );
        return entry ? structuredClone(entry.value) : undefined;
      },
      delete: async (key) => {
        requireKey(key);
        return this.#activeStorage().delete(`${prefix}${encodeURIComponent(key)}`);
      },
      entries: async () =>
        [...(await this.#activeStorage().list<StateEntry<T>>({ prefix })).values()]
          .map((entry) => structuredClone(entry)),
    };
  }

  transaction: StateTransaction = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (this.#transaction.getStore()) return operation();
    return this.#storage.transaction((transaction) =>
      this.#transaction.run(transaction, operation)
    );
  };

  #activeStorage(): Storage {
    return this.#transaction.getStore() ?? this.#storage;
  }
}

function requireKey(key: string): void {
  if (!key || key.length > 500) throw new Error("state key is invalid");
}
