export type DeploymentTargetConfig = {
  id: string;
  label: string;
  region?: string;
  crabboxUrl?: string;
  tokenEnv: string;
  profile: string;
  ttlSeconds: number;
  idleTimeoutSeconds: number;
};

export type DeploymentRuntimeTarget = Pick<
  DeploymentTargetConfig,
  "id" | "label" | "region" | "profile" | "ttlSeconds" | "idleTimeoutSeconds"
> & {
  admissionOpen: boolean;
  message?: string;
};

export type CrabhelmRuntime = {
  mode: "simulator" | "crabbox" | "partial" | "unconfigured";
  defaultTarget: string;
  targets: DeploymentRuntimeTarget[];
  githubImport: boolean;
  inference: {
    kind: "direct" | "clawrouter";
    defaultModel: string;
    metadataOnly: true;
    baseUrl?: string;
    tenantId?: string;
    allowedProviders?: string[];
  };
};

export type CrabhelmConfig = {
  mode: "parent" | "child";
  childId?: string;
  reconcileIntervalSeconds: number;
  deployment: {
    simulator: boolean;
    defaultTarget: string;
    targets: DeploymentTargetConfig[];
  };
  github: {
    apiUrl: string;
    tokenEnv: string;
    maxMembers: number;
  };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export function resolveCrabhelmConfig(value: unknown): CrabhelmConfig {
  const root = record(value);
  const deployment = record(root.deployment);
  const github = record(root.github);
  return {
    mode: root.mode === "child" ? "child" : "parent",
    ...(typeof root.childId === "string" && root.childId.trim()
      ? { childId: root.childId.trim() }
      : {}),
    reconcileIntervalSeconds: integer(root.reconcileIntervalSeconds, 15, 5, 300),
    deployment: resolveDeployment(deployment),
    github: {
      apiUrl:
        typeof github.apiUrl === "string" && github.apiUrl.trim()
          ? github.apiUrl.trim()
          : "https://api.github.com",
      tokenEnv:
        typeof github.tokenEnv === "string" && github.tokenEnv.trim()
          ? github.tokenEnv.trim()
          : "CRABHELM_GITHUB_TOKEN",
      maxMembers: integer(github.maxMembers, 500, 1, 500),
    },
  };
}

function resolveDeployment(value: Record<string, unknown>): CrabhelmConfig["deployment"] {
  const rawTargets = Array.isArray(value.targets) ? value.targets : [];
  const targets = rawTargets.length
    ? rawTargets.map((target, index) => resolveTarget(record(target), index))
    : [resolveTarget({}, 0)];
  const ids = new Set<string>();
  for (const target of targets) {
    if (ids.has(target.id)) throw new Error(`deployment target ${target.id} is duplicated`);
    ids.add(target.id);
  }
  const defaultTarget = text(value.defaultTarget, "default");
  if (!ids.has(defaultTarget)) {
    throw new Error(`deployment.defaultTarget must name a configured target (${[...ids].join(", ")})`);
  }
  return { simulator: value.simulator === true, defaultTarget, targets };
}

function resolveTarget(value: Record<string, unknown>, index: number): DeploymentTargetConfig {
  const id = text(value.id, index === 0 ? "default" : "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(id)) {
    throw new Error(`deployment.targets[${index}].id must be a lowercase DNS label`);
  }
  const profile = text(value.profile, "openclaw-core");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(profile)) {
    throw new Error(`deployment target ${id} profile must be a lowercase DNS label`);
  }
  const tokenEnv = text(value.tokenEnv, "CRABHELM_CRABBOX_TOKEN");
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(tokenEnv)) {
    throw new Error(`deployment target ${id} tokenEnv is invalid`);
  }
  return {
    id,
    label: text(value.label, id),
    ...(text(value.region, "") ? { region: text(value.region, "") } : {}),
    ...(text(value.crabboxUrl, "") ? { crabboxUrl: text(value.crabboxUrl, "") } : {}),
    tokenEnv,
    profile,
    ttlSeconds: integer(value.ttlSeconds, 14_400, 300, 31_536_000),
    idleTimeoutSeconds: integer(value.idleTimeoutSeconds, 14_400, 60, 31_536_000),
  };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
