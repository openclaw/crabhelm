import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { CrabhelmClawCoordinator } from "../../worker/claw-coordinator.js";
import { encryptTurnPayload } from "../../worker/turn-envelope.js";

function slackCoordinator(state: DurableObjectState): CrabhelmClawCoordinator {
  return new CrabhelmClawCoordinator(state, {
    ...env,
    CRABHELM_SLACK: "on",
    GITHUB_OAUTH_CLIENT_SECRET: "test-only-unused",
  });
}

it.each([true, false])("shares an in-flight Slack delivery between cleanup and a completion replay (success: %s)", async (success) => {
  const clawId = crypto.randomUUID();
  const stub = env.CLAW_COORDINATOR.getByName(clawId);
  await runInDurableObject(stub, async (_instance, state) => {
    const coordinator = slackCoordinator(state);
    const jobId = crypto.randomUUID();
    const envelope = await encryptTurnPayload(env.VAULT_MASTER_KEY, `${jobId}:response`, { prompt: "synthetic reply" });
    state.storage.sql.exec(
      `INSERT INTO turn_jobs (id, event_id, claw_id, requester_id, persona_id, status,
        turn_token, source_json, runtime_id, response_envelope, delivery_status, created_at, completed_at, expires_at)
       VALUES (?, ?, ?, 'requester', 'persona', 'completed', 'turn', ?, 'runtime', ?, 'pending', ?, ?, ?)`,
      jobId, `event-${jobId}`, clawId,
      JSON.stringify({ surface: "slack", workspaceId: "T123", channelId: "C123", threadTs: "1.2" }),
      envelope, Date.now(), Date.now(), Date.now() + 60_000,
    );
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    const post = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      requested.resolve();
      await response.promise;
      return Response.json({ ok: success, ...(success ? {} : { error: "service_unavailable" }) });
    });
    const socket = {
      deserializeAttachment: () => ({ runtimeId: "runtime", clawId, refreshJti: "refresh" }),
      send: vi.fn(),
    } as unknown as WebSocket;
    const completion = JSON.stringify({ type: "job.complete", id: jobId, ok: true, output: "synthetic reply" });
    try {
      const cleanup = coordinator.alarm();
      await requested.promise;
      const replay = coordinator.webSocketMessage(socket, completion);
      response.resolve();
      await Promise.all([cleanup, replay]);

      expect(post).toHaveBeenCalledTimes(1);
      expect(await coordinator.jobStatus(jobId)).toMatchObject({ deliveryStatus: success ? "delivered" : "pending" });
      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "job.ack", id: jobId }));
      if (success) {
        await coordinator.webSocketMessage(socket, completion);
        expect(post).toHaveBeenCalledTimes(1);
      } else {
        expect(state.storage.sql.exec<{ delivery_attempts: number }>(
          "SELECT delivery_attempts FROM turn_jobs WHERE id = ?", jobId,
        ).one().delivery_attempts).toBe(1);
        post.mockResolvedValue(Response.json({ ok: true }));
        // Pending delivery survives losing all instance-local state.
        const restarted = slackCoordinator(state);
        await restarted.alarm();
        expect(post).toHaveBeenCalledTimes(2);
        expect(await restarted.jobStatus(jobId)).toMatchObject({ deliveryStatus: "delivered" });
      }
    } finally {
      response.resolve();
      post.mockRestore();
      await state.storage.deleteAlarm();
    }
  });
});

it("skips a stale cleanup snapshot after a completion replay delivered the job", async () => {
  const clawId = crypto.randomUUID();
  await runInDurableObject(env.CLAW_COORDINATOR.getByName(clawId), async (_instance, state) => {
    const coordinator = slackCoordinator(state);
    const jobs = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, id] of jobs.entries()) {
      const envelope = await encryptTurnPayload(env.VAULT_MASTER_KEY, `${id}:response`, { prompt: `reply ${index}` });
      state.storage.sql.exec(
        `INSERT INTO turn_jobs (id, event_id, claw_id, requester_id, persona_id, status,
          turn_token, source_json, runtime_id, response_envelope, delivery_status, created_at, completed_at, expires_at)
         VALUES (?, ?, ?, 'requester', 'persona', 'completed', 'turn', ?, 'runtime', ?, 'pending', ?, ?, ?)`,
        id, `event-${id}`, clawId,
        JSON.stringify({ surface: "slack", workspaceId: "T123", channelId: "C123", threadTs: "1.2" }),
        envelope, Date.now(), Date.now() + index, Date.now() + 60_000,
      );
    }
    const socket = {
      deserializeAttachment: () => ({ runtimeId: "runtime", clawId, refreshJti: "refresh" }),
      send() {},
    } as unknown as WebSocket;
    const post = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        await coordinator.webSocketMessage(socket, JSON.stringify({
          type: "job.complete", id: jobs[1], ok: true, output: "reply 1",
        }));
        return Response.json({ ok: true });
      })
      .mockImplementation(async () => Response.json({ ok: true }));
    try {
      await coordinator.alarm();
      expect(post).toHaveBeenCalledTimes(2);
      for (const id of jobs) {
        expect(await coordinator.jobStatus(id)).toMatchObject({ deliveryStatus: "delivered" });
        expect(state.storage.sql.exec<{ response_envelope: string | null }>(
          "SELECT response_envelope FROM turn_jobs WHERE id = ?", id,
        ).one().response_envelope).toBeNull();
      }
    } finally {
      post.mockRestore();
      await state.storage.deleteAlarm();
    }
  });
});
