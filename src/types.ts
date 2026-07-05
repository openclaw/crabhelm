export type ClawPhase =
  | "requested"
  | "provisioning"
  | "enrolling"
  | "ready"
  | "disabled"
  | "deleting"
  | "deleted"
  | "attention";

export type OwnerRef = {
  subject: string;
  label: string;
  source: "github" | "slack" | "email" | "manual";
};

export type DeploymentSpec = {
  target: string;
  profile: string;
  region?: string;
  appliance?: ApplianceRelease;
};

export type ApplianceRelease = {
  manifestSha256: string;
  archiveSha256: string;
  nodeSha256: string;
};

export type DeploymentInput = Partial<Omit<DeploymentSpec, "appliance">> & {
  appliance?: ApplianceRelease | null;
};

export type InferencePolicy = {
  provider: string;
  model: string;
  fallbackModels: string[];
  authRef?: string;
  monthlyBudgetUsd?: number;
};

export type SlackPolicy = {
  enabled: boolean;
  mode: "relay" | "socket" | "http";
  workspaceId?: string;
  routeKey?: string;
  botTokenRef?: string;
  relayTokenRef?: string;
};

export type AccessPolicy = {
  dmPolicy: "pairing" | "allowlist" | "disabled";
  groupPolicy: "allowlist" | "disabled";
};

export type ObservabilityPolicy = {
  logLevel: "error" | "warn" | "info" | "debug";
  retentionDays: number;
  metadataOnly: true;
};

export type ManagedPolicySpec = {
  inference: {
    model: string;
    fallbackModels: string[];
  };
  slackEnabled: boolean;
  access: AccessPolicy;
  observability: {
    logLevel: ObservabilityPolicy["logLevel"];
  };
};

export type PolicyTemplateVersion = {
  version: number;
  createdAt: string;
  createdBy: string;
  spec: ManagedPolicySpec;
};

export type PolicyTemplate = {
  id: string;
  name: string;
  description: string;
  versions: PolicyTemplateVersion[];
  createdAt: string;
  updatedAt: string;
};

export type CreatePolicyInput = {
  name: string;
  description?: string;
  spec: ManagedPolicySpec;
};

export type PolicyFieldChange = {
  field: string;
  before: string | boolean;
  after: string | boolean;
};

export type PolicyApplicationPreview = {
  policyId: string;
  policyName: string;
  version: number;
  targets: Array<{
    clawId: string;
    clawName: string;
    expectedGeneration: number;
    changes: PolicyFieldChange[];
  }>;
};

export type ClawDesired = {
  generation: number;
  name: string;
  slug: string;
  owner: OwnerRef;
  templateId: string;
  templateVersion: number;
  deployment: DeploymentSpec;
  inference: InferencePolicy;
  channels: {
    slack: SlackPolicy;
  };
  access: AccessPolicy;
  observability: ObservabilityPolicy;
  enabled: boolean;
  // Credential epoch: bumping it forces the child to re-fetch its delivered
  // credentials (release-keyed in-place reinstall) after a Worker secret
  // rotation. Records persisted before this field exist read as epoch 1.
  credentialsGeneration: number;
};

export type LifecycleIdentity = {
  workspaceId: string;
  providerResourceId?: string;
  responseDigest: string;
};

export type ParentControlLink = {
  status: "pending" | "paired" | "offline" | "revoked";
  transport: "openclaw-node" | "crabbox-workspace";
  command: "crabhelm.child.status" | "crabhelm.bootstrap.status";
  nodeId?: string;
  lastSeenAt?: string;
};

export type DeletionState = {
  stage: "disable" | "drain" | "release" | "confirm" | "revoke";
  requestedAt: string;
  lastAttemptAt?: string;
  drainedAt?: string;
};

export type ChildOperationalProbes = {
  checkedAt: string;
  slack: {
    status: "healthy" | "degraded" | "unconfigured";
    configured: boolean;
    connected: boolean;
    accountCount: number;
    probeOk?: boolean;
    auditOk?: boolean;
    lastError?: string;
    lastInboundAt?: number;
    lastOutboundAt?: number;
  };
  model: {
    status: "ready" | "degraded";
    configuredModel: string;
    resolvedModel?: string;
    authReady: boolean;
    liveInferenceProbe: boolean;
    missingProviders: string[];
    unusableProfileCount: number;
  };
  diagnostics: {
    logLevel: "error" | "warn" | "info" | "debug";
    redaction: "tools" | "off" | "default";
    processUptimeSeconds: number;
    rssBytes: number;
    nodeVersion: string;
    platform: string;
    contentCaptured: false;
  };
};

export type ClawObserved = {
  generation: number;
  phase: ClawPhase;
  message: string;
  health: "unknown" | "healthy" | "degraded" | "offline";
  lifecycle?: LifecycleIdentity;
  controlLink: ParentControlLink;
  gatewayVersion?: string;
  configHash?: string;
  lastSeenAt?: string;
  probes?: ChildOperationalProbes;
  deletion?: DeletionState;
  userAccess?: {
    channel: "slack";
    subjectId: string;
    label?: string;
    status: "paired";
    pairedAt: string;
  };
};

export type ClawRecord = {
  id: string;
  revision: number;
  desired: ClawDesired;
  observed: ClawObserved;
  createdAt: string;
  updatedAt: string;
};

export type CreateClawInput = {
  name: string;
  slug?: string;
  owner: OwnerRef;
  templateId?: string;
  templateVersion?: number;
  deployment?: DeploymentInput;
  inference?: Partial<InferencePolicy>;
  slack?: Partial<SlackPolicy>;
  access?: Partial<AccessPolicy>;
  observability?: Partial<Omit<ObservabilityPolicy, "metadataOnly">>;
};

export type UpdateClawInput = Partial<
  Pick<ClawDesired, "name" | "templateId" | "templateVersion" | "owner">
> & {
  deployment?: DeploymentInput;
  inference?: Partial<InferencePolicy>;
  slack?: Partial<SlackPolicy>;
  access?: Partial<AccessPolicy>;
  observability?: Partial<Omit<ObservabilityPolicy, "metadataOnly">>;
};

export type AuditEvent = {
  id: string;
  clawId?: string;
  at: string;
  actor: string;
  action: string;
  outcome: "requested" | "succeeded" | "failed";
  summary: string;
  generation?: number;
  details?: Record<string, string | number | boolean | null>;
};

export type FleetSummary = {
  total: number;
  ready: number;
  provisioning: number;
  attention: number;
  disabled: number;
  drifted: number;
};

export type ProvisionResult = {
  phase: "enrolling" | "ready" | "attention";
  message: string;
  health: "unknown" | "healthy";
  lifecycle: LifecycleIdentity;
  controlLink?: ParentControlLink;
  gatewayVersion?: string;
  configHash?: string;
  probes?: ChildOperationalProbes;
};

export type InspectResult = Omit<Partial<ProvisionResult>, "health"> & {
  absent?: boolean;
  lastSeenAt?: string;
  health?: ClawObserved["health"];
};

export type DisableResult = InspectResult & {
  applied: boolean;
};

export type DrainResult = {
  drained: boolean;
  activeRuns: number;
  checkedAt: string;
  message: string;
};

export type RevokeControlResult = {
  removedPairedDevice: boolean;
  rejectedPendingRequest: boolean;
  alreadyAbsent: boolean;
  message: string;
};
