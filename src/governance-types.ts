export type PrincipalKind = "human" | "service";
export type PrincipalRole = "administrator" | "member";
export type PrincipalSource = "operator" | "github" | "slack" | "email" | "oidc" | "manual";

export type PrincipalRecord = {
  id: string;
  revision: number;
  subject: string;
  label: string;
  kind: PrincipalKind;
  source: PrincipalSource;
  roles: PrincipalRole[];
  departments: string[];
  createdAt: string;
  updatedAt: string;
};

export type PersonaKind = "personal" | "shared" | "profile";
export type ActorMode = "invoker" | "service" | "invoker-with-service-fallback";

export type ActorPolicy = {
  mode: ActorMode;
  servicePrincipalId?: string;
};

export type PersonaBinding = {
  surface: "slack" | "web" | "api";
  workspaceId?: string;
  channelId?: string;
};

export type PublishedContext = {
  label: string;
  value: string;
  url?: string;
};

export type PersonaInstructions = {
  identity: string;
  soul: string;
  agents: string;
};

export type PersonaRecord = {
  id: string;
  revision: number;
  name: string;
  slug: string;
  kind: PersonaKind;
  ownerPrincipalId: string;
  clawId: string;
  actorPolicy: ActorPolicy;
  bindings: PersonaBinding[];
  capabilityIds: string[];
  skillIds: string[];
  instructions: PersonaInstructions;
  publishedContext: PublishedContext[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CapabilityRisk = "read" | "write" | "external" | "destructive";

export type CapabilityDefinition = {
  id: string;
  provider: "github";
  action: "repository.read" | "issue.read" | "issue.comment";
  label: string;
  description: string;
  risk: CapabilityRisk;
  confirmation: "never" | "always";
  allowedActorModes: ActorMode[];
  requiredScopes: string[];
};

export type SkillStatus = "draft" | "approved" | "revoked";

export type SkillFile = {
  path: string;
  content: string;
  sha256: string;
};

export type SkillRecord = {
  id: string;
  revision: number;
  name: string;
  slug: string;
  description: string;
  version: number;
  status: SkillStatus;
  departments: string[];
  files: SkillFile[];
  digest: string;
  createdBy: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type OAuthConnectionRecord = {
  id: string;
  revision: number;
  principalId: string;
  provider: "github";
  label: string;
  scopes: string[];
  vaultKey: string;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
};

export type OAuthStateRecord = {
  id: string;
  principalId: string;
  provider: "github";
  createdAt: string;
  expiresAt: string;
};

export type ConfirmationRecord = {
  id: string;
  requesterId: string;
  personaId: string;
  actorId: string;
  capabilityId: string;
  target: string;
  argumentsDigest: string;
  summary: string;
  status: "pending" | "approved" | "denied" | "used" | "expired";
  expiresAt: string;
  decidedAt?: string;
  createdAt: string;
};

export type InvocationRecord = {
  id: string;
  clawId: string;
  requesterId: string;
  personaId: string;
  actorId: string;
  actorMode: ActorMode;
  fallbackUsed: boolean;
  capabilityId: string;
  target: string;
  argumentsDigest: string;
  policyRevision: number;
  confirmationId?: string;
  status: "issued" | "running" | "succeeded" | "failed" | "expired";
  issuedAt: string;
  expiresAt: string;
  completedAt?: string;
};

export type GovernanceAuditEvent = {
  id: string;
  at: string;
  correlationId: string;
  clawId?: string;
  requesterId?: string;
  personaId?: string;
  actorId?: string;
  actorMode?: ActorMode;
  fallbackUsed?: boolean;
  runtimeId?: string;
  capabilityId?: string;
  target?: string;
  policyRevision?: number;
  confirmationId?: string;
  action: string;
  outcome: "requested" | "succeeded" | "failed" | "denied";
  summary: string;
  details?: Record<string, string | number | boolean | null>;
};

export type ManagedAgentSpec = {
  schemaVersion: 1;
  generatedAt: string;
  clawId: string;
  persona: {
    id: string;
    name: string;
    slug: string;
    kind: PersonaKind;
    ownerPrincipalId: string;
    actorPolicy: ActorPolicy;
  };
  policyRevision: number;
  capabilityIds: string[];
  instructions: PersonaInstructions;
  publishedContext: PublishedContext[];
  observability: {
    logLevel: "error" | "warn" | "info" | "debug";
    metadataOnly: true;
    otel: {
      enabled: boolean;
      endpoint?: string;
      serviceName: string;
      traces: boolean;
      metrics: boolean;
      logs: false;
      sampleRate: number;
      flushIntervalMs: number;
    };
  };
  skills: Array<Pick<SkillRecord, "id" | "name" | "slug" | "version" | "digest" | "files">>;
  readOnly: true;
};

export type GovernanceSnapshot = {
  principals: PrincipalRecord[];
  personas: PersonaRecord[];
  capabilities: CapabilityDefinition[];
  skills: SkillRecord[];
  connections: OAuthConnectionRecord[];
  confirmations: ConfirmationRecord[];
  invocations: InvocationRecord[];
  governanceEvents: GovernanceAuditEvent[];
};

export type CreatePrincipalInput = {
  subject: string;
  label: string;
  kind?: PrincipalKind;
  source?: PrincipalSource;
  roles?: PrincipalRole[];
  departments?: string[];
};

export type CreatePersonaInput = {
  name: string;
  slug?: string;
  kind: PersonaKind;
  ownerPrincipalId: string;
  clawId: string;
  actorPolicy?: Partial<ActorPolicy>;
  bindings?: PersonaBinding[];
  capabilityIds?: string[];
  skillIds?: string[];
  instructions?: Partial<PersonaInstructions>;
  publishedContext?: PublishedContext[];
};

export type UpdatePersonaInput = Partial<Omit<CreatePersonaInput, "clawId">> & {
  enabled?: boolean;
};

export type CreateSkillInput = {
  name: string;
  slug?: string;
  description?: string;
  departments?: string[];
  files: Array<Pick<SkillFile, "path" | "content">>;
};

export type CreateOAuthConnectionInput = {
  principalId: string;
  provider: "github";
  label: string;
  scopes: string[];
  secret: string;
};

export type CreateInvocationInput = {
  personaId: string;
  capabilityId: string;
  target: string;
  arguments: Record<string, string | number | boolean | null>;
  confirmationId?: string;
};

export type InvocationGrantClaims = {
  typ: "invocation";
  iss: "crabhelm";
  aud: "crabhelm-tool-wrapper";
  jti: string;
  iat: number;
  exp: number;
  clawId: string;
  requesterId: string;
  personaId: string;
  actorId: string;
  actorMode: ActorMode;
  fallbackUsed: boolean;
  capabilityId: string;
  target: string;
  argumentsDigest: string;
  policyRevision: number;
  connectionId: string;
  confirmationId?: string;
};

export type SessionClaims = {
  typ: "session";
  iss: "crabhelm";
  aud: "crabhelm-control-plane";
  jti: string;
  iat: number;
  exp: number;
  principalId: string;
  roles: PrincipalRole[];
};

export type RuntimeClaims = {
  typ: "runtime";
  iss: "crabhelm";
  aud: "crabhelm-runtime";
  jti: string;
  iat: number;
  exp: number;
  clawId: string;
  runtimeId: string;
};

export type RuntimeTicketClaims = {
  typ: "runtime-ticket";
  iss: "crabhelm";
  aud: "crabhelm-runtime-connect";
  jti: string;
  iat: number;
  exp: number;
  clawId: string;
  runtimeId: string;
  refreshJti: string;
};

export type TurnClaims = {
  typ: "turn";
  iss: "crabhelm";
  aud: "crabhelm-runtime-turn";
  jti: string;
  iat: number;
  exp: number;
  jobId: string;
  clawId: string;
  requesterId: string;
  personaId: string;
  surface: "slack" | "web" | "api";
  workspaceId?: string;
  channelId?: string;
  threadTs?: string;
};

// Bearer presented by a child Gateway to the edge model proxy. It stands in for
// the raw provider key on the agent VM: per-claw, audience-bound, and only ever
// exchanged for the real key inside the Worker.
export type ModelClaims = {
  typ: "model";
  iss: "crabhelm";
  aud: "crabhelm-model";
  jti: string;
  iat: number;
  exp: number;
  clawId: string;
};
