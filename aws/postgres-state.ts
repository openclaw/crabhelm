import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { StateEntry, StateStore, StateTransaction } from "../src/state.js";

const table = "crabhelm_state_entries";

type StoredRow = QueryResultRow & {
  key: string;
  value_json: string;
  created_at: string;
};

type CountRow = QueryResultRow & { count: string };

export class PostgresStateDatabase {
  readonly #pool: Pool;
  readonly #transactionClient = new AsyncLocalStorage<PoolClient>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  store<T>(
    namespace: string,
    maxEntries: number,
    options: { overflow?: "error" | "evict-oldest" } = {},
  ): StateStore<T> {
    requireNamespace(namespace);
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("state store maxEntries must be a positive integer");
    }

    return {
      register: async (key, value) => {
        requireKey(key);
        const valueJson = encodeValue(value);
        await this.#runLocked(async (client) => {
          const existing = await client.query(
            `SELECT 1 FROM ${table} WHERE namespace = $1 AND "key" = $2`,
            [namespace, key],
          );
          if (existing.rowCount === 0) {
            const result = await client.query<CountRow>(
              `SELECT COUNT(*)::text AS count FROM ${table} WHERE namespace = $1`,
              [namespace],
            );
            const count = Number(result.rows[0]?.count);
            if (!Number.isSafeInteger(count) || count >= maxEntries) {
              if (Number.isSafeInteger(count) && options.overflow === "evict-oldest") {
                await client.query(
                  `DELETE FROM ${table}
                   WHERE (namespace, "key") = (
                     SELECT namespace, "key" FROM ${table}
                     WHERE namespace = $1
                     ORDER BY created_at, "key"
                     LIMIT 1
                   )`,
                  [namespace],
                );
              } else {
                throw new Error(`state store entry limit exceeded (${maxEntries})`);
              }
            }
          }
          await client.query(
            `INSERT INTO ${table} (namespace, "key", value_json, created_at)
             VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT (namespace, "key") DO UPDATE SET
               value_json = EXCLUDED.value_json,
               created_at = EXCLUDED.created_at`,
            [namespace, key, valueJson, Date.now()],
          );
        });
      },
      lookup: async (key) => {
        requireKey(key);
        return this.#runLocked(async (client) => {
          const result = await client.query<StoredRow>(
            `SELECT "key", value_json::text AS value_json, created_at::text AS created_at
             FROM ${table}
             WHERE namespace = $1 AND "key" = $2`,
            [namespace, key],
          );
          const row = result.rows[0];
          return row ? decodeValue<T>(row.value_json, namespace, key) : undefined;
        });
      },
      delete: async (key) => {
        requireKey(key);
        return this.#runLocked(async (client) => {
          const result = await client.query(
            `DELETE FROM ${table} WHERE namespace = $1 AND "key" = $2`,
            [namespace, key],
          );
          return (result.rowCount ?? 0) > 0;
        });
      },
      entries: async () => this.#runLocked(async (client) => {
        const result = await client.query<StoredRow>(
          `SELECT "key", value_json::text AS value_json, created_at::text AS created_at
           FROM ${table}
           WHERE namespace = $1
           ORDER BY created_at, "key"`,
          [namespace],
        );
        return result.rows.map((row) => ({
          key: row.key,
          value: decodeValue<T>(row.value_json, namespace, row.key),
          createdAt: decodeTimestamp(row.created_at, namespace, row.key),
        } satisfies StateEntry<T>));
      }),
    };
  }

  transaction: StateTransaction = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (this.#transactionClient.getStore()) return operation();
    return this.#withLockedTransaction(() => operation());
  };

  async #runLocked<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const active = this.#transactionClient.getStore();
    if (active) return operation(active);
    return this.#withLockedTransaction(operation);
  }

  async #withLockedTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.#exclusive(async () => {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN");
        try {
          // One database-wide lock matches the serialized transaction semantics of
          // the existing SQLite and Durable Object adapters, including store caps.
          await client.query("SELECT pg_advisory_xact_lock(1129464130, 1212501069)");
          const result = await this.#transactionClient.run(client, () => operation(client));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Preserve the operation error if the connection already aborted.
          }
          throw error;
        }
      } finally {
        client.release();
      }
    });
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

function requireNamespace(namespace: string): void {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(namespace)) {
    throw new Error("state namespace is invalid");
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

function decodeValue<T>(raw: string, namespace: string, key: string): T {
  try {
    return structuredClone(JSON.parse(raw) as T);
  } catch (error) {
    throw new Error(`Crabhelm state row is invalid JSON (postgres:${namespace}:${key})`, {
      cause: error,
    });
  }
}

function decodeTimestamp(raw: string, namespace: string, key: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Crabhelm state row has an invalid timestamp (postgres:${namespace}:${key})`);
  }
  return value;
}
