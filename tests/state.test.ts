import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CrabhelmRegistry } from "../src/registry.js";
import { createSqliteStateStore, SqliteStateDatabase } from "../src/state.js";
import type { AuditEvent, ClawRecord, PolicyTemplate } from "../src/types.js";

test("SQLite state store persists transactional namespaced state", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crabhelm-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "nested", "crabhelm.sqlite");
  const claws = createSqliteStateStore<{ name: string }>(databasePath, "claws-v1", 2);

  await claws.register("one", { name: "Ada" });
  const second = createSqliteStateStore<{ name: string }>(databasePath, "claws-v1", 2);
  const audit = createSqliteStateStore<{ action: string }>(databasePath, "audit-v1", 2);
  assert.deepEqual(await second.lookup("one"), { name: "Ada" });
  await second.register("two", { name: "Lena" });
  await audit.register("event", { action: "created" });
  await assert.rejects(second.register("three", { name: "Marco" }), /entry limit/);
  assert.equal(await second.delete("one"), true);
  assert.equal(await second.delete("missing"), false);
  assert.deepEqual((await claws.entries()).map((entry) => entry.key), ["two"]);
  assert.deepEqual(await audit.lookup("event"), { action: "created" });

  const mode = (await stat(databasePath)).mode & 0o777;
  assert.equal(mode, 0o600);
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((inspection.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  inspection.close();
});

test("SQLite state store fails closed on malformed row JSON", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crabhelm-state-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "crabhelm.sqlite");
  const store = createSqliteStateStore(databasePath, "claws-v1", 2);
  const database = new DatabaseSync(databasePath);
  database
    .prepare(
      'INSERT INTO state_entries (namespace, "key", value_json, created_at) VALUES (?, ?, ?, ?)',
    )
    .run("claws-v1", "broken", "not-json", Date.now());
  database.close();

  await assert.rejects(store.entries(), /invalid JSON/);
  await assert.rejects(store.lookup("broken"), /invalid JSON/);
});

test("SQLite registry rolls back a fleet mutation when its audit row cannot commit", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crabhelm-state-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new SqliteStateDatabase(path.join(directory, "crabhelm.sqlite"));
  const claws = state.store<ClawRecord>("claws-v1", 10);
  const events = state.store<AuditEvent>("audit-v1", 1);
  await events.register("full", {
    id: "full",
    at: new Date().toISOString(),
    clawId: "existing",
    actor: "test",
    action: "claw.create",
    outcome: "requested",
    summary: "fills audit capacity",
    generation: 1,
  });
  const registry = new CrabhelmRegistry(claws, events, { transaction: state.transaction });

  await assert.rejects(
    registry.create(
      {
        name: "Atomic child",
        owner: { subject: "manual:atomic", label: "Atomic", source: "manual" },
      },
      "test",
    ),
    /entry limit/,
  );
  assert.equal((await registry.list()).length, 0);
  assert.equal((await events.entries()).length, 1);
});

test("SQLite rolls back an entire multi-claw policy mutation when one audit row cannot commit", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crabhelm-policy-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new SqliteStateDatabase(path.join(directory, "crabhelm.sqlite"));
  const claws = state.store<ClawRecord>("claws-v1", 10);
  const events = state.store<AuditEvent>("audit-v1", 4);
  const policies = state.store<PolicyTemplate>("policies-v1", 10);
  const registry = new CrabhelmRegistry(claws, events, {
    policies,
    transaction: state.transaction,
  });
  const first = await registry.create({
    name: "First policy target",
    owner: { subject: "manual:first-policy", label: "First", source: "manual" },
  }, "test");
  const second = await registry.create({
    name: "Second policy target",
    owner: { subject: "manual:second-policy", label: "Second", source: "manual" },
  }, "test");
  const policy = await registry.createPolicy({
    name: "Atomic policy",
    spec: {
      inference: { model: "openai/gpt-5.5-mini", fallbackModels: [] },
      slackEnabled: false,
      access: { dmPolicy: "pairing", groupPolicy: "allowlist" },
      observability: { logLevel: "warn" },
    },
  }, "test");
  const preview = await registry.previewPolicy(policy.id, 1, [first.id, second.id]);

  await assert.rejects(
    registry.applyPolicy(
      policy.id,
      1,
      [first.id, second.id],
      Object.fromEntries(preview.targets.map((target) => [target.clawId, target.expectedGeneration])),
      "test",
    ),
    /entry limit/,
  );
  assert.equal((await registry.get(first.id)).desired.inference.model, "openai/gpt-5.5");
  assert.equal((await registry.get(second.id)).desired.inference.model, "openai/gpt-5.5");
  assert.equal((await events.entries()).length, 3);
});

test("SQLite audit-style namespaces evict oldest metadata at capacity", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crabhelm-state-rotate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new SqliteStateDatabase(path.join(directory, "crabhelm.sqlite"));
  const events = state.store<{ sequence: number }>("audit-v1", 2, {
    overflow: "evict-oldest",
  });

  await events.register("one", { sequence: 1 });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await events.register("two", { sequence: 2 });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await events.register("three", { sequence: 3 });
  assert.deepEqual((await events.entries()).map((entry) => entry.key), ["two", "three"]);
});
