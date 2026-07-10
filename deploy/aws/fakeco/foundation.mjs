#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultProfilePath = path.join(here, "profile.json");
const defaultRetainedResourcesPath = path.join(here, "retained-resources.json");

const requiredLockedParameters = Object.freeze({
  CreateEcrRepository: "false",
  ProvisionService: "true",
  WorkloadRolePath: "/openclaw/fakeco/crabhelm/",
  LoadBalancerDeletionProtection: "false",
  ClawRouterMode: "on",
  ClawRouterTenantId: "fakeco",
  DatabaseAllocatedStorage: "20",
  DatabaseStorageAutoscaling: "false",
  DatabaseMaxAllocatedStorage: "20",
  DatabaseBackupRetentionDays: "1",
  DatabaseLogExports: "off",
  DatabaseMultiAz: "false",
  DatabaseDeletionProtection: "false",
  LogRetentionDays: "7",
});

const safeStackStatuses = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
]);

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const options = parseOptions(argv);
  const profilePath = options.profile ?? defaultProfilePath;
  const profile = await readJson(profilePath, "FakeCo profile");
  validateProfile(profile);

  switch (command) {
    case "validate-profile":
      printJson({
        ok: true,
        profile: profile.name,
        stackName: profile.stackName,
        oidcSubjects: profile.oidcSubjects,
      });
      return;
    case "render": {
      const phase = requirePhase(options.phase);
      const output = requireOption(options, "output");
      const rendered = renderFromEnvironment(profile, phase, process.env);
      await writePrivateJson(output, rendered);
      printJson({ ok: true, phase, output, parameterCount: rendered.parameters.length });
      return;
    }
    case "verify": {
      const renderedPath = requireOption(options, "rendered");
      const rendered = await readJson(renderedPath, "rendered FakeCo deployment");
      const stack = options.stack
        ? await readJson(options.stack, "CloudFormation stack description")
        : undefined;
      const result = verifyRendered(profile, rendered, stack);
      printJson({ ok: true, ...result });
      return;
    }
    case "parameter-overrides": {
      const rendered = await readJson(
        requireOption(options, "rendered"),
        "rendered FakeCo deployment",
      );
      verifyRendered(profile, rendered);
      for (const parameter of rendered.parameters) {
        assertSingleLine(parameter.ParameterValue, parameter.ParameterKey);
        process.stdout.write(`${parameter.ParameterKey}=${parameter.ParameterValue}\n`);
      }
      return;
    }
    case "teardown-plan": {
      const rendered = await readJson(
        requireOption(options, "rendered"),
        "rendered FakeCo deployment",
      );
      const stack = await readJson(
        requireOption(options, "stack"),
        "CloudFormation stack description",
      );
      const resources = await readJson(
        requireOption(options, "resources"),
        "CloudFormation stack resources",
      );
      const retention = await readJson(
        options.retention ?? defaultRetainedResourcesPath,
        "retained resource manifest",
      );
      const plan = buildTeardownPlan(profile, rendered, stack, resources, retention);
      const output = requireOption(options, "output");
      await writePrivateJson(output, plan);
      printJson({
        ok: true,
        output,
        stackName: plan.stackName,
        retainedResourceCount: plan.retainedResources.length,
      });
      return;
    }
    default:
      throw new Error(
        "usage: foundation.mjs <validate-profile|render|verify|parameter-overrides|teardown-plan> [options]",
      );
  }
}

function validateProfile(profile) {
  requireObject(profile, "profile");
  assertEqual(profile.schemaVersion, 1, "profile schemaVersion");
  assertEqual(profile.name, "fakeco", "profile name");
  assertEqual(profile.repository, "openclaw/crabhelm", "profile repository");
  assertEqual(profile.partition, "aws", "profile partition");
  assertEqual(profile.stackName, "crabhelm-fakeco", "profile stackName");
  assertEqual(profile.environments?.deploy, "fakeco", "deploy environment");
  assertEqual(profile.environments?.teardown, "fakeco-teardown", "teardown environment");
  assertEqual(
    profile.oidcSubjects?.deploy,
    "repo:openclaw/crabhelm:environment:fakeco",
    "deploy OIDC subject",
  );
  assertEqual(
    profile.oidcSubjects?.teardown,
    "repo:openclaw/crabhelm:environment:fakeco-teardown",
    "teardown OIDC subject",
  );
  assertEqual(profile.concurrencyGroup, "crabhelm-fakeco", "concurrency group");
  assertEqual(
    profile.cloudFormationArtifactBucketPattern,
    "openclaw-fakeco-cfn-{accountId}-{region}",
    "CloudFormation artifact bucket pattern",
  );
  assertEqual(profile.workloadRolePath, "/openclaw/fakeco/crabhelm/", "workload role path");
  assertEqual(profile.ecrRepositoryName, "openclaw/fakeco/crabhelm", "ECR repository name");
  assertEqual(profile.tags?.Environment, "fakeco", "Environment tag");
  assertEqual(profile.tags?.ManagedBy, "github-actions", "ManagedBy tag");
  assertEqual(profile.tags?.Project, "crabhelm", "Project tag");
  for (const [key, value] of Object.entries(requiredLockedParameters)) {
    assertEqual(profile.lockedParameters?.[key], value, `locked parameter ${key}`);
  }
  const foundationInputs = validateInputDefinitions(profile.foundationInputs, false);
  const parameterInputs = validateInputDefinitions(profile.parameterInputs, true);
  const foundationNames = foundationInputs.map((entry) => entry.env);
  const parameterEnvironmentNames = parameterInputs.map((entry) => entry.env);
  if (new Set(foundationNames).size !== foundationNames.length ||
      new Set(parameterEnvironmentNames).size !== parameterEnvironmentNames.length) {
    throw new Error("profile input environment names must be unique within each input surface");
  }
  const environmentNames = [...new Set([...foundationNames, ...parameterEnvironmentNames])];
  for (const name of foundationNames.filter((entry) => parameterEnvironmentNames.includes(entry))) {
    const foundationKind = foundationInputs.find((entry) => entry.env === name)?.kind;
    const parameterKind = parameterInputs.find((entry) => entry.env === name)?.kind;
    assertEqual(parameterKind, foundationKind, `shared input validator ${name}`);
  }
  const parameterNames = parameterInputs.map((entry) => entry.parameter);
  if (new Set(parameterNames).size !== parameterNames.length) {
    throw new Error("profile input CloudFormation parameters must be unique");
  }
  for (const name of environmentNames) assertSafeInputName(name);
  const lockedNames = Object.keys(profile.lockedParameters ?? {});
  const overlap = parameterNames.find((name) => lockedNames.includes(name));
  if (overlap) throw new Error(`parameter ${overlap} cannot be both locked and input-driven`);
}

function validateInputDefinitions(value, requireParameter) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("profile input definitions must be a non-empty array");
  }
  return value.map((entry, index) => {
    requireObject(entry, `input definition ${index}`);
    if (!/^FAKECO_[A-Z0-9_]+$/u.test(entry.env ?? "")) {
      throw new Error(`input definition ${index} has an invalid env name`);
    }
    if (!/^[A-Za-z][A-Za-z0-9]+$/u.test(entry.kind ?? "")) {
      throw new Error(`input definition ${index} has an invalid validator kind`);
    }
    if (requireParameter && !/^[A-Za-z][A-Za-z0-9]+$/u.test(entry.parameter ?? "")) {
      throw new Error(`input definition ${index} has an invalid parameter name`);
    }
    return entry;
  });
}

function assertSafeInputName(name) {
  const allowedMetadata = /(?:_SECRET_ARN|_SECRET_VERSION|_KMS_KEY_ARN|_TOKEN_ENDPOINT)$/u.test(name);
  if (!allowedMetadata && /(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|ACCESS_KEY)/u.test(name)) {
    throw new Error(`profile input ${name} could carry a secret value`);
  }
}

function renderFromEnvironment(profile, phase, environment) {
  const raw = new Map();
  for (const definition of [...profile.foundationInputs, ...profile.parameterInputs]) {
    const value = environment[definition.env];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${definition.env} is required`);
    }
    assertSingleLine(value, definition.env);
    raw.set(definition.env, value);
  }
  const context = {
    profile,
    phase,
    accountId: validateValue("accountId", raw.get("FAKECO_AWS_ACCOUNT_ID"), {}),
    region: validateValue("region", raw.get("FAKECO_AWS_REGION"), {}),
  };
  const foundation = {};
  for (const definition of profile.foundationInputs) {
    foundation[foundationKey(definition.env)] = validateValue(
      definition.kind,
      raw.get(definition.env),
      context,
    );
  }
  context.foundation = foundation;

  const inputParameters = profile.parameterInputs.map((definition) => ({
    ParameterKey: definition.parameter,
    ParameterValue: validateValue(definition.kind, raw.get(definition.env), context),
  }));
  const parameters = [
    ...Object.entries(profile.lockedParameters).map(([ParameterKey, ParameterValue]) => ({
      ParameterKey,
      ParameterValue,
    })),
    ...inputParameters,
  ].sort((a, b) => a.ParameterKey.localeCompare(b.ParameterKey));

  const rendered = {
    schemaVersion: 1,
    profile: profile.name,
    repository: profile.repository,
    phase,
    stackName: profile.stackName,
    oidcSubject: profile.oidcSubjects[phase],
    target: {
      accountId: context.accountId,
      region: context.region,
      githubRoleArn: foundation.githubRoleArn,
      cloudFormationServiceRoleArn: foundation.cloudFormationServiceRoleArn,
      cloudFormationArtifactBucket: foundation.cloudFormationArtifactBucket,
      ecrRepositoryArn: foundation.ecrRepositoryArn,
    },
    tags: Object.entries(profile.tags)
      .map(([Key, Value]) => ({ Key, Value }))
      .sort((a, b) => a.Key.localeCompare(b.Key)),
    parameters,
  };
  verifyRendered(profile, rendered);
  return rendered;
}

function verifyRendered(profile, rendered, stackDocument) {
  requireObject(rendered, "rendered deployment");
  assertEqual(rendered.schemaVersion, 1, "rendered schemaVersion");
  assertEqual(rendered.profile, profile.name, "rendered profile");
  assertEqual(rendered.repository, profile.repository, "rendered repository");
  const phase = requirePhase(rendered.phase);
  assertEqual(rendered.stackName, profile.stackName, "rendered stackName");
  assertEqual(rendered.oidcSubject, profile.oidcSubjects[phase], "rendered OIDC subject");
  requireObject(rendered.target, "rendered target");
  const context = {
    profile,
    phase,
    accountId: validateValue("accountId", rendered.target.accountId, {}),
    region: validateValue("region", rendered.target.region, {}),
  };
  validateValue("githubRoleArn", rendered.target.githubRoleArn, context);
  validateValue(
    "cloudFormationServiceRoleArn",
    rendered.target.cloudFormationServiceRoleArn,
    context,
  );
  validateValue(
    "cloudFormationArtifactBucket",
    rendered.target.cloudFormationArtifactBucket,
    context,
  );
  validateValue("ecrRepositoryArn", rendered.target.ecrRepositoryArn, context);
  context.foundation = {
    githubRoleArn: rendered.target.githubRoleArn,
    cloudFormationServiceRoleArn: rendered.target.cloudFormationServiceRoleArn,
    cloudFormationArtifactBucket: rendered.target.cloudFormationArtifactBucket,
    ecrRepositoryArn: rendered.target.ecrRepositoryArn,
  };

  const expectedTags = Object.entries(profile.tags)
    .map(([Key, Value]) => ({ Key, Value }))
    .sort((a, b) => a.Key.localeCompare(b.Key));
  assertDeepEqual(rendered.tags, expectedTags, "rendered stack tags");
  if (!Array.isArray(rendered.parameters)) throw new Error("rendered parameters must be an array");
  const actualParameters = parameterMap(rendered.parameters);
  const expectedNames = new Set([
    ...Object.keys(profile.lockedParameters),
    ...profile.parameterInputs.map((entry) => entry.parameter),
  ]);
  if (actualParameters.size !== expectedNames.size) {
    throw new Error("rendered parameters do not match the locked profile surface");
  }
  for (const name of expectedNames) {
    if (!actualParameters.has(name)) throw new Error(`rendered parameter ${name} is missing`);
  }
  for (const [name, value] of Object.entries(profile.lockedParameters)) {
    assertEqual(actualParameters.get(name), value, `rendered locked parameter ${name}`);
  }
  for (const definition of profile.parameterInputs) {
    validateValue(definition.kind, actualParameters.get(definition.parameter), context);
  }
  assertEqual(
    actualParameters.get("ExistingEcrRepositoryArn"),
    rendered.target.ecrRepositoryArn,
    "external ECR repository identity",
  );
  validateImageMatchesRepository(
    actualParameters.get("ImageUri"),
    rendered.target.ecrRepositoryArn,
    context,
  );
  if (actualParameters.get("ConsoleHostname") === actualParameters.get("RuntimeHostname")) {
    throw new Error("FakeCo console and runtime hostnames must differ");
  }
  if (stackDocument) verifyStack(rendered, actualParameters, stackDocument);
  return {
    phase,
    stackName: rendered.stackName,
    parameterCount: rendered.parameters.length,
    stackVerified: Boolean(stackDocument),
  };
}

function verifyStack(rendered, expectedParameters, document) {
  const stacks = document?.Stacks;
  if (!Array.isArray(stacks) || stacks.length !== 1) {
    throw new Error("stack description must contain exactly one stack");
  }
  const stack = stacks[0];
  assertEqual(stack.StackName, rendered.stackName, "observed stack name");
  assertEqual(
    stack.RoleARN,
    rendered.target.cloudFormationServiceRoleArn,
    "observed CloudFormation service role",
  );
  if (!safeStackStatuses.has(stack.StackStatus)) {
    throw new Error(`stack status ${String(stack.StackStatus)} is not safe for this operation`);
  }
  const observedParameters = parameterMap(stack.Parameters ?? []);
  for (const [key, value] of expectedParameters) {
    assertEqual(observedParameters.get(key), value, `observed stack parameter ${key}`);
  }
  const expectedTags = new Map(rendered.tags.map((entry) => [entry.Key, entry.Value]));
  const observedTags = new Map((stack.Tags ?? []).map((entry) => [entry.Key, entry.Value]));
  if (observedTags.size !== expectedTags.size) {
    throw new Error("observed stack tags differ from the locked FakeCo tags");
  }
  for (const [key, value] of expectedTags) {
    assertEqual(observedTags.get(key), value, `observed stack tag ${key}`);
  }
  const outputNames = new Set((stack.Outputs ?? []).map((entry) => entry.OutputKey));
  for (const name of [
    "AlbDnsName",
    "ConsoleOrigin",
    "RuntimeOrigin",
    "EcsClusterName",
    "EcsServiceArn",
    "VpcId",
  ]) {
    if (!outputNames.has(name)) throw new Error(`observed stack output ${name} is missing`);
  }
  if (outputNames.has("EcrRepositoryUri")) {
    throw new Error("FakeCo stack must not own an ECR repository");
  }
}

function buildTeardownPlan(profile, rendered, stack, resourcesDocument, retention) {
  if (rendered.phase !== "teardown") {
    throw new Error("teardown-plan requires a teardown-phase render");
  }
  verifyRendered(profile, rendered, stack);
  requireObject(retention, "retained resource manifest");
  assertEqual(retention.schemaVersion, 1, "retention schemaVersion");
  assertEqual(retention.stackDeletionMode, "STANDARD", "stack deletion mode");
  if (!Array.isArray(retention.resources) || retention.resources.length === 0) {
    throw new Error("retained resource manifest is empty");
  }
  const stackResources = resourcesDocument?.StackResources;
  if (!Array.isArray(stackResources)) throw new Error("stack resources document is invalid");
  if (stackResources.some((resource) => resource.LogicalResourceId === "ContainerRepository")) {
    throw new Error("FakeCo stack unexpectedly owns an ECR repository");
  }
  const observed = new Map(stackResources.map((resource) => [resource.LogicalResourceId, resource]));
  const retainedResources = retention.resources.map((entry) => {
    requireObject(entry, `retained resource ${String(entry?.logicalId ?? "unknown")}`);
    const resource = observed.get(entry.logicalId);
    if (!resource) throw new Error(`retained resource ${entry.logicalId} is absent from the stack`);
    assertEqual(resource.ResourceType, entry.type, `retained resource type ${entry.logicalId}`);
    if (!new Set(["retain", "snapshot"]).has(entry.disposition)) {
      throw new Error(`retained resource ${entry.logicalId} has an invalid disposition`);
    }
    return {
      logicalId: entry.logicalId,
      physicalId: String(resource.PhysicalResourceId ?? ""),
      type: entry.type,
      disposition: entry.disposition,
      reason: entry.reason,
    };
  });
  const parameters = parameterMap(rendered.parameters);
  for (const [key, value] of [
    ["CreateEcrRepository", "false"],
    ["ProvisionService", "true"],
    ["LoadBalancerDeletionProtection", "false"],
    ["DatabaseDeletionProtection", "false"],
  ]) {
    assertEqual(parameters.get(key), value, `teardown parameter ${key}`);
  }
  const externalPrerequisites = [
    [
      "github-oidc-deploy-role",
      `arn:aws:iam::${rendered.target.accountId}:role/${profile.githubRolePaths.deploy}`,
    ],
    [
      "github-oidc-teardown-role",
      `arn:aws:iam::${rendered.target.accountId}:role/${profile.githubRolePaths.teardown}`,
    ],
    ["cloudformation-service-role", rendered.target.cloudFormationServiceRoleArn],
    ["cloudformation-artifact-bucket", rendered.target.cloudFormationArtifactBucket],
    ["ecr-repository", rendered.target.ecrRepositoryArn],
    ["workload-permissions-boundary", parameters.get("WorkloadPermissionsBoundaryArn")],
    ["application-secret", parameters.get("ApplicationSecretArn")],
    ["application-secret-kms-key", parameters.get("ApplicationSecretKmsKeyArn")],
    ["acm-certificate", parameters.get("CertificateArn")],
  ].map(([kind, identifier]) => ({ kind, identifier, disposition: "account-foundation-owned" }));

  return {
    schemaVersion: 1,
    profile: rendered.profile,
    stackName: rendered.stackName,
    accountId: rendered.target.accountId,
    region: rendered.target.region,
    oidcSubject: rendered.oidcSubject,
    deletion: {
      api: "cloudformation:DeleteStack",
      mode: "STANDARD",
      force: false,
      roleArn: rendered.target.cloudFormationServiceRoleArn,
      command: [
        "aws",
        "cloudformation",
        "delete-stack",
        "--stack-name",
        rendered.stackName,
        "--role-arn",
        rendered.target.cloudFormationServiceRoleArn,
        "--deletion-mode",
        "STANDARD",
      ],
    },
    retainedResources,
    externalPrerequisites,
    outOfScope: [
      "retained resource disposal",
      "account closure or data-deletion requests",
      "OIDC provider and role deletion",
      "permissions boundary and CloudFormation service-role deletion",
      "ECR, ACM, DNS, budget, and anomaly-monitoring deletion",
    ],
  };
}

function validateValue(kind, value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${kind} value is required`);
  }
  assertSingleLine(value, kind);
  switch (kind) {
    case "accountId":
      if (!/^[0-9]{12}$/u.test(value)) throw new Error("AWS account id must contain 12 digits");
      return value;
    case "region":
      if (!/^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z0-9-]+-[0-9]$/u.test(value)) {
        throw new Error("FakeCo AWS region is invalid");
      }
      return value;
    case "githubRoleArn":
      return exactIamArn(value, context, "role", context.profile.githubRolePaths[context.phase]);
    case "cloudFormationServiceRoleArn":
      return exactIamArn(
        value,
        context,
        "role",
        context.profile.cloudFormationServiceRolePath,
      );
    case "cloudFormationArtifactBucket": {
      const expected = context.profile.cloudFormationArtifactBucketPattern
        .replace("{accountId}", context.accountId)
        .replace("{region}", context.region);
      assertEqual(value, expected, "FakeCo CloudFormation artifact bucket");
      return value;
    }
    case "workloadPermissionsBoundaryArn":
      return exactIamArn(
        value,
        context,
        "policy",
        context.profile.workloadPermissionsBoundaryPath,
      );
    case "ecrRepositoryArn": {
      const expected = `arn:aws:ecr:${context.region}:${context.accountId}:repository/${context.profile.ecrRepositoryName}`;
      assertEqual(value, expected, "FakeCo ECR repository ARN");
      return value;
    }
    case "certificateArn":
      return exactRegionalArn(value, context, "acm", `certificate/[A-Za-z0-9-]+`);
    case "applicationSecretArn":
      return exactRegionalArn(value, context, "secretsmanager", "secret:[A-Za-z0-9/_+=.@-]+(?:-[A-Za-z0-9]{6})?");
    case "kmsKeyArn":
      return exactRegionalArn(value, context, "kms", "key/[A-Za-z0-9-]+");
    case "imageUri":
      if (!/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u.test(value)) {
        throw new Error("FakeCo image must be an ECR repo@sha256 digest URI");
      }
      return value;
    case "hostname":
      return validateHostname(value);
    case "httpsUrl":
      return validateHttpsUrl(value, false);
    case "clawRouterUrl": {
      const origin = validateHttpsUrl(value, true);
      const hostname = new URL(origin).hostname.toLowerCase();
      if (hostname === "clawrouter.openclaw.ai" || hostname.endsWith(".invalid")) {
        throw new Error("FakeCo ClawRouter origin must be an explicit non-production origin");
      }
      return origin;
    }
    case "identifier":
      if (value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new Error("identifier must be bounded printable text");
      }
      return value;
    case "version":
      if (!/^[A-Za-z0-9]{1,16}$/u.test(value)) throw new Error("version is invalid");
      return value;
    case "dnsLabel":
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) {
        throw new Error("target id must be a lowercase DNS label");
      }
      return value;
    case "label":
      if (value.trim() !== value || value.length > 120) throw new Error("target label is invalid");
      return value;
    case "emailList": {
      const emails = value.split(",").map((entry) => entry.trim().toLowerCase());
      if (emails.length === 0 || emails.some((email) => !/^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/u.test(email))) {
        throw new Error("administrator email list is invalid");
      }
      return [...new Set(emails)].join(",");
    }
    case "digest":
      if (!/^[0-9a-f]{64}$/u.test(value) || /^0{64}$/u.test(value)) {
        throw new Error("artifact digest must be a non-placeholder lowercase SHA-256 digest");
      }
      return value;
    case "topicName":
      if (!/^[A-Za-z0-9_-]{1,256}$/u.test(value)) throw new Error("SNS topic name is invalid");
      return value;
    default:
      throw new Error(`unsupported validator kind ${kind}`);
  }
}

function validateImageMatchesRepository(imageUri, repositoryArn, context) {
  const repositoryName = repositoryArn.split(":repository/")[1];
  const prefix = `${context.accountId}.dkr.ecr.${context.region}.amazonaws.com/${repositoryName}@sha256:`;
  if (!imageUri.startsWith(prefix)) {
    throw new Error("FakeCo image URI does not match the target account, region, and ECR repository ARN");
  }
}

function exactIamArn(value, context, resourceType, resourcePath) {
  const expected = `arn:aws:iam::${context.accountId}:${resourceType}/${resourcePath}`;
  assertEqual(value, expected, `FakeCo ${resourceType} ARN`);
  return value;
}

function exactRegionalArn(value, context, service, resourcePattern) {
  const expression = new RegExp(
    `^arn:aws:${service}:${escapeRegex(context.region)}:${escapeRegex(context.accountId)}:${resourcePattern}$`,
    "u",
  );
  if (!expression.test(value)) {
    throw new Error(`${service} ARN must match the FakeCo account and region`);
  }
  return value;
}

function validateHostname(value) {
  if (value.length > 253 || value !== value.toLowerCase() || value.endsWith(".")) {
    throw new Error("hostname must be a lowercase DNS name without a trailing dot");
  }
  const labels = value.split(".");
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new Error("hostname must be a valid DNS name");
  }
  return value;
}

function validateHttpsUrl(value, exactOrigin) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("URL must be valid HTTPS");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("URL must use HTTPS without credentials, query, or fragment");
  }
  if (exactOrigin && (parsed.pathname !== "/" || parsed.origin !== value)) {
    throw new Error("URL must be an exact HTTPS origin");
  }
  return exactOrigin ? parsed.origin : value;
}

function foundationKey(environmentName) {
  const mapping = {
    FAKECO_AWS_ACCOUNT_ID: "accountId",
    FAKECO_AWS_REGION: "region",
    FAKECO_GITHUB_ROLE_ARN: "githubRoleArn",
    FAKECO_CLOUDFORMATION_SERVICE_ROLE_ARN: "cloudFormationServiceRoleArn",
    FAKECO_CLOUDFORMATION_ARTIFACT_BUCKET: "cloudFormationArtifactBucket",
    FAKECO_ECR_REPOSITORY_ARN: "ecrRepositoryArn",
  };
  const key = mapping[environmentName];
  if (!key) throw new Error(`unsupported foundation input ${environmentName}`);
  return key;
}

function parameterMap(parameters) {
  if (!Array.isArray(parameters)) throw new Error("parameters must be an array");
  const result = new Map();
  for (const parameter of parameters) {
    requireObject(parameter, "parameter");
    const key = parameter.ParameterKey;
    const value = parameter.ParameterValue;
    if (!/^[A-Za-z][A-Za-z0-9]+$/u.test(key ?? "") || typeof value !== "string") {
      throw new Error("parameter entry is invalid");
    }
    if (result.has(key)) throw new Error(`parameter ${key} is duplicated`);
    assertSingleLine(value, key);
    result.set(key, value);
  }
  return result;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/u.test(key ?? "") || value === undefined) {
      throw new Error(`invalid option near ${String(key)}`);
    }
    const name = key.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`option --${name} is duplicated`);
    options[name] = value;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requirePhase(value) {
  if (value !== "deploy" && value !== "teardown") {
    throw new Error("phase must be deploy or teardown");
  }
  return value;
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function writePrivateJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, text, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function assertSingleLine(value, label) {
  if (typeof value !== "string" || /[\r\n\u0000]/u.test(value)) {
    throw new Error(`${label} must be a single-line string`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} must equal ${JSON.stringify(expected)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the locked profile`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

main().catch((error) => {
  process.stderr.write(`fakeco foundation: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
