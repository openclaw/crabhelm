import { jsonResult, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type { CrabhelmRuntime } from "./config.js";
import type { GitHubImportQuery, GitHubMemberSource } from "./github.js";
import type { OpenClawNodeControl } from "./node-control.js";
import type { CrabhelmReconciler } from "./reconciler.js";
import type { CrabhelmRegistry } from "./registry.js";
import type {
  ClawRecord,
  CreateClawInput,
  ManagedPolicySpec,
  OwnerRef,
  UpdateClawInput,
} from "./types.js";

const actionSchema = Type.Union([
  Type.Literal("list"),
  Type.Literal("get"),
  Type.Literal("create"),
  Type.Literal("update"),
  Type.Literal("disable"),
  Type.Literal("enable"),
  Type.Literal("remove"),
  Type.Literal("reconcile"),
  Type.Literal("pairing_list"),
  Type.Literal("pairing_approve"),
  Type.Literal("github_preview"),
  Type.Literal("github_import"),
  Type.Literal("policy_list"),
  Type.Literal("policy_create"),
  Type.Literal("policy_version"),
  Type.Literal("policy_preview"),
  Type.Literal("policy_apply"),
]);

const paramsSchema = Type.Object(
  {
    action: actionSchema,
    claw_id: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    owner_subject: Type.Optional(Type.String()),
    owner_label: Type.Optional(Type.String()),
    owner_source: Type.Optional(
      Type.Union([
        Type.Literal("github"),
        Type.Literal("slack"),
        Type.Literal("email"),
        Type.Literal("manual"),
      ]),
    ),
    model: Type.Optional(Type.String()),
    deployment_target: Type.Optional(Type.String()),
    confirmation: Type.Optional(Type.String()),
    pairing_code: Type.Optional(Type.String()),
    account_id: Type.Optional(Type.String()),
    github_scope: Type.Optional(
      Type.Union([Type.Literal("organization"), Type.Literal("team"), Type.Literal("repository")]),
    ),
    organization: Type.Optional(Type.String()),
    github_target: Type.Optional(Type.String()),
    github_role: Type.Optional(Type.String()),
    github_member_ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 50 })),
    slack_enabled: Type.Optional(Type.Boolean()),
    dm_policy: Type.Optional(
      Type.Union([Type.Literal("pairing"), Type.Literal("allowlist"), Type.Literal("disabled")]),
    ),
    group_policy: Type.Optional(Type.Union([Type.Literal("allowlist"), Type.Literal("disabled")])),
    log_level: Type.Optional(
      Type.Union([Type.Literal("error"), Type.Literal("warn"), Type.Literal("info"), Type.Literal("debug")]),
    ),
    policy_id: Type.Optional(Type.String()),
    policy_version: Type.Optional(Type.Integer({ minimum: 1 })),
    policy_description: Type.Optional(Type.String()),
    fallback_models: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    claw_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
    expected_generations: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))),
    canary_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

type ToolParams = {
  action: "list" | "get" | "create" | "update" | "disable" | "enable" | "remove" | "reconcile" | "pairing_list" | "pairing_approve" | "github_preview" | "github_import" | "policy_list" | "policy_create" | "policy_version" | "policy_preview" | "policy_apply";
  claw_id?: string;
  name?: string;
  owner_subject?: string;
  owner_label?: string;
  owner_source?: OwnerRef["source"];
  model?: string;
  deployment_target?: string;
  confirmation?: string;
  pairing_code?: string;
  account_id?: string;
  github_scope?: "organization" | "team" | "repository";
  organization?: string;
  github_target?: string;
  github_role?: string;
  github_member_ids?: number[];
  slack_enabled?: boolean;
  dm_policy?: "pairing" | "allowlist" | "disabled";
  group_policy?: "allowlist" | "disabled";
  log_level?: "error" | "warn" | "info" | "debug";
  policy_id?: string;
  policy_version?: number;
  policy_description?: string;
  fallback_models?: string[];
  claw_ids?: string[];
  expected_generations?: Record<string, number>;
  canary_id?: string;
};

export function createCrabhelmTool(options: {
  registry: CrabhelmRegistry;
  reconciler: CrabhelmReconciler;
  nodeControl: OpenClawNodeControl;
  githubSource?: GitHubMemberSource;
  assertCanCreate?: (target?: string) => void;
  runtime?: CrabhelmRuntime;
}): AnyAgentTool {
  return {
    name: "crabhelm",
    label: "Crabhelm",
    description:
      "Inspect or administer independently deployed OpenClaw child cores. Mutations use OpenClaw's plugin approval flow. A child is one complete Gateway/state/OS identity, never an agent inside the parent Gateway.",
    parameters: paramsSchema,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ToolParams;
      switch (params.action) {
        case "list":
          return jsonResult({
            ...(await options.registry.snapshot()),
            ...(options.runtime ? { runtime: options.runtime } : {}),
          });
        case "get":
          return jsonResult(await options.registry.get(requireId(params)));
        case "create": {
          options.assertCanCreate?.(params.deployment_target);
          const input: CreateClawInput = {
            name: requireString(params.name, "name"),
            owner: {
              subject: requireString(params.owner_subject, "owner_subject"),
              label: params.owner_label?.trim() || requireString(params.owner_subject, "owner_subject"),
              source: params.owner_source ?? "manual",
            },
            ...(params.deployment_target
              ? { deployment: { target: params.deployment_target } }
              : {}),
            ...(params.model ? { inference: { model: params.model } } : {}),
            ...(params.slack_enabled !== undefined
              ? { slack: { enabled: params.slack_enabled, mode: "socket" } }
              : {}),
            ...(params.dm_policy || params.group_policy
              ? { access: {
                  ...(params.dm_policy ? { dmPolicy: params.dm_policy } : {}),
                  ...(params.group_policy ? { groupPolicy: params.group_policy } : {}),
                } }
              : {}),
            ...(params.log_level ? { observability: { logLevel: params.log_level } } : {}),
          };
          const claw = await options.registry.create(input, "parent-core-agent");
          return jsonResult(await options.reconciler.reconcileOne(claw.id));
        }
        case "update": {
          const patch: UpdateClawInput = {};
          if (params.name) patch.name = params.name;
          if (params.model) patch.inference = { model: params.model };
          if (params.slack_enabled !== undefined) {
            patch.slack = { enabled: params.slack_enabled };
          }
          if (params.dm_policy || params.group_policy) {
            patch.access = {
              ...(params.dm_policy ? { dmPolicy: params.dm_policy } : {}),
              ...(params.group_policy ? { groupPolicy: params.group_policy } : {}),
            };
          }
          if (params.log_level) patch.observability = { logLevel: params.log_level };
          const claw = await options.registry.update(
            requireId(params),
            patch,
            "parent-core-agent",
          );
          return jsonResult(await options.reconciler.reconcileOne(claw.id));
        }
        case "disable":
        case "enable": {
          const claw = await options.registry.setEnabled(
            requireId(params),
            params.action === "enable",
            "parent-core-agent",
          );
          return jsonResult(await options.reconciler.reconcileOne(claw.id));
        }
        case "remove": {
          const claw = await options.registry.requestRemoval(
            requireId(params),
            "parent-core-agent",
            requireString(params.confirmation, "confirmation"),
          );
          return jsonResult(await options.reconciler.reconcileOne(claw.id));
        }
        case "reconcile":
          return jsonResult(await options.reconciler.reconcileOne(requireId(params)));
        case "pairing_list": {
          const claw = await options.registry.get(requireId(params));
          return jsonResult(await options.nodeControl.listPairing(claw, {
            ...(params.account_id?.trim() ? { accountId: params.account_id.trim() } : {}),
          }));
        }
        case "pairing_approve": {
          const claw = await options.registry.get(requireId(params));
          const approved = await options.nodeControl.approvePairing(claw, {
            code: requireString(params.pairing_code, "pairing_code"),
            ...(params.account_id?.trim() ? { accountId: params.account_id.trim() } : {}),
          });
          const pairedAt = new Date().toISOString();
          const updated = await options.registry.writeObserved(
            claw.id,
            {
              ...claw.observed,
              userAccess: {
                channel: "slack",
                subjectId: approved.approved.id,
                ...(approved.approved.label ? { label: approved.approved.label } : {}),
                status: "paired",
                pairedAt,
              },
            },
            {
              actor: "parent-core-agent",
              action: "claw.user-pairing.approve",
              outcome: "succeeded",
              summary: `Approved Slack pairing for ${claw.desired.name}`,
              generation: claw.desired.generation,
              details: { subjectId: approved.approved.id },
            },
            { expectedRevision: claw.revision },
          );
          return jsonResult({ approved, claw: updated });
        }
        case "github_preview": {
          if (!options.githubSource) throw new Error("GitHub organization import is unconfigured");
          return jsonResult(await options.githubSource.preview(githubQuery(params)));
        }
        case "github_import": {
          options.assertCanCreate?.(params.deployment_target);
          if (!options.githubSource) throw new Error("GitHub organization import is unconfigured");
          const ids = [...new Set(params.github_member_ids ?? [])];
          if (!ids.length || ids.length > 50) {
            throw new Error("github_member_ids must contain between 1 and 50 numeric ids");
          }
          const preview = await options.githubSource.preview(githubQuery(params));
          const selected = preview.members.filter((member) => ids.includes(member.id));
          if (selected.length !== ids.length) {
            throw new Error("one or more selected GitHub member ids are not in the current preview");
          }
          const results = await mapConcurrent(selected, 3, async (member) => {
            try {
              const claw = await options.registry.create(
                {
                  name: `${member.login} maintainer claw`,
                  slug: `gh-${member.id}`,
                  owner: {
                    subject: `github:id:${member.id}`,
                    label: `@${member.login}`,
                    source: "github",
                  },
                  templateId: "github-maintainer",
                  ...(params.deployment_target
                    ? { deployment: { target: params.deployment_target } }
                    : {}),
                  ...(params.model ? { inference: { model: params.model } } : {}),
                  ...(params.slack_enabled !== undefined
                    ? { slack: { enabled: params.slack_enabled, mode: "socket" as const } }
                    : {}),
                  ...(params.dm_policy || params.group_policy
                    ? { access: {
                        ...(params.dm_policy ? { dmPolicy: params.dm_policy } : {}),
                        ...(params.group_policy ? { groupPolicy: params.group_policy } : {}),
                      } }
                    : {}),
                  ...(params.log_level ? { observability: { logLevel: params.log_level } } : {}),
                },
                "parent-core-agent",
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
          return jsonResult({
            requested: results.length,
            succeeded: results.filter((result) => result.ok).length,
            failed: results.filter((result) => !result.ok).length,
            results,
          });
        }
        case "policy_list":
          return jsonResult(await options.registry.listPolicies());
        case "policy_create":
          return jsonResult(await options.registry.createPolicy({
            name: requireString(params.name, "name"),
            description: params.policy_description ?? "",
            spec: managedPolicySpec(params),
          }, "parent-core-agent"));
        case "policy_version":
          return jsonResult(await options.registry.addPolicyVersion(
            requireString(params.policy_id, "policy_id"),
            { description: params.policy_description, spec: managedPolicySpec(params) },
            "parent-core-agent",
          ));
        case "policy_preview":
          return jsonResult(await options.registry.previewPolicy(
            requireString(params.policy_id, "policy_id"),
            requirePositiveInteger(params.policy_version, "policy_version"),
            requireClawIds(params.claw_ids),
          ));
        case "policy_apply": {
          const policyId = requireString(params.policy_id, "policy_id");
          const version = requirePositiveInteger(params.policy_version, "policy_version");
          const clawIds = requireClawIds(params.claw_ids);
          const expectedGenerations = params.expected_generations ?? {};
          const canaryId = params.canary_id?.trim() || undefined;
          if (canaryId && !clawIds.includes(canaryId)) {
            throw new Error("canary_id must be one of claw_ids");
          }
          if (clawIds.length > 1 && !canaryId) {
            throw new Error("canary_id is required when applying a policy to multiple claws");
          }
          const results: Array<{ clawId: string; ok: boolean; canary: boolean; claw?: ClawRecord; error?: string }> = [];
          if (canaryId) {
            await options.registry.applyPolicy(
              policyId,
              version,
              [canaryId],
              expectedGenerations,
              "parent-core-agent",
            );
            const canary = await reconcilePolicyTarget(options.reconciler, canaryId, true);
            results.push(canary);
            if (!canary.ok) {
              return jsonResult({
                policyId,
                version,
                canaryId,
                aborted: true,
                remainingNotApplied: clawIds.filter((id) => id !== canaryId),
                results,
              });
            }
          }
          const remaining = clawIds.filter((id) => id !== canaryId);
          if (remaining.length) {
            await options.registry.applyPolicy(
              policyId,
              version,
              remaining,
              expectedGenerations,
              "parent-core-agent",
            );
            results.push(...await mapConcurrent(
              remaining,
              3,
              (clawId) => reconcilePolicyTarget(options.reconciler, clawId, false),
            ));
          }
          return jsonResult({
            policyId,
            version,
            canaryId,
            aborted: false,
            requested: results.length,
            succeeded: results.filter((result) => result.ok).length,
            failed: results.filter((result) => !result.ok).length,
            results,
          });
        }
      }
    },
  };
}

export function isCrabhelmMutation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = (value as Record<string, unknown>).action;
  return typeof action === "string" && !["list", "get", "pairing_list", "github_preview", "policy_list", "policy_preview"].includes(action);
}

export function crabhelmApprovalCopy(value: unknown, defaultTarget?: string): {
  title: string;
  description: string;
  severity: "warning" | "critical";
} {
  const params = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const action = typeof params.action === "string" ? params.action : "mutate";
  const target =
    (typeof params.name === "string" && params.name) ||
    (typeof params.claw_id === "string" && params.claw_id) ||
    (typeof params.policy_id === "string" && params.policy_id) ||
    (typeof params.organization === "string" && params.organization) ||
    "child core";
  const deploymentTarget = typeof params.deployment_target === "string" && params.deployment_target
    ? params.deployment_target
    : defaultTarget;
  const placement = deploymentTarget
    ? ` on deployment target ${deploymentTarget}`
    : "";
  return {
    title: action === "remove" ? "Remove child core" : `${capitalize(action)} child core`,
    description: `${action} ${target}${placement} through the Crabhelm parent control plane.`,
    severity: action === "remove" ? "critical" : "warning",
  };
}

function managedPolicySpec(params: ToolParams): ManagedPolicySpec {
  return {
    inference: {
      model: requireString(params.model, "model"),
      fallbackModels: params.fallback_models ?? [],
    },
    slackEnabled: params.slack_enabled ?? false,
    access: {
      dmPolicy: params.dm_policy ?? "pairing",
      groupPolicy: params.group_policy ?? "allowlist",
    },
    observability: { logLevel: params.log_level ?? "info" },
  };
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function requireClawIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error("claw_ids must contain between 1 and 100 ids");
  }
  const ids = value.map((id) => typeof id === "string" ? id.trim() : "");
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("claw_ids must contain unique non-empty ids");
  }
  return ids;
}

async function reconcilePolicyTarget(
  reconciler: CrabhelmReconciler,
  clawId: string,
  canary: boolean,
): Promise<{ clawId: string; ok: boolean; canary: boolean; claw?: ClawRecord; error?: string }> {
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
    return { clawId, ok: false, error: error instanceof Error ? error.message : String(error), canary };
  }
}

function githubQuery(params: ToolParams): GitHubImportQuery {
  const organization = requireString(params.organization, "organization");
  if (params.github_scope === "team") {
    const role = params.github_role;
    if (role !== undefined && role !== "all" && role !== "maintainer" && role !== "member") {
      throw new Error("github_role must be all, maintainer, or member for a team");
    }
    return {
      scope: "team",
      organization,
      team: requireString(params.github_target, "github_target"),
      ...(role ? { role } : {}),
    };
  }
  if (params.github_scope === "repository") {
    const permission = params.github_role;
    if (permission !== undefined && permission !== "maintain" && permission !== "admin") {
      throw new Error("github_role must be maintain or admin for a repository");
    }
    return {
      scope: "repository",
      organization,
      repository: requireString(params.github_target, "github_target"),
      ...(permission ? { permission } : {}),
    };
  }
  const role = params.github_role;
  if (role !== undefined && role !== "all" && role !== "admin" && role !== "member") {
    throw new Error("github_role must be all, admin, or member for an organization");
  }
  return { scope: "organization", organization, ...(role ? { role } : {}) };
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

function requireId(params: ToolParams): string {
  return requireString(params.claw_id, "claw_id");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : "Change";
}
