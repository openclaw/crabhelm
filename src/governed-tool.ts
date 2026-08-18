import { jsonResult, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { boundedJson, providerError, waitForConfirmation } from "./governed-confirmation.js";

const parameters = Type.Object({
  capability: Type.Union([
    Type.Literal("github.repository.read"),
    Type.Literal("github.issue.read"),
    Type.Literal("github.issue.comment"),
  ]),
  repository: Type.String({ minLength: 3, maxLength: 200, description: "GitHub owner/repository" }),
  issueNumber: Type.Optional(Type.Integer({ minimum: 1 })),
  body: Type.Optional(Type.String({ minLength: 1, maxLength: 10240 })),
}, { additionalProperties: false });

type Params = {
  capability: "github.repository.read" | "github.issue.read" | "github.issue.comment";
  repository: string;
  issueNumber?: number;
  body?: string;
};

type TurnContext = { jobId: string; turnToken: string };
type IssuedInvocation = Record<string, unknown> & {
  confirmationRequired?: boolean;
  confirmation?: { id?: string };
  grant?: string;
  invocation?: { id?: string };
  executeUrl?: string;
};

export function createGovernedGithubTool(stateDir: string): AnyAgentTool {
  return {
    name: "crabhelm_github",
    label: "Governed GitHub",
    description: "Read repository or issue metadata, or post a confirmed issue comment, using the requester's connected GitHub identity. Credentials never enter this runtime.",
    parameters,
    async execute(_toolCallId, raw, signal?: AbortSignal) {
      const params = raw as Params;
      const context = await readTurnContext(stateDir);
      const controlUrl = runtimeUrl();
      const args: Record<string, string | number | boolean | null> = {};
      if (params.capability !== "github.repository.read") args.issueNumber = requiredIssue(params.issueNumber);
      if (params.capability === "github.issue.comment") args.body = requiredBody(params.body);
      const input = { capabilityId: params.capability, target: params.repository, arguments: args };
      let issued = await issue(controlUrl, context.turnToken, input);
      if (issued.confirmationRequired && issued.confirmation?.id) {
        const confirmationId = issued.confirmation.id;
        const status = await waitForConfirmation(controlUrl, context.turnToken, confirmationId, signal);
        if (status !== "approved") return jsonResult({ ok: false, confirmation: status, message: `Requester ${status} the GitHub action.` });
        issued = await issue(controlUrl, context.turnToken, { ...input, confirmationId });
      }
      if (!issued.grant || !issued.invocation?.id || !issued.executeUrl) throw new Error("Crabhelm did not issue a governed invocation");
      const execute = new URL(issued.executeUrl);
      if (execute.origin !== new URL(controlUrl).origin || execute.pathname !== "/api/tools/github/execute") throw new Error("Crabhelm returned an invalid tool endpoint");
      const response = await fetch(execute, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${issued.grant}`, "content-type": "application/json" },
        body: JSON.stringify({ invocationId: issued.invocation.id, arguments: args }),
      });
      const result = await boundedJson(response);
      if (!response.ok) throw new Error(providerError(result, response.status));
      return jsonResult(result);
    },
  };
}

async function issue(controlUrl: string, turnToken: string, input: Record<string, unknown>): Promise<IssuedInvocation> {
  const response = await fetch(new URL("/api/runtime/invocations/issue", controlUrl), {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${turnToken}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await boundedJson(response);
  if (response.status !== 201 && response.status !== 202) throw new Error(providerError(result, response.status));
  return result as IssuedInvocation;
}

async function readTurnContext(stateDir: string): Promise<TurnContext> {
  const file = path.join(stateDir, "crabhelm-current-turn.json");
  const info = await lstat(file);
  if (info.isFile?.() !== true || info.isSymbolicLink?.() === true || info.uid !== currentUid() || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024) throw new Error("governed turn context is unavailable");
  const value = JSON.parse(await readFile(file, "utf8")) as TurnContext;
  if (!value.jobId || !value.turnToken || value.turnToken.length > 4096) throw new Error("governed turn context is invalid");
  return value;
}

function runtimeUrl(): string {
  const value = process.env.CRABHELM_CONTROL_URL?.trim();
  if (!value) throw new Error("Crabhelm runtime URL is unavailable");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Crabhelm runtime URL must use HTTPS");
  return url.origin;
}

function requiredIssue(value: number | undefined): number { if (!Number.isInteger(value) || Number(value) < 1) throw new Error("issueNumber is required"); return Number(value); }
function requiredBody(value: string | undefined): string { const body = value?.trim(); if (!body) throw new Error("comment body is required"); return body; }
function currentUid(): number { if (typeof process.getuid !== "function") throw new Error("runtime user identity is unavailable"); return process.getuid(); }
