import { WorkerEntrypoint } from "cloudflare:workers";
import { SYSTEM_OPERATOR_PRINCIPAL_ID } from "../src/governance.js";

type AdminResponse = { status: number; body: unknown };
type SlackProbe = { marker: string; jobId: string; clawId: string; threadTs: string };

export class CrabhelmAdmin extends WorkerEntrypoint<Env> {
  async deploymentIdentity(): Promise<{ archiveId: string; releaseId: string }> {
    return this.env.CONTROL_PLANE.getByName("openclaw-org").deploymentIdentity();
  }

  async restartControlPlane(): Promise<void> {
    return this.env.CONTROL_PLANE.getByName("openclaw-org").restartForDeployment();
  }

  async state(): Promise<AdminResponse> {
    return this.#request("GET", "/api/state");
  }

  async createClaw(input: unknown): Promise<AdminResponse> {
    return this.#request("POST", "/api/claws", input);
  }

  async updateClaw(clawId: string, input: unknown): Promise<AdminResponse> {
    return this.#request("PATCH", `/api/claws/${encodeURIComponent(identifier(clawId))}`, input);
  }

  async updatePersona(personaId: string, input: unknown): Promise<AdminResponse> {
    return this.#request("PATCH", `/api/personas/${encodeURIComponent(identifier(personaId))}`, input);
  }

  async clawAction(clawId: string, action: "runtime-reconnect" | "runtime-reset" | "runtime-diagnostics" | "reconcile" | "rotate-credentials"): Promise<AdminResponse> {
    const method = action === "runtime-diagnostics" ? "GET" : "POST";
    return this.#request(method, `/api/claws/${encodeURIComponent(identifier(clawId))}/${action}`);
  }

  async removeClaw(clawId: string, confirmation: string): Promise<AdminResponse> {
    return this.#request("DELETE", `/api/claws/${encodeURIComponent(identifier(clawId))}`, { confirmation });
  }

  async startSlackProbe(workspaceId: string, channelId: string): Promise<SlackProbe> {
    const workspace = slackId(workspaceId, "workspace");
    const channel = slackId(channelId, "channel");
    const jobId = crypto.randomUUID();
    const marker = `CRABHELM-PRODUCTION-PROBE-${jobId.slice(0, 8).toUpperCase()}`;
    const parent = await slackPost(this.env.SLACK_BOT_TOKEN, {
      channel,
      text: `Crabhelm automated production probe. Expected teammate reply: ${marker}`,
    });
    const route = await this.env.CONTROL_PLANE.getByName("openclaw-org").routeSlackTurn({
      jobId,
      workspaceId: workspace,
      channelId: channel,
      threadTs: parent.ts,
      userId: "CRABHELM_PROBE",
      email: "probe@example.com",
      label: "Crabhelm production probe",
    });
    await this.env.CLAW_COORDINATOR.getByName(route.clawId).enqueueTurn({
      id: jobId,
      eventId: `probe:${jobId}`,
      clawId: route.clawId,
      requesterId: route.requesterId,
      personaId: route.personaId,
      prompt: `Reply with exactly: ${marker}`,
      turnToken: route.turnToken,
      source: { surface: "slack", workspaceId: workspace, channelId: channel, threadTs: parent.ts },
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    return { marker, jobId, clawId: route.clawId, threadTs: parent.ts };
  }

  async slackProbeStatus(clawId: string, jobId: string): Promise<unknown> {
    return this.env.CLAW_COORDINATOR.getByName(identifier(clawId)).jobStatus(identifier(jobId));
  }

  async #request(method: string, path: string, body?: unknown): Promise<AdminResponse> {
    const headers = new Headers({
      "x-crabhelm-principal-id": SYSTEM_OPERATOR_PRINCIPAL_ID,
      "x-crabhelm-roles": "administrator",
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.env.CONTROL_PLANE.getByName("openclaw-org").fetch(new Request(`https://crabhelm.internal${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const text = await response.text();
    let value: unknown = null;
    if (text) {
      try { value = JSON.parse(text); }
      catch { value = { error: "admin entrypoint received a non-JSON response" }; }
    }
    return { status: response.status, body: value };
  }
}

function identifier(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || normalized.includes("/")) throw new Error("invalid identifier");
  return normalized;
}

function slackId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Z][A-Z0-9]{8,20}$/u.test(normalized)) throw new Error(`invalid Slack ${label} id`);
  return normalized;
}

async function slackPost(token: string | undefined, input: { channel: string; text: string }): Promise<{ ts: string }> {
  if (!token?.trim()) throw new Error("Slack bot is not configured");
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ...input, unfurl_links: false, unfurl_media: false }),
  });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 128 * 1024) throw new Error("Slack probe response is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 128 * 1024) throw new Error("Slack probe response is too large");
  let result: { ok?: boolean; error?: string; ts?: string };
  try { result = JSON.parse(new TextDecoder().decode(bytes)) as typeof result; }
  catch { throw new Error(`Slack probe returned invalid JSON (${response.status})`); }
  if (!response.ok || result.ok !== true || typeof result.ts !== "string") {
    throw new Error(`Slack probe failed: ${result.error ?? response.status}`);
  }
  return { ts: result.ts };
}
