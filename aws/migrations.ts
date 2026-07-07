import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

export async function runMigrations(pool: Pool, directory: string): Promise<void> {
  const files = (await readdir(directory))
    .filter((name) => /^[0-9]{4}_[a-z0-9_-]+\.sql$/u.test(name))
    .toSorted();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('crabhelm:migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const appliedRows = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(appliedRows.rows.map((row) => row.name));
    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = await readFile(path.join(directory, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`AWS database migration failed (${name})`, { cause: error });
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('crabhelm:migrations'))");
    } finally {
      client.release();
    }
  }
}
