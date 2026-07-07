import type { ConfirmationRecord, TurnClaims } from "../src/governance-types.js";
import { slackIdentity, type SlackUserProfile } from "../src/slack-identity.js";
import { verifySlackRequest } from "./slack-signature.js";

const maxSlackBodyBytes = 128 * 1024;

export async function handleSlackRequest(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const raw = await readBoundedSlackBody(request.body, request.headers);
  if (!raw) return new Response("payload too large", { status: 413 });
  if (!await verifySlackRequest(request.headers, raw, env.SLACK_SIGNING_SECRET)) return new Response("unauthorized", { status: 401 });
  const body = new TextDecoder().decode(raw);
  if (new URL(request.url).pathname === "/slack/interactions") {
    const payload = new URLSearchParams(body).get("payload");
    if (!payload) return new Response("invalid interaction", { status: 400 });
    let interaction: SlackInteraction;
    try { interaction = JSON.parse(payload) as SlackInteraction; }
    catch { return new Response("invalid interaction", { status: 400 }); }
    ctx.waitUntil(processInteraction(interaction, env));
    return new Response("", { status: 200 });
  }
  let event: SlackEnvelope;
  try { event = JSON.parse(body) as SlackEnvelope; }
  catch { return new Response("invalid event", { status: 400 }); }
  if (event.type === "url_verification" && typeof event.challenge === "string") {
    return Response.json({ challenge: event.challenge });
  }
  if (event.type !== "event_callback" || !event.event_id || !event.team_id || !event.event) return new Response("", { status: 200 });
  ctx.waitUntil(processEvent(event, env));
  return new Response("", { status: 200 });
}

export async function postSlackConfirmation(env: Env, claims: TurnClaims, confirmation: ConfirmationRecord): Promise<void> {
  if (claims.surface !== "slack" || !claims.channelId || !claims.threadTs) return;
  await slackApi(env, "chat.postMessage", {
    channel: claims.channelId,
    thread_ts: claims.threadTs,
    text: `Confirmation required: ${confirmation.summary}`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*Confirmation required*\n${escapeSlack(confirmation.summary)}\nExpires in 10 minutes.` } },
      { type: "actions", block_id: `crabhelm-confirm-${confirmation.id}`, elements: [
        { type: "button", action_id: "crabhelm.confirm.approve", text: { type: "plain_text", text: "Approve once" }, style: "primary", value: confirmation.id },
        { type: "button", action_id: "crabhelm.confirm.deny", text: { type: "plain_text", text: "Deny" }, style: "danger", value: confirmation.id },
      ] },
    ],
  });
}

async function processEvent(envelope: SlackEnvelope, env: Env): Promise<void> {
  const event = envelope.event!;
  if ((event.type !== "message" && event.type !== "app_mention") || event.bot_id || event.subtype || !event.user || !event.channel || !event.ts) return;
  const prompt = (event.text ?? "").replace(/<@[A-Z0-9]+>/gu, "").trim();
  if (!prompt) return;
  const user = await slackUser(env, event.user);
  const jobId = crypto.randomUUID();
  try {
    const route = await env.CONTROL_PLANE.getByName("openclaw-org").routeSlackTurn({
      jobId,
      workspaceId: envelope.team_id!,
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      userId: event.user,
      ...(user.email ? { email: user.email } : {}),
      label: user.label,
    });
    await env.CLAW_COORDINATOR.getByName(route.clawId).enqueueTurn({
      id: jobId,
      eventId: envelope.event_id!,
      clawId: route.clawId,
      requesterId: route.requesterId,
      personaId: route.personaId,
      prompt,
      turnToken: route.turnToken,
      source: { surface: "slack", workspaceId: envelope.team_id!, channelId: event.channel, threadTs: event.thread_ts ?? event.ts },
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "slack_ingress_failed", eventId: envelope.event_id, error: error instanceof Error ? error.message : String(error) }));
    await slackApi(env, "chat.postMessage", {
      channel: event.channel,
      thread_ts: event.thread_ts ?? event.ts,
      text: error instanceof Error && error.message.startsWith("No Crabhelm persona")
        ? "No Crabhelm persona is assigned to this conversation yet. Ask a Crabhelm administrator to bind one."
        : "Crabhelm could not accept this request. Please retry.",
    });
  }
}

async function processInteraction(payload: SlackInteraction, env: Env): Promise<void> {
  const action = payload.actions?.[0];
  const approve = action?.action_id === "crabhelm.confirm.approve";
  if (!action || (!approve && action.action_id !== "crabhelm.confirm.deny") || !action.value || !payload.team?.id || !payload.user?.id) return;
  const user = await slackUser(env, payload.user.id);
  try {
    const result = await env.CONTROL_PLANE.getByName("openclaw-org").decideSlackConfirmation({
      workspaceId: payload.team.id,
      userId: payload.user.id,
      ...(user.email ? { email: user.email } : {}),
      confirmationId: action.value,
      approve,
    });
    if (payload.channel?.id && payload.message?.ts) {
      await slackApi(env, "chat.update", {
        channel: payload.channel.id,
        ts: payload.message.ts,
        text: `${approve ? "Approved" : "Denied"}: ${result.summary}`,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `${approve ? "✅ *Approved once*" : "⛔ *Denied*"}\n${escapeSlack(result.summary)}` } }],
      });
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "slack_confirmation_failed", confirmationId: action.value, error: error instanceof Error ? error.message : String(error) }));
  }
}

async function slackUser(env: Env, userId: string): Promise<{ email?: string; label: string }> {
  let result: { user?: SlackUserProfile };
  try {
    result = await slackApi(env, "users.info", { user: userId });
  } catch {
    // Profile lookup is enrichment only. Keep the signed workspace/user identity usable.
    return slackIdentity(userId);
  }
  return slackIdentity(userId, result.user);
}

async function slackApi(env: Env, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!env.SLACK_BOT_TOKEN?.trim()) throw new Error("Slack bot token is not configured");
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const result = await boundedSlackJson(response);
  if (!response.ok || result.ok !== true) throw new Error(`Slack ${method} failed (${String(result.error ?? response.status)})`);
  return result;
}

async function boundedSlackJson(response: Response): Promise<Record<string, unknown>> {
  const bytes = await readBoundedSlackBody(response.body, response.headers);
  if (!bytes) throw new Error("Slack response is too large");
  try { return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; }
  catch { throw new Error(`Slack returned invalid JSON (${response.status})`); }
}

async function readBoundedSlackBody(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
): Promise<Uint8Array | undefined> {
  const declaredLength = Number(headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxSlackBodyBytes) {
    try { await body?.cancel("Slack body exceeds size limit"); } catch { /* Best-effort producer cancellation. */ }
    return undefined;
  }
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxSlackBodyBytes) {
        try { await reader.cancel("Slack body exceeds size limit"); } catch { /* Best-effort producer cancellation. */ }
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function escapeSlack(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }

type SlackEnvelope = {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: { type?: string; subtype?: string; bot_id?: string; user?: string; channel?: string; channel_type?: string; ts?: string; thread_ts?: string; text?: string };
};

type SlackInteraction = {
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
};
