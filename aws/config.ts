import path from "node:path";
import { resolveClawRouterConfig } from "../src/clawrouter.js";

const encoder = new TextEncoder();

export type AwsControlPlaneVariables = {
  PUBLIC_URL: string;
  RUNTIME_URL: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  CF_ACCESS_ADMIN_EMAILS: string;
  CF_ACCESS_ADMIN_GROUPS: string;
  CRABHELM_PROBE_EMAIL: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  CRABBOX_URL: string;
  CRABBOX_TARGET_ID: string;
  CRABBOX_TARGET_LABEL: string;
  CRABBOX_TARGET_REGION: string;
  CRABBOX_PROFILE: string;
  CRABBOX_TTL_SECONDS: string;
  CRABBOX_IDLE_TIMEOUT_SECONDS: string;
  CRABHELM_EGRESS_LOCKDOWN: "required" | "off";
  CRABHELM_CLAWROUTER: "on" | "off";
  CLAWROUTER_BASE_URL?: string;
  CLAWROUTER_TENANT_ID?: string;
  CLAWROUTER_ALLOWED_PROVIDERS?: string;
  CLAWROUTER_DEFAULT_MODEL?: string;
  CRABHELM_PROMETHEUS: "on" | "off";
  NODE_RUNTIME_SHA256: string;
  APPLIANCE_ARCHIVE_SHA256: string;
  APPLIANCE_MANIFEST_SHA256: string;
  CRABBOX_TOKEN: string;
  BOOTSTRAP_SIGNING_SECRET: string;
  SESSION_SIGNING_SECRET: string;
  INVOCATION_SIGNING_SECRET: string;
  RUNTIME_SIGNING_SECRET: string;
  VAULT_MASTER_KEY: string;
  OPENAI_API_KEY?: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  CLAWROUTER_ADMIN_TOKEN?: string;
  CLAWROUTER_CREDENTIAL_SECRET?: string;
  CLAWROUTER_ACCESS_CLIENT_ID?: string;
  CLAWROUTER_ACCESS_CLIENT_SECRET?: string;
  METRICS_BEARER_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
};

export type AwsConfig = {
  listen: {
    host: "0.0.0.0";
    port: number;
  };
  aws: {
    region: string;
    databaseUrl: string;
    databaseCaPath: string;
    appliancesBucket: string;
    oauthVaultBucket: string;
    auditArchiveBucket: string;
    auditQueueUrl: string;
  };
  access: {
    loadBalancerArn: string;
    oidcIssuer: string;
    oidcClientId: string;
    adminEmails: string[];
    adminGroups: string[];
  };
  target: {
    id: string;
    label: string;
    region?: string;
    profile: string;
    ttlSeconds: number;
    idleTimeoutSeconds: number;
  };
  release: {
    nodeSha256: string;
    archiveSha256: string;
    manifestSha256: string;
  };
  controlPlane: AwsControlPlaneVariables;
};

type Environment = Readonly<Record<string, string | undefined>>;

const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const awsRegionPattern = /^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const bucketPattern = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/u;
const reservedBucketPrefixes = ["amzn_s3_demo_", "sthree-", "xn--"];
const reservedBucketSuffixes = ["-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"];

export function loadAwsConfig(environment: Environment = process.env): AwsConfig {
  const publicUrl = exactHttpsOrigin(environment, "PUBLIC_URL");
  const runtimeUrl = exactHttpsOrigin(environment, "RUNTIME_URL");
  if (publicUrl === runtimeUrl) {
    throw new Error("PUBLIC_URL and RUNTIME_URL must use different origins");
  }

  const awsRegion = awsRegionValue(environment, "AWS_REGION");
  const databaseUrl = postgresUrl(environment);
  const databaseCaPath = absolutePath(
    environment.DATABASE_CA_PATH?.trim() || defaultDatabaseCaPath(awsRegion),
    "DATABASE_CA_PATH",
  );
  const appliancesBucket = bucketName(environment, "AWS_APPLIANCES_BUCKET");
  const oauthVaultBucket = bucketName(environment, "AWS_OAUTH_VAULT_BUCKET");
  const auditArchiveBucket = bucketName(environment, "AWS_AUDIT_ARCHIVE_BUCKET");
  if (new Set([appliancesBucket, oauthVaultBucket, auditArchiveBucket]).size !== 3) {
    throw new Error("AWS S3 buckets must be distinct");
  }
  const auditQueueUrl = sqsQueueUrl(environment, "AWS_AUDIT_QUEUE_URL", awsRegion);

  const targetId = dnsLabel(environment, "CRABBOX_TARGET_ID");
  const targetLabel = boundedText(environment, "CRABBOX_TARGET_LABEL", 120);
  const targetRegion = optionalBoundedText(environment, "CRABBOX_TARGET_REGION", 120);
  const targetProfile = dnsLabel(environment, "CRABBOX_PROFILE");
  const ttlSeconds = integer(environment, "CRABBOX_TTL_SECONDS", 300, 31_536_000);
  const idleTimeoutSeconds = integer(
    environment,
    "CRABBOX_IDLE_TIMEOUT_SECONDS",
    60,
    31_536_000,
  );

  const egressLockdown = choice(
    environment,
    "CRABHELM_EGRESS_LOCKDOWN",
    ["required", "off"] as const,
    "required",
  );
  const clawRouterMode = choice(
    environment,
    "CRABHELM_CLAWROUTER",
    ["on", "off"] as const,
    "off",
  );
  const prometheusMode = choice(
    environment,
    "CRABHELM_PROMETHEUS",
    ["on", "off"] as const,
    "off",
  );

  const bootstrapSigningSecret = signingSecret(environment, "BOOTSTRAP_SIGNING_SECRET");
  const sessionSigningSecret = signingSecret(environment, "SESSION_SIGNING_SECRET");
  const invocationSecret = signingSecret(environment, "INVOCATION_SIGNING_SECRET");
  const runtimeSecret = signingSecret(environment, "RUNTIME_SIGNING_SECRET");
  const clawRouter = resolveClawRouterConfig({
    ...environment,
    CRABHELM_CLAWROUTER: clawRouterMode,
  });
  const routerAdmin = clawRouter?.adminToken ?? "";
  const routerSeed = clawRouter?.credentialSecret ?? "";
  const routerAccess = clawRouter?.accessClientSecret ?? "";
  const openAiApiKey = clawRouterMode === "off"
    ? requiredSecret(environment, "OPENAI_API_KEY")
    : undefined;
  const metricsToken = prometheusMode === "on"
    ? minimumSecret(environment, "METRICS_BEARER_TOKEN", 32)
    : optionalSecret(environment, "METRICS_BEARER_TOKEN");

  const adminEmails = csv(environment.ACCESS_ADMIN_EMAILS, "ACCESS_ADMIN_EMAILS", true)
    .map((value) => email(value, "ACCESS_ADMIN_EMAILS"));
  const adminGroups = csv(environment.ACCESS_ADMIN_GROUPS, "ACCESS_ADMIN_GROUPS", false);
  if (adminEmails.length === 0 && adminGroups.length === 0) {
    throw new Error("at least one access administrator email or group is required");
  }
  const oidcIssuer = oidcIssuerUrl(environment);
  const oidcClientId = boundedText(environment, "OIDC_CLIENT_ID", 512);
  const loadBalancerArn = albArn(environment, awsRegion);

  const nodeSha256 = digest(environment, "NODE_RUNTIME_SHA256");
  const archiveSha256 = digest(environment, "APPLIANCE_ARCHIVE_SHA256");
  const manifestSha256 = digest(environment, "APPLIANCE_MANIFEST_SHA256");
  const probeEmail = optionalEmail(environment, "CRABHELM_PROBE_EMAIL");
  const slackAppToken = optionalSecret(environment, "SLACK_APP_TOKEN");

  const controlPlane: AwsControlPlaneVariables = {
    PUBLIC_URL: publicUrl,
    RUNTIME_URL: runtimeUrl,
    CF_ACCESS_TEAM_DOMAIN: "",
    CF_ACCESS_AUD: "",
    CF_ACCESS_ADMIN_EMAILS: "",
    CF_ACCESS_ADMIN_GROUPS: "",
    CRABHELM_PROBE_EMAIL: probeEmail,
    GITHUB_OAUTH_CLIENT_ID: boundedText(environment, "GITHUB_OAUTH_CLIENT_ID", 512),
    CRABBOX_URL: httpsBaseUrl(environment, "CRABBOX_URL"),
    CRABBOX_TARGET_ID: targetId,
    CRABBOX_TARGET_LABEL: targetLabel,
    CRABBOX_TARGET_REGION: targetRegion ?? "",
    CRABBOX_PROFILE: targetProfile,
    CRABBOX_TTL_SECONDS: String(ttlSeconds),
    CRABBOX_IDLE_TIMEOUT_SECONDS: String(idleTimeoutSeconds),
    CRABHELM_EGRESS_LOCKDOWN: egressLockdown,
    CRABHELM_CLAWROUTER: clawRouterMode,
    CRABHELM_PROMETHEUS: prometheusMode,
    ...(clawRouter
      ? {
          CLAWROUTER_BASE_URL: clawRouter.baseUrl,
          CLAWROUTER_TENANT_ID: clawRouter.tenantId,
          CLAWROUTER_ALLOWED_PROVIDERS: clawRouter.allowedProviders.join(","),
          CLAWROUTER_DEFAULT_MODEL: clawRouter.defaultModel,
          CLAWROUTER_ADMIN_TOKEN: routerAdmin,
          CLAWROUTER_CREDENTIAL_SECRET: routerSeed,
          ...(clawRouter.accessClientId && clawRouter.accessClientSecret
            ? {
                CLAWROUTER_ACCESS_CLIENT_ID: clawRouter.accessClientId,
                CLAWROUTER_ACCESS_CLIENT_SECRET: routerAccess,
              }
            : {}),
        }
      : {}),
    NODE_RUNTIME_SHA256: nodeSha256,
    APPLIANCE_ARCHIVE_SHA256: archiveSha256,
    APPLIANCE_MANIFEST_SHA256: manifestSha256,
    CRABBOX_TOKEN: requiredSecret(environment, "CRABBOX_TOKEN"),
    BOOTSTRAP_SIGNING_SECRET: bootstrapSigningSecret,
    SESSION_SIGNING_SECRET: sessionSigningSecret,
    INVOCATION_SIGNING_SECRET: invocationSecret,
    RUNTIME_SIGNING_SECRET: runtimeSecret,
    VAULT_MASTER_KEY: vaultMasterKey(environment),
    ...(openAiApiKey ? { OPENAI_API_KEY: openAiApiKey } : {}),
    ...(metricsToken ? { METRICS_BEARER_TOKEN: metricsToken } : {}),
    SLACK_SIGNING_SECRET: requiredSecret(environment, "SLACK_SIGNING_SECRET"),
    SLACK_BOT_TOKEN: requiredSecret(environment, "SLACK_BOT_TOKEN"),
    GITHUB_OAUTH_CLIENT_SECRET: requiredSecret(environment, "GITHUB_OAUTH_CLIENT_SECRET"),
    ...(slackAppToken ? { SLACK_APP_TOKEN: slackAppToken } : {}),
  };

  return {
    listen: {
      host: "0.0.0.0",
      port: optionalInteger(environment, "PORT", 8_080, 1, 65_535),
    },
    aws: {
      region: awsRegion,
      databaseUrl,
      databaseCaPath,
      appliancesBucket,
      oauthVaultBucket,
      auditArchiveBucket,
      auditQueueUrl,
    },
    access: { loadBalancerArn, oidcIssuer, oidcClientId, adminEmails, adminGroups },
    target: {
      id: targetId,
      label: targetLabel,
      ...(targetRegion ? { region: targetRegion } : {}),
      profile: targetProfile,
      ttlSeconds,
      idleTimeoutSeconds,
    },
    release: { nodeSha256, archiveSha256, manifestSha256 },
    controlPlane,
  };
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedText(environment: Environment, name: string, maxBytes: number): string {
  const value = required(environment, name);
  if (encoder.encode(value).byteLength > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optionalBoundedText(
  environment: Environment,
  name: string,
  maxBytes: number,
): string | undefined {
  const value = environment[name]?.trim();
  if (!value) return undefined;
  if (encoder.encode(value).byteLength > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function exactHttpsOrigin(environment: Environment, name: string): string {
  const url = parsedUrl(required(environment, name), name);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  return url.origin;
}

function httpsBaseUrl(environment: Environment, name: string): string {
  const url = parsedUrl(required(environment, name), name);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/$/u, "");
}

function oidcIssuerUrl(environment: Environment): string {
  const url = parsedUrl(required(environment, "OIDC_ISSUER"), "OIDC_ISSUER");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("OIDC_ISSUER must be an HTTPS URL without credentials, query, or fragment");
  }
  // Issuer identifiers are exact: preserve a non-root trailing slash if the
  // provider declares one, while avoiding URL's synthetic slash for origins.
  return url.pathname === "/" ? url.origin : url.toString();
}

function parsedUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
}

function postgresUrl(environment: Environment): string {
  const componentNames = [
    "DATABASE_HOST",
    "DATABASE_PORT",
    "DATABASE_NAME",
    "DATABASE_USER",
    "DATABASE_PASSWORD",
  ];
  const configuredComponents = componentNames.filter((name) => environment[name]?.trim());
  if (environment.DATABASE_URL?.trim()) {
    if (configuredComponents.length > 0) {
      throw new Error("DATABASE_URL cannot be combined with DATABASE_* components");
    }
    return validatedPostgresUrl(environment.DATABASE_URL.trim(), "DATABASE_URL");
  }

  const host = databaseHost(environment);
  const port = integer(environment, "DATABASE_PORT", 1, 65_535);
  const database = databaseIdentifier(environment, "DATABASE_NAME");
  const user = databaseIdentifier(environment, "DATABASE_USER");
  const password = databasePassword(environment);
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${encodeURIComponent(database)}`;
  return validatedPostgresUrl(url, "DATABASE_* configuration");
}

function validatedPostgresUrl(value: string, name: string): string {
  const url = parsedUrl(value, name);
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    url.pathname === "/" ||
    url.hash
  ) {
    throw new Error(`${name} must be a PostgreSQL URL with a database name`);
  }
  if ([...url.searchParams.keys()].some((key) => key.toLowerCase().startsWith("ssl"))) {
    throw new Error(`${name} must not contain PostgreSQL TLS query parameters`);
  }
  return url.toString();
}

function absolutePath(value: string, name: string): string {
  if (!path.isAbsolute(value) || value.includes("\u0000")) {
    throw new Error(`${name} must be an absolute filesystem path`);
  }
  return path.normalize(value);
}

function databaseHost(environment: Environment): string {
  const value = required(environment, "DATABASE_HOST");
  if (
    value.length > 253 ||
    !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u.test(value)
  ) {
    throw new Error("DATABASE_HOST is invalid");
  }
  return value.toLowerCase();
}

function databaseIdentifier(environment: Environment, name: string): string {
  const value = required(environment, name);
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function databasePassword(environment: Environment): string {
  const value = environment.DATABASE_PASSWORD;
  if (!value || value.length > 1_024 || /[\r\n\u0000]/u.test(value)) {
    throw new Error("DATABASE_PASSWORD is required and must be a valid secret");
  }
  return value;
}

function awsRegionValue(environment: Environment, name: string): string {
  const value = required(environment, name);
  if (!awsRegionPattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function defaultDatabaseCaPath(region: string): string {
  return region.startsWith("us-gov-")
    ? "/etc/ssl/certs/aws-rds-govcloud-global-bundle.pem"
    : "/etc/ssl/certs/aws-rds-commercial-global-bundle.pem";
}

function albArn(environment: Environment, region: string): string {
  const value = required(environment, "AWS_LOAD_BALANCER_ARN");
  const partition = region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
  const pattern = new RegExp(
    `^arn:${partition}:elasticloadbalancing:${region}:[0-9]{12}:loadbalancer/app/[A-Za-z0-9-]{1,32}/[a-f0-9]+$`,
    "u",
  );
  if (!pattern.test(value)) throw new Error("AWS_LOAD_BALANCER_ARN is invalid");
  return value;
}

function bucketName(environment: Environment, name: string): string {
  const value = required(environment, name);
  if (
    !bucketPattern.test(value) ||
    value.includes("..") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value) ||
    reservedBucketPrefixes.some((prefix) => value.startsWith(prefix)) ||
    reservedBucketSuffixes.some((suffix) => value.endsWith(suffix))
  ) {
    throw new Error(`${name} is not a valid general-purpose S3 bucket name`);
  }
  return value;
}

function sqsQueueUrl(environment: Environment, name: string, region: string): string {
  const url = parsedUrl(required(environment, name), name);
  const path = url.pathname.match(/^\/(\d{12})\/([^/]+)$/u);
  const queueName = path?.[2] ?? "";
  const expectedHosts = new Set([`sqs.${region}.amazonaws.com`]);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !expectedHosts.has(url.hostname) ||
    url.search ||
    url.hash ||
    !path ||
    queueName.length > 80 ||
    !/^[A-Za-z0-9_-]+(?:\.fifo)?$/u.test(queueName)
  ) {
    throw new Error(`${name} must be an SQS queue URL in AWS_REGION`);
  }
  return url.toString();
}

function dnsLabel(environment: Environment, name: string): string {
  const value = required(environment, name);
  if (!dnsLabelPattern.test(value)) throw new Error(`${name} must be a lowercase DNS label`);
  return value;
}

function digest(environment: Environment, name: string): string {
  const value = required(environment, name);
  if (!sha256Pattern.test(value) || /^0{64}$/u.test(value)) {
    throw new Error(`${name} must be a non-placeholder lowercase SHA-256 digest`);
  }
  return value;
}

function integer(
  environment: Environment,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = required(environment, name);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function optionalInteger(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return environment[name]?.trim()
    ? integer(environment, name, minimum, maximum)
    : fallback;
}

function choice<const T extends readonly string[]>(
  environment: Environment,
  name: string,
  values: T,
  fallback: T[number],
): T[number] {
  const candidate = environment[name]?.trim() || fallback;
  if (!values.includes(candidate)) throw new Error(`${name} must be one of ${values.join(", ")}`);
  return candidate as T[number];
}

function requiredSecret(environment: Environment, name: string): string {
  const value = required(environment, name);
  if (/\r|\n/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function optionalSecret(environment: Environment, name: string): string | undefined {
  const value = environment[name]?.trim();
  if (!value) return undefined;
  if (/\r|\n/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function signingSecret(environment: Environment, name: string): string {
  const value = requiredSecret(environment, name);
  if (encoder.encode(value).byteLength < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

function minimumSecret(environment: Environment, name: string, minimumBytes: number): string {
  const value = requiredSecret(environment, name);
  if (encoder.encode(value).byteLength < minimumBytes) {
    throw new Error(`${name} must contain at least ${minimumBytes} bytes`);
  }
  return value;
}

function vaultMasterKey(environment: Environment): string {
  const value = requiredSecret(environment, "VAULT_MASTER_KEY");
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("VAULT_MASTER_KEY must be base64url encoded");
  }
  try {
    if (Buffer.from(value, "base64url").byteLength !== 32) throw new Error("invalid length");
  } catch {
    throw new Error("VAULT_MASTER_KEY must encode exactly 32 bytes");
  }
  return value;
}

function csv(value: string | undefined, name: string, lowercase: boolean): string[] {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => lowercase ? entry.toLowerCase() : entry);
  if (entries.some((entry) => encoder.encode(entry).byteLength > 320 || /[\u0000-\u001f\u007f]/u.test(entry))) {
    throw new Error(`${name} is invalid`);
  }
  return [...new Set(entries)];
}

function email(value: string, name: string): string {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) || value.length > 320) {
    throw new Error(`${name} contains an invalid email address`);
  }
  return value;
}

function optionalEmail(environment: Environment, name: string): string {
  const value = environment[name]?.trim().toLowerCase();
  return value ? email(value, name) : "";
}
