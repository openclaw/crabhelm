import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { CrabhelmRuntime, DeploymentRuntimeTarget } from "./config.js";
import type {
  GitHubImportMember,
  GitHubImportQuery,
  GitHubMemberSource,
} from "./github.js";
import type { OpenClawNodeControl } from "./node-control.js";
import type { CrabhelmReconciler } from "./reconciler.js";
import type { CrabhelmRegistry } from "./registry.js";
import type { CreateClawInput, CreatePolicyInput, UpdateClawInput } from "./types.js";

const routeRoot = "/plugins/crabhelm";
const staticRoot = `${routeRoot}/ui`;
const maxBodyBytes = 64 * 1024;

const assetTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createCrabhelmStaticHandler(rootDir: string) {
  const assets = new Map<string, string>([
    [staticRoot, "index.html"],
    [`${staticRoot}/`, "index.html"],
    [`${staticRoot}/app.js`, "app.js"],
    [`${staticRoot}/styles.css`, "styles.css"],
  ]);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = parseUrl(req.url)?.pathname;
    if (pathname === staticRoot) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      res.statusCode = 308;
      res.setHeader("location", `${staticRoot}/`);
      res.setHeader("cache-control", "no-store, max-age=0");
      res.end();
      return true;
    }
    const file = pathname ? assets.get(pathname) : undefined;
    if (!file) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    try {
      const body = await readFile(path.join(rootDir, "web", file));
      res.statusCode = 200;
      res.setHeader("content-type", assetTypes[path.extname(file)] ?? "application/octet-stream");
      res.setHeader("cache-control", "no-store, max-age=0");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
      );
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      sendJson(res, 404, { error: "asset not found" });
    }
    return true;
  };
}

export function createCrabhelmApiHandler(options: {
  registry: CrabhelmRegistry;
  reconciler: CrabhelmReconciler;
  nodeControl?: OpenClawNodeControl;
  githubSource?: GitHubMemberSource;
  runtime: CrabhelmRuntime;
  assertCanCreate?: (target?: string) => void;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = parseUrl(req.url);
    if (!url?.pathname.startsWith(`${routeRoot}/api`)) return false;
    try {
      if (req.method === "GET" && url.pathname === `${routeRoot}/api/state`) {
        sendJson(res, 200, { ...(await options.registry.snapshot()), runtime: options.runtime });
        return true;
      }
      if (req.method === "POST" && url.pathname === `${routeRoot}/api/policies`) {
        sendJson(
          res,
          201,
          await options.registry.createPolicy(
            (await readJsonBody(req)) as CreatePolicyInput,
            "gateway-operator",
          ),
        );
        return true;
      }
      const policyMatch = url.pathname.match(
        /^\/plugins\/crabhelm\/api\/policies\/([^/]+)\/(versions|preview|apply)$/,
      );
      if (req.method === "POST" && policyMatch) {
        const policyId = decodeURIComponent(policyMatch[1] ?? "");
        const action = policyMatch[2];
        const body = asRecord(await readJsonBody(req));
        if (action === "versions") {
          sendJson(
            res,
            201,
            await options.registry.addPolicyVersion(
              policyId,
              body as unknown as Pick<CreatePolicyInput, "description" | "spec">,
              "gateway-operator",
            ),
          );
          return true;
        }
        const version = requirePositiveInteger(body.version, "policy version");
        const clawIds = requireClawIds(body.clawIds);
        if (action === "preview") {
          sendJson(res, 200, await options.registry.previewPolicy(policyId, version, clawIds));
          return true;
        }
        const expectedGenerations = requireExpectedGenerations(body.expectedGenerations, clawIds);
        const canaryId = typeof body.canaryId === "string" && body.canaryId.trim()
          ? body.canaryId.trim()
          : undefined;
        if (canaryId && !clawIds.includes(canaryId)) {
          throw new Error("canaryId must be one of the selected claws");
        }
        if (clawIds.length > 1 && !canaryId) {
          throw new Error("a canaryId is required when applying a policy to multiple claws");
        }

        const results: Array<{
          clawId: string;
          ok: boolean;
          claw?: Awaited<ReturnType<CrabhelmReconciler["reconcileOne"]>>;
          error?: string;
          canary: boolean;
        }> = [];
        if (canaryId) {
          await options.registry.applyPolicy(
            policyId,
            version,
            [canaryId],
            expectedGenerations,
            "gateway-operator",
          );
          const canary = await reconcilePolicyTarget(options.reconciler, canaryId, true);
          results.push(canary);
          if (!canary.ok) {
            sendJson(res, 207, {
              policyId,
              version,
              canaryId,
              aborted: true,
              remainingNotApplied: clawIds.filter((id) => id !== canaryId),
              results,
            });
            return true;
          }
        }
        const remaining = clawIds.filter((id) => id !== canaryId);
        if (remaining.length) {
          await options.registry.applyPolicy(
            policyId,
            version,
            remaining,
            expectedGenerations,
            "gateway-operator",
          );
          results.push(...await mapConcurrent(
            remaining,
            3,
            (clawId) => reconcilePolicyTarget(options.reconciler, clawId, false),
          ));
        }
        const succeeded = results.filter((result) => result.ok).length;
        sendJson(res, succeeded === results.length ? 202 : 207, {
          policyId,
          version,
          canaryId,
          aborted: false,
          requested: results.length,
          succeeded,
          failed: results.length - succeeded,
          results,
        });
        return true;
      }
      if (req.method === "POST" && url.pathname === `${routeRoot}/api/claws`) {
        const input = (await readJsonBody(req)) as CreateClawInput;
        requireTarget(options.runtime, input.deployment?.target, options.assertCanCreate);
        const claw = await options.registry.create(
          input,
          "gateway-operator",
        );
        sendJson(res, 202, await options.reconciler.reconcileOne(claw.id));
        return true;
      }
      if (req.method === "POST" && url.pathname === `${routeRoot}/api/claws/batch`) {
        if (!options.runtime.targets.some((target) => target.admissionOpen)) {
          throw new Error("Crabbox provisioning is unconfigured");
        }
        const body = (await readJsonBody(req)) as { items?: unknown };
        if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
          throw new Error("batch items must contain between 1 and 50 claws");
        }
        const results = await mapConcurrent(body.items, 3, async (input) => {
          try {
            const spec = input as CreateClawInput;
            requireTarget(options.runtime, spec.deployment?.target, options.assertCanCreate);
            const claw = await options.registry.create(
              spec,
              "gateway-operator",
            );
            return { ok: true as const, claw: await options.reconciler.reconcileOne(claw.id) };
          } catch (error) {
            return {
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        });
        const succeeded = results.filter((result) => result.ok).length;
        sendJson(res, succeeded === results.length ? 202 : 207, {
          requested: results.length,
          succeeded,
          failed: results.length - succeeded,
          results,
        });
        return true;
      }
      if (req.method === "POST" && url.pathname === `${routeRoot}/api/import/github/preview`) {
        if (!options.githubSource) {
          throw new Error("GitHub organization import is unconfigured");
        }
        const query = (await readJsonBody(req)) as GitHubImportQuery;
        sendJson(res, 200, await options.githubSource.preview(query));
        return true;
      }
      if (req.method === "POST" && url.pathname === `${routeRoot}/api/import/github`) {
        if (!options.githubSource) {
          throw new Error("GitHub organization import is unconfigured");
        }
        const body = asRecord(await readJsonBody(req));
        const target = requireTarget(
          options.runtime,
          asRecord(body.options).target,
          options.assertCanCreate,
        );
        const ids = requireMemberIds(body.memberIds);
        const preview = await options.githubSource.preview(body.query as GitHubImportQuery);
        const membersById = new Map(preview.members.map((member) => [member.id, member]));
        const selected = ids.map((id) => membersById.get(id));
        if (selected.some((member) => !member)) {
          throw new Error("one or more selected GitHub member ids are not in the current preview");
        }
        const results = await mapConcurrent(selected as GitHubImportMember[], 3, async (member) => {
          try {
            const claw = await options.registry.create(
              githubCreateInput(member, body.options, target),
              "gateway-operator",
            );
            return { ok: true as const, member, claw: await options.reconciler.reconcileOne(claw.id) };
          } catch (error) {
            return {
              ok: false as const,
              member,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        });
        const succeeded = results.filter((result) => result.ok).length;
        sendJson(res, succeeded === results.length ? 202 : 207, {
          requested: results.length,
          succeeded,
          failed: results.length - succeeded,
          results,
        });
        return true;
      }
      const match = url.pathname.match(/^\/plugins\/crabhelm\/api\/claws\/([^/]+)(?:\/(.+))?$/);
      if (!match) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      const id = decodeURIComponent(match[1] ?? "");
      const action = match[2];
      if (req.method === "GET" && action === "pairing") {
        if (!options.nodeControl) throw new Error("child pairing control is unavailable");
        const claw = await options.registry.get(id);
        const channel = url.searchParams.get("channel") ?? "slack";
        if (channel !== "slack") throw new Error("only Slack pairing is supported");
        const accountId = url.searchParams.get("account")?.trim() || undefined;
        sendJson(
          res,
          200,
          await options.nodeControl.listPairing(claw, { channel, ...(accountId ? { accountId } : {}) }),
        );
        return true;
      }
      if (req.method === "POST" && action === "pairing/approve") {
        if (!options.nodeControl) throw new Error("child pairing control is unavailable");
        const body = (await readJsonBody(req)) as {
          channel?: unknown;
          accountId?: unknown;
          code?: unknown;
        };
        const channel = body.channel ?? "slack";
        if (channel !== "slack") throw new Error("only Slack pairing is supported");
        if (typeof body.code !== "string") throw new Error("pairing code is required");
        const claw = await options.registry.get(id);
        const approved = await options.nodeControl.approvePairing(claw, {
          channel,
          code: body.code,
          ...(typeof body.accountId === "string" && body.accountId.trim()
            ? { accountId: body.accountId.trim() }
            : {}),
        });
        const pairedAt = new Date().toISOString();
        const updated = await options.registry.writeObserved(
          id,
          {
            ...claw.observed,
            userAccess: {
              channel,
              subjectId: approved.approved.id,
              ...(approved.approved.label ? { label: approved.approved.label } : {}),
              status: "paired",
              pairedAt,
            },
          },
          {
            actor: "gateway-operator",
            action: "claw.user-pairing.approve",
            outcome: "succeeded",
            summary: `Approved Slack pairing for ${claw.desired.name}`,
            generation: claw.desired.generation,
            details: { subjectId: approved.approved.id },
          },
          { expectedRevision: claw.revision },
        );
        sendJson(res, 200, { approved, claw: updated });
        return true;
      }
      if (req.method === "GET" && !action) {
        sendJson(res, 200, await options.registry.get(id));
        return true;
      }
      if (req.method === "PATCH" && !action) {
        const claw = await options.registry.update(
          id,
          (await readJsonBody(req)) as UpdateClawInput,
          "gateway-operator",
        );
        sendJson(res, 202, await options.reconciler.reconcileOne(claw.id));
        return true;
      }
      if (req.method === "POST" && action === "reconcile") {
        sendJson(res, 200, await options.reconciler.reconcileOne(id));
        return true;
      }
      if (req.method === "POST" && (action === "disable" || action === "enable")) {
        const claw = await options.registry.setEnabled(
          id,
          action === "enable",
          "gateway-operator",
        );
        sendJson(res, 202, await options.reconciler.reconcileOne(claw.id));
        return true;
      }
      if (req.method === "DELETE" && !action) {
        const body = (await readJsonBody(req)) as { confirmation?: unknown };
        const claw = await options.registry.requestRemoval(
          id,
          "gateway-operator",
          typeof body.confirmation === "string" ? body.confirmation : "",
        );
        sendJson(res, 202, await options.reconciler.reconcileOne(claw.id));
        return true;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    } catch (error) {
      sendJson(res, error instanceof SyntaxError ? 400 : 422, {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  };
}

async function reconcilePolicyTarget(
  reconciler: CrabhelmReconciler,
  clawId: string,
  canary: boolean,
): Promise<{
  clawId: string;
  ok: boolean;
  claw?: Awaited<ReturnType<CrabhelmReconciler["reconcileOne"]>>;
  error?: string;
  canary: boolean;
}> {
  try {
    const claw = await reconciler.reconcileOne(clawId);
    const ok = claw.observed.generation === claw.desired.generation &&
      (claw.observed.phase === "ready" || claw.observed.phase === "disabled");
    return {
      clawId,
      ok,
      claw,
      ...(ok ? {} : { error: `policy did not converge: ${claw.observed.message}` }),
      canary,
    };
  } catch (error) {
    return {
      clawId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      canary,
    };
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function requireClawIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error("clawIds must contain between 1 and 100 ids");
  }
  const ids = value.map((id) => typeof id === "string" ? id.trim() : "");
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("clawIds must contain unique non-empty ids");
  }
  return ids;
}

function requireExpectedGenerations(value: unknown, clawIds: string[]): Record<string, number> {
  const input = asRecord(value);
  const result: Record<string, number> = {};
  for (const id of clawIds) {
    const generation = input[id];
    if (!Number.isInteger(generation) || Number(generation) < 0) {
      throw new Error(`expected generation is required for claw ${id}`);
    }
    result[id] = Number(generation);
  }
  return result;
}

function requireTarget(
  runtime: CrabhelmRuntime,
  value: unknown,
  assertCanCreate?: (target?: string) => void,
): DeploymentRuntimeTarget {
  const id = typeof value === "string" && value.trim() ? value.trim() : runtime.defaultTarget;
  const target = runtime.targets.find((item) => item.id === id);
  if (!target) throw new Error(`deployment target ${id} is not configured`);
  assertCanCreate?.(id);
  if (!target.admissionOpen) throw new Error(target.message ?? `deployment target ${id} is unavailable`);
  return target;
}

function requireMemberIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new Error("memberIds must contain between 1 and 50 numeric ids");
  }
  const ids = [...new Set(value)];
  if (ids.length !== value.length || ids.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)) {
    throw new Error("memberIds must contain unique positive numeric ids");
  }
  return ids as number[];
}

function githubCreateInput(
  member: GitHubImportMember,
  value: unknown,
  target: DeploymentRuntimeTarget,
): CreateClawInput {
  const input = asRecord(value);
  const model = requireString(input.model, "model");
  const dmPolicy = input.dmPolicy;
  const groupPolicy = input.groupPolicy;
  const logLevel = input.logLevel;
  if (typeof input.slackEnabled !== "boolean") throw new Error("slackEnabled is required");
  if (dmPolicy !== "pairing" && dmPolicy !== "allowlist" && dmPolicy !== "disabled") {
    throw new Error("dmPolicy is invalid");
  }
  if (groupPolicy !== "allowlist" && groupPolicy !== "disabled") {
    throw new Error("groupPolicy is invalid");
  }
  if (logLevel !== "error" && logLevel !== "warn" && logLevel !== "info" && logLevel !== "debug") {
    throw new Error("logLevel is invalid");
  }
  return {
    name: `${member.login} maintainer claw`,
    slug: `gh-${member.id}`,
    owner: {
      subject: `github:id:${member.id}`,
      label: `@${member.login}`,
      source: "github",
    },
    templateId: "github-maintainer",
    deployment: {
      target: target.id,
      profile: target.profile,
      ...(target.region ? { region: target.region } : {}),
    },
    inference: { model },
    slack: { enabled: input.slackEnabled, mode: "socket" },
    access: { dmPolicy, groupPolicy },
    observability: { logLevel },
  };
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await operation(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new Error("request body exceeds 64 KiB");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseUrl(value?: string): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, "http://127.0.0.1");
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
}
