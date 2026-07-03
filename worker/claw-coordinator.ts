import { DurableObject } from "cloudflare:workers";

type GrantRegistration = { invocationId: string; jti: string; argumentsDigest: string; expiresAt: number };

export class CrabhelmClawCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS grants (invocation_id TEXT PRIMARY KEY, jti TEXT UNIQUE NOT NULL, arguments_digest TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER); CREATE TABLE IF NOT EXISTS runs (invocation_id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, error TEXT);`);
      await ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }

  async registerGrant(input: GrantRegistration): Promise<void> {
    if (!input.invocationId || !input.jti || !/^[0-9a-f]{64}$/u.test(input.argumentsDigest) || !Number.isInteger(input.expiresAt) || input.expiresAt <= Date.now()) throw new Error("grant registration is invalid");
    this.ctx.storage.sql.exec("INSERT INTO grants (invocation_id, jti, arguments_digest, expires_at) VALUES (?, ?, ?, ?)", input.invocationId, input.jti, input.argumentsDigest, input.expiresAt);
  }

  async consumeGrant(input: GrantRegistration): Promise<boolean> {
    const result = this.ctx.storage.sql.exec("UPDATE grants SET consumed_at = ? WHERE invocation_id = ? AND jti = ? AND arguments_digest = ? AND expires_at > ? AND consumed_at IS NULL", Date.now(), input.invocationId, input.jti, input.argumentsDigest, Date.now());
    return result.rowsWritten === 1;
  }

  async startRun(invocationId: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO runs (invocation_id, status, started_at) VALUES (?, 'running', ?)", invocationId, Date.now());
  }

  async finishRun(invocationId: string, ok: boolean, error?: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE runs SET status = ?, completed_at = ?, error = ? WHERE invocation_id = ? AND status = 'running'", ok ? "succeeded" : "failed", Date.now(), error?.slice(0, 500) ?? null, invocationId);
  }

  async alarm(): Promise<void> {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.ctx.storage.sql.exec("DELETE FROM grants WHERE expires_at < ?; DELETE FROM runs WHERE completed_at IS NOT NULL AND completed_at < ?", Date.now(), cutoff);
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }
}
