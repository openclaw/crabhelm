import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const CLAW_ID = "685b2bda-351e-450b-a91c-45938c54454f";

// Opens a runtime WebSocket straight to the CrabhelmClawCoordinator DO with the
// identity headers the worker sets after ticket verification, so the real
// hibernatable-socket reconnect path runs in workerd. This replaces the
// source-text regex assertion in tests/edge-security.test.ts.
function connect(runtimeId: string, refreshJti: string): Promise<WebSocket> {
  return env.CLAW_COORDINATOR.getByName(CLAW_ID)
    .fetch(new Request("https://coordinator.internal/api/runtime/connect", {
      headers: {
        upgrade: "websocket",
        "x-crabhelm-runtime-id": runtimeId,
        "x-crabhelm-claw-id": CLAW_ID,
        "x-crabhelm-refresh-jti": refreshJti,
      },
    }))
    .then((response) => {
      expect(response.status).toBe(101);
      const socket = response.webSocket;
      if (!socket) throw new Error("coordinator did not return a runtime socket");
      socket.accept();
      return socket;
    });
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a runtime message")), 5_000);
    socket.addEventListener("message", (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(JSON.parse(typeof event.data === "string" ? event.data : ""));
    }, { once: true });
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a runtime close")), 5_000);
    socket.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(timer);
      resolve(event);
    }, { once: true });
  });
}

function messageStream(socket: WebSocket): { next(): Promise<Record<string, unknown>> } {
  const queued: Array<Record<string, unknown>> = [];
  const waiting: Array<(message: Record<string, unknown>) => void> = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "") as Record<string, unknown>;
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  });
  return {
    next() {
      const message = queued.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a runtime message")), 5_000);
        waiting.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
  };
}

describe("runtime bridge reconnect in workerd", () => {
  it("replaces a stale socket for the same runtime instead of rejecting the new bridge", async () => {
    const first = await connect("runtime-a", "refresh-1");
    expect(await nextMessage(first)).toMatchObject({ type: "runtime.ready", clawId: CLAW_ID });
    const firstClosed = nextClose(first);

    // A second bridge for the same runtime id reconnects; the coordinator must
    // evict the stale socket with 4001 rather than refuse the new connection.
    const second = await connect("runtime-a", "refresh-2");
    expect(await nextMessage(second)).toMatchObject({ type: "runtime.ready", clawId: CLAW_ID });

    const close = await firstClosed;
    expect(close.code).toBe(4001);
    expect(close.reason).toBe("runtime reconnected");

    expect((await env.CLAW_COORDINATOR.getByName(CLAW_ID).runtimeStatus()).connected).toBe(1);
    second.close(1000, "test complete");
  });

  it("keeps distinct runtimes connected side by side", async () => {
    const claw = "11111111-2222-3333-4444-555555555555";
    const open = (runtimeId: string) =>
      env.CLAW_COORDINATOR.getByName(claw).fetch(new Request("https://coordinator.internal/api/runtime/connect", {
        headers: {
          upgrade: "websocket",
          "x-crabhelm-runtime-id": runtimeId,
          "x-crabhelm-claw-id": claw,
          "x-crabhelm-refresh-jti": `jti-${runtimeId}`,
        },
      })).then((response) => {
        const socket = response.webSocket;
        if (!socket) throw new Error("no socket");
        socket.accept();
        return socket;
      });
    const a = await open("runtime-x");
    const b = await open("runtime-y");
    expect((await env.CLAW_COORDINATOR.getByName(claw).runtimeStatus()).connected).toBe(2);
    a.close(1000, "done");
    b.close(1000, "done");
  });

  it("rejects a runtime upgrade without identity headers", async () => {
    const response = await env.CLAW_COORDINATOR.getByName(CLAW_ID).fetch(
      new Request("https://coordinator.internal/api/runtime/connect", { headers: { upgrade: "websocket" } }),
    );
    expect(response.status).toBe(401);
  });

  it("terminates queued Slack delivery when explicit off mode overrides stale credentials", async () => {
    const coordinator = env.CLAW_COORDINATOR.getByName(CLAW_ID);
    const socket = await connect("runtime-slack-off", "refresh-slack-off");
    const messages = messageStream(socket);
    expect(await messages.next()).toMatchObject({ type: "runtime.ready", clawId: CLAW_ID });

    const jobId = crypto.randomUUID();
    await coordinator.enqueueTurn({
      id: jobId,
      eventId: `event-${jobId}`,
      clawId: CLAW_ID,
      requesterId: "principal:member",
      personaId: "persona:main",
      prompt: "queued Slack-off request",
      turnToken: "turn",
      source: {
        surface: "slack",
        workspaceId: "T12345678",
        channelId: "C12345678",
        threadTs: "1234567890.123456",
      },
      expiresAt: Date.now() + 60_000,
    });
    expect(await messages.next()).toMatchObject({ type: "job.available" });

    socket.send(JSON.stringify({ type: "job.claim" }));
    expect(await messages.next()).toMatchObject({ type: "job.retry" });
    socket.send(JSON.stringify({ type: "job.claim" }));
    let offered = false;
    for (let index = 0; index < 10; index++) {
      const message = await messages.next();
      if (message.type === "job.turn.ready") {
        expect(message.id).toBe(jobId);
        offered = true;
        break;
      }
    }
    expect(offered).toBe(true);

    socket.send(JSON.stringify({ type: "job.started", id: jobId }));
    expect(await messages.next()).toMatchObject({ type: "job.started.ack", id: jobId });
    socket.send(JSON.stringify({
      type: "job.complete",
      id: jobId,
      ok: true,
      output: "must not be posted",
    }));
    expect(await messages.next()).toMatchObject({ type: "job.ack", id: jobId });
    expect(await coordinator.jobStatus(jobId)).toMatchObject({
      status: "completed",
      deliveryStatus: "failed",
    });
    expect((await coordinator.runtimeStatus()).awaitingDelivery).toBe(0);
    socket.close(1000, "test complete");
  });
});
