import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadAwsConfig } from "../../aws/config.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const signingSecret = "s".repeat(48);
const vaultKey = Buffer.alloc(32, 7).toString("base64url");

function validEnvironment(): Record<string, string> {
  return {
    PORT: "8088",
    AWS_REGION: "us-west-2",
    AWS_LOAD_BALANCER_ARN: "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/crabhelm/abc123",
    DATABASE_HOST: "database.internal",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "crabhelm",
    DATABASE_USER: "crabhelm",
    DATABASE_PASSWORD: "p@ss word:/?#[]",
    AWS_APPLIANCES_BUCKET: "crabhelm-prod-appliances",
    AWS_OAUTH_VAULT_BUCKET: "crabhelm-prod-oauth-vault",
    AWS_AUDIT_ARCHIVE_BUCKET: "crabhelm-prod-audit-archive",
    AWS_AUDIT_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123456789012/crabhelm-audit",
    PUBLIC_URL: "https://crabhelm.example.com/",
    RUNTIME_URL: "https://crabhelm-runtime.example.com/",
    OIDC_ISSUER: "https://identity.example.com/oauth2/default",
    OIDC_CLIENT_ID: "access-client-id",
    ACCESS_ADMIN_EMAILS: " ADMIN@example.com,admin@example.com ",
    ACCESS_ADMIN_GROUPS: "platform, operators,platform",
    CRABHELM_PROBE_EMAIL: "Probe@example.com",
    GITHUB_OAUTH_CLIENT_ID: "github-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
    CRABBOX_URL: "https://crabbox.example.com/control/",
    CRABBOX_TOKEN: "crabbox-token",
    CRABBOX_TARGET_ID: "aws-west",
    CRABBOX_TARGET_LABEL: "AWS US West",
    CRABBOX_TARGET_REGION: "us-west-2",
    CRABBOX_PROFILE: "openclaw-core",
    CRABBOX_TTL_SECONDS: "14400",
    CRABBOX_IDLE_TIMEOUT_SECONDS: "7200",
    CRABHELM_EGRESS_LOCKDOWN: "required",
    CRABHELM_CLAWROUTER: "off",
    CRABHELM_PROMETHEUS: "off",
    NODE_RUNTIME_SHA256: digestA,
    APPLIANCE_ARCHIVE_SHA256: digestB,
    APPLIANCE_MANIFEST_SHA256: digestC,
    BOOTSTRAP_SIGNING_SECRET: signingSecret,
    SESSION_SIGNING_SECRET: signingSecret,
    INVOCATION_SIGNING_SECRET: signingSecret,
    RUNTIME_SIGNING_SECRET: signingSecret,
    VAULT_MASTER_KEY: vaultKey,
    OPENAI_API_KEY: "openai-key",
    SLACK_SIGNING_SECRET: "slack-signing-secret",
    SLACK_BOT_TOKEN: "slack-bot-token",
  };
}

test("AWS config validates and normalizes the complete production environment", () => {
  const config = loadAwsConfig(validEnvironment());

  assert.deepEqual(config.listen, { host: "0.0.0.0", port: 8088 });
  assert.deepEqual(config.aws, {
    region: "us-west-2",
    databaseUrl: "postgresql://crabhelm:p%40ss%20word%3A%2F%3F%23%5B%5D@database.internal:5432/crabhelm",
    databaseCaPath: "/etc/ssl/certs/aws-rds-commercial-global-bundle.pem",
    appliancesBucket: "crabhelm-prod-appliances",
    oauthVaultBucket: "crabhelm-prod-oauth-vault",
    auditArchiveBucket: "crabhelm-prod-audit-archive",
    auditQueueUrl: "https://sqs.us-west-2.amazonaws.com/123456789012/crabhelm-audit",
  });
  assert.deepEqual(config.target, {
    id: "aws-west",
    label: "AWS US West",
    region: "us-west-2",
    profile: "openclaw-core",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 7_200,
  });
  assert.deepEqual(config.release, {
    nodeSha256: digestA,
    archiveSha256: digestB,
    manifestSha256: digestC,
  });
  assert.equal(config.controlPlane.PUBLIC_URL, "https://crabhelm.example.com");
  assert.equal(config.controlPlane.RUNTIME_URL, "https://crabhelm-runtime.example.com");
  assert.equal(config.controlPlane.CRABBOX_URL, "https://crabbox.example.com/control");
  assert.deepEqual(config.access, {
    loadBalancerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/crabhelm/abc123",
    oidcIssuer: "https://identity.example.com/oauth2/default",
    oidcClientId: "access-client-id",
    adminEmails: ["admin@example.com"],
    adminGroups: ["platform", "operators"],
  });
  assert.equal(config.controlPlane.CRABHELM_PROBE_EMAIL, "probe@example.com");
  assert.equal(config.controlPlane.CRABHELM_CLAWROUTER, "off");
  assert.equal(config.controlPlane.CLAWROUTER_ADMIN_TOKEN, undefined);
});

test("AWS config rejects missing required values without exposing other secrets", () => {
  for (const name of [
    "AWS_REGION",
    "DATABASE_HOST",
    "AWS_APPLIANCES_BUCKET",
    "PUBLIC_URL",
    "CRABBOX_TOKEN",
    "BOOTSTRAP_SIGNING_SECRET",
    "OPENAI_API_KEY",
  ]) {
    const environment = validEnvironment();
    delete environment[name];
    assert.throws(() => loadAwsConfig(environment), new RegExp(`${name} is required`));
  }
});

test("AWS config enforces HTTPS host separation and OIDC identity", () => {
  const insecure = validEnvironment();
  insecure.PUBLIC_URL = "http://crabhelm.example.com";
  assert.throws(() => loadAwsConfig(insecure), /PUBLIC_URL must be an exact HTTPS origin/u);

  const sharedHost = validEnvironment();
  sharedHost.RUNTIME_URL = sharedHost.PUBLIC_URL!;
  assert.throws(() => loadAwsConfig(sharedHost), /must use different origins/u);

  const insecureIssuer = validEnvironment();
  insecureIssuer.OIDC_ISSUER = "http://identity.example.com";
  assert.throws(() => loadAwsConfig(insecureIssuer), /OIDC_ISSUER must be an HTTPS URL/u);

  const noAdministrator = validEnvironment();
  noAdministrator.ACCESS_ADMIN_EMAILS = "";
  noAdministrator.ACCESS_ADMIN_GROUPS = "";
  assert.throws(() => loadAwsConfig(noAdministrator), /at least one access administrator/u);
});

test("AWS config validates secrets, vault material, and ClawRouter admission", () => {
  const shortSigningSecret = validEnvironment();
  shortSigningSecret.RUNTIME_SIGNING_SECRET = "short";
  assert.throws(() => loadAwsConfig(shortSigningSecret), /RUNTIME_SIGNING_SECRET must contain at least 32 bytes/u);

  const badVaultKey = validEnvironment();
  badVaultKey.VAULT_MASTER_KEY = Buffer.alloc(31).toString("base64url");
  assert.throws(() => loadAwsConfig(badVaultKey), /VAULT_MASTER_KEY must encode exactly 32 bytes/u);

  const missingRouterSecret = validEnvironment();
  missingRouterSecret.CRABHELM_CLAWROUTER = "on";
  assert.throws(() => loadAwsConfig(missingRouterSecret), /CLAWROUTER_BASE_URL is required/u);

  const enabledClawRouter = validEnvironment();
  enabledClawRouter.CRABHELM_CLAWROUTER = "on";
  enabledClawRouter.CLAWROUTER_BASE_URL = "https://clawrouter.example.com";
  enabledClawRouter.CLAWROUTER_TENANT_ID = "fakeco";
  enabledClawRouter.CLAWROUTER_ALLOWED_PROVIDERS = "openai,anthropic";
  enabledClawRouter.CLAWROUTER_MODEL_PROVIDER_MAP = "clawrouter/openai/gpt-5.5=openai";
  enabledClawRouter.CLAWROUTER_DEFAULT_MODEL = "clawrouter/openai/gpt-5.5";
  enabledClawRouter.CLAWROUTER_ADMIN_TOKEN = "router";
  enabledClawRouter.CLAWROUTER_CREDENTIAL_SECRET = "r".repeat(48);
  const routerConfig = loadAwsConfig(enabledClawRouter).controlPlane;
  assert.equal(routerConfig.CLAWROUTER_BASE_URL, "https://clawrouter.example.com");
  assert.equal(routerConfig.CLAWROUTER_ALLOWED_PROVIDERS, "anthropic,openai");
  assert.equal(routerConfig.CLAWROUTER_MODEL_PROVIDER_MAP, "clawrouter/openai/gpt-5.5=openai");
  assert.equal(routerConfig.OPENAI_API_KEY, undefined);

  const missingModelProviderMap = { ...enabledClawRouter };
  delete missingModelProviderMap.CLAWROUTER_MODEL_PROVIDER_MAP;
  assert.throws(
    () => loadAwsConfig(missingModelProviderMap),
    /CLAWROUTER_MODEL_PROVIDER_MAP is required/u,
  );

  const prometheus = validEnvironment();
  prometheus.CRABHELM_PROMETHEUS = "on";
  prometheus.METRICS_BEARER_TOKEN = "m".repeat(48);
  assert.equal(loadAwsConfig(prometheus).controlPlane.METRICS_BEARER_TOKEN, "m".repeat(48));
  prometheus.METRICS_BEARER_TOKEN = "short";
  assert.throws(() => loadAwsConfig(prometheus), /METRICS_BEARER_TOKEN must contain at least 32 bytes/u);
});

test("AWS config validates resource identity and target policy", () => {
  const urlDatabase = validEnvironment();
  delete urlDatabase.DATABASE_HOST;
  delete urlDatabase.DATABASE_PORT;
  delete urlDatabase.DATABASE_NAME;
  delete urlDatabase.DATABASE_USER;
  delete urlDatabase.DATABASE_PASSWORD;
  urlDatabase.DATABASE_URL = "postgresql://crabhelm:password@database.internal:5432/crabhelm";
  assert.equal(
    loadAwsConfig(urlDatabase).aws.databaseUrl,
    "postgresql://crabhelm:password@database.internal:5432/crabhelm",
  );

  const duplicateBuckets = validEnvironment();
  duplicateBuckets.AWS_OAUTH_VAULT_BUCKET = duplicateBuckets.AWS_APPLIANCES_BUCKET!;
  assert.throws(() => loadAwsConfig(duplicateBuckets), /S3 buckets must be distinct/u);

  const invalidBucket = validEnvironment();
  invalidBucket.AWS_APPLIANCES_BUCKET = "Invalid_Bucket";
  assert.throws(() => loadAwsConfig(invalidBucket), /valid general-purpose S3 bucket/u);

  const wrongQueueRegion = validEnvironment();
  wrongQueueRegion.AWS_AUDIT_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/crabhelm-audit";
  assert.throws(() => loadAwsConfig(wrongQueueRegion), /SQS queue URL in AWS_REGION/u);

  const chinaPartition = validEnvironment();
  chinaPartition.AWS_REGION = "cn-north-1";
  chinaPartition.AWS_LOAD_BALANCER_ARN =
    "arn:aws-cn:elasticloadbalancing:cn-north-1:123456789012:loadbalancer/app/crabhelm/abc123";
  chinaPartition.AWS_AUDIT_QUEUE_URL =
    "https://sqs.cn-north-1.amazonaws.com/123456789012/crabhelm-audit";
  assert.throws(() => loadAwsConfig(chinaPartition), /AWS_LOAD_BALANCER_ARN is invalid/u);

  const queryConfiguredTls = validEnvironment();
  delete queryConfiguredTls.DATABASE_HOST;
  delete queryConfiguredTls.DATABASE_PORT;
  delete queryConfiguredTls.DATABASE_NAME;
  delete queryConfiguredTls.DATABASE_USER;
  delete queryConfiguredTls.DATABASE_PASSWORD;
  queryConfiguredTls.DATABASE_URL = "postgresql://crabhelm:password@database.internal/crabhelm?sslmode=require";
  assert.throws(() => loadAwsConfig(queryConfiguredTls), /must not contain PostgreSQL TLS query parameters/u);

  const ambiguousDatabase = validEnvironment();
  ambiguousDatabase.DATABASE_URL = "postgresql://crabhelm:password@database.internal/crabhelm";
  assert.throws(() => loadAwsConfig(ambiguousDatabase), /cannot be combined with DATABASE_\* components/u);

  const relativeCaPath = validEnvironment();
  relativeCaPath.DATABASE_CA_PATH = "certs/rds.pem";
  assert.throws(() => loadAwsConfig(relativeCaPath), /DATABASE_CA_PATH must be an absolute filesystem path/u);

  const invalidTarget = validEnvironment();
  invalidTarget.CRABBOX_TARGET_ID = "AWS_WEST";
  assert.throws(() => loadAwsConfig(invalidTarget), /lowercase DNS label/u);

  const invalidTtl = validEnvironment();
  invalidTtl.CRABBOX_TTL_SECONDS = "299";
  assert.throws(() => loadAwsConfig(invalidTtl), /must be between 300 and 31536000/u);

  const invalidDigest = validEnvironment();
  invalidDigest.APPLIANCE_ARCHIVE_SHA256 = "A".repeat(64);
  assert.throws(() => loadAwsConfig(invalidDigest), /lowercase SHA-256 digest/u);

  const placeholderDigest = validEnvironment();
  placeholderDigest.APPLIANCE_MANIFEST_SHA256 = "0".repeat(64);
  assert.throws(() => loadAwsConfig(placeholderDigest), /non-placeholder lowercase SHA-256 digest/u);
});

test("AWS config selects the pinned GovCloud RDS trust bundle", () => {
  const environment = validEnvironment();
  environment.AWS_REGION = "us-gov-west-1";
  environment.AWS_LOAD_BALANCER_ARN =
    "arn:aws-us-gov:elasticloadbalancing:us-gov-west-1:123456789012:loadbalancer/app/crabhelm/abc123";
  environment.AWS_AUDIT_QUEUE_URL =
    "https://sqs.us-gov-west-1.amazonaws.com/123456789012/crabhelm-audit";

  assert.equal(
    loadAwsConfig(environment).aws.databaseCaPath,
    "/etc/ssl/certs/aws-rds-govcloud-global-bundle.pem",
  );
});

test("AWS image pins the commercial and GovCloud RDS trust bundles", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile.aws", import.meta.url), "utf8");
  assert.match(dockerfile, /RDS_COMMERCIAL_CA_SHA256=e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3/u);
  assert.match(dockerfile, /RDS_GOVCLOUD_CA_SHA256=bae59f78f2e2ba789e734cdcac78c13a0f0e99aa3f7bd49f1f37477c815b9b33/u);
  assert.match(dockerfile, /truststore\.pki\.us-gov-west-1\.rds\.amazonaws\.com\/global\/global-bundle\.pem/u);
  assert.match(dockerfile, /aws-rds-govcloud-global-bundle\.pem/u);
});

test("AWS FakeCo template fails closed on router origin and documents billable ECR bootstrap", async () => {
  const template = await readFile(new URL("../../deploy/aws/template.yaml", import.meta.url), "utf8");
  const guide = await readFile(new URL("../../deploy/aws/README.md", import.meta.url), "utf8");
  assert.match(template, /Default: https:\/\/clawrouter\.invalid/u);
  assert.match(template, /ClawRouterOriginRequired:[\s\S]*Routed mode requires an explicit non-placeholder/u);
  assert.match(template, /ClawRouterModelProviderMap:[\s\S]*clawrouter\/openai\/gpt-5\.5=openai/u);
  assert.match(guide, /ProvisionService=false[^\n]*suppresses only the ECS service/u);
  assert.match(guide, /precreate one immutable ECR repository[\s\S]*CreateEcrRepository=false[\s\S]*ImageUri/u);
});
