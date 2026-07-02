import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type StateEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
};

export type StateStore<T> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<StateEntry<T>[]>;
};

export type StateTransaction = <T>(operation: () => Promise<T>) => Promise<T>;

export function createMemoryStateStore<T>(): StateStore<T> {
  const values = new Map<string, StateEntry<T>>();
  return {
    async register(key, value) {
      values.set(key, { key, value: structuredClone(value), createdAt: Date.now() });
    },
    async lookup(key) {
      const value = values.get(key)?.value;
      return value === undefined ? undefined : structuredClone(value);
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.values()].map((entry) => structuredClone(entry));
    },
  };
}

type StateRow = {
  key: string;
  value_json: string;
  created_at: number;
};

export class SqliteStateDatabase {
  readonly #databasePath: string;
  readonly #database: DatabaseSync;
  readonly #transactionContext = new AsyncLocalStorage<boolean>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(databasePath: string) {
    if (!path.isAbsolute(databasePath)) throw new Error("state database path must be absolute");
    this.#databasePath = databasePath;
    this.#database = openDatabase(databasePath);
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

    const selectOne = this.#database.prepare(
      'SELECT "key", value_json, created_at FROM state_entries WHERE namespace = ? AND "key" = ?',
    );
    const selectAll = this.#database.prepare(
      'SELECT "key", value_json, created_at FROM state_entries WHERE namespace = ? ORDER BY created_at, "key"',
    );
    const countEntries = this.#database.prepare(
      "SELECT COUNT(*) AS count FROM state_entries WHERE namespace = ?",
    );
    const upsert = this.#database.prepare(
      `INSERT INTO state_entries (namespace, "key", value_json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, "key") DO UPDATE SET
         value_json = excluded.value_json,
         created_at = excluded.created_at`,
    );
    const remove = this.#database.prepare(
      'DELETE FROM state_entries WHERE namespace = ? AND "key" = ?',
    );
    const removeOldest = this.#database.prepare(
      `DELETE FROM state_entries
       WHERE namespace = ? AND "key" = (
         SELECT "key" FROM state_entries
         WHERE namespace = ?
         ORDER BY created_at, "key"
         LIMIT 1
       )`,
    );

    return {
      register: async (key, value) => {
        requireKey(key);
        const valueJson = encodeValue(value);
        await this.#mutate(() => {
          const existing = selectOne.get(namespace, key);
          if (!existing) {
            const row = countEntries.get(namespace) as { count?: unknown } | undefined;
            const count = Number(row?.count);
            if (!Number.isSafeInteger(count) || count >= maxEntries) {
              if (Number.isSafeInteger(count) && options.overflow === "evict-oldest") {
                removeOldest.run(namespace, namespace);
              } else {
                throw new Error(`state store entry limit exceeded (${maxEntries})`);
              }
            }
          }
          upsert.run(namespace, key, valueJson, Date.now());
        });
      },
      lookup: async (key) => {
        requireKey(key);
        return this.#read(() => {
          const row = selectOne.get(namespace, key) as StateRow | undefined;
          return row
            ? decodeValue<T>(row.value_json, this.#databasePath, namespace, key)
            : undefined;
        });
      },
      delete: async (key) => {
        requireKey(key);
        return this.#mutate(() => remove.run(namespace, key).changes > 0);
      },
      entries: async () =>
        this.#read(() =>
          (selectAll.all(namespace) as StateRow[]).map((row) => ({
            key: row.key,
            value: decodeValue<T>(row.value_json, this.#databasePath, namespace, row.key),
            createdAt: row.created_at,
          })),
        ),
    };
  }

  transaction: StateTransaction = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (this.#transactionContext.getStore()) return operation();
    return this.#exclusive(async () => {
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const result = await this.#transactionContext.run(true, operation);
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // Preserve the mutation error if SQLite already ended the transaction.
        }
        throw error;
      }
    });
  };

  async #read<R>(operation: () => R): Promise<R> {
    if (this.#transactionContext.getStore()) return operation();
    return this.#exclusive(operation);
  }

  async #mutate<R>(operation: () => R): Promise<R> {
    if (this.#transactionContext.getStore()) return operation();
    return this.#exclusive(() => inImmediateTransaction(this.#database, operation));
  }

  #exclusive<R>(operation: () => R | Promise<R>): Promise<R> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export function createSqliteStateStore<T>(
  databasePath: string,
  namespace: string,
  maxEntries: number,
): StateStore<T> {
  return new SqliteStateDatabase(databasePath).store<T>(namespace, maxEntries);
}

function openDatabase(databasePath: string): DatabaseSync {
  const directory = path.dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const database = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS state_entries (
      namespace TEXT NOT NULL,
      "key" TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, "key")
    ) WITHOUT ROWID
  `);
  return database;
}

function inImmediateTransaction<R>(database: DatabaseSync, operation: () => R): R {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the mutation error if SQLite already ended the transaction.
    }
    throw error;
  }
}

function requireKey(key: string): void {
  if (!key || key.length > 500) throw new Error("state key is invalid");
}

function encodeValue(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("state value must be JSON-compatible");
  return encoded;
}

function decodeValue<T>(raw: string, databasePath: string, namespace: string, key: string): T {
  try {
    return structuredClone(JSON.parse(raw) as T);
  } catch (error) {
    throw new Error(
      `Crabhelm state row is invalid JSON (${path.basename(databasePath)}:${namespace}:${key})`,
      { cause: error },
    );
  }
}
