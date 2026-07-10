#!/usr/bin/env node

import { createHash } from "node:crypto";
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
const safeTeardownStackStatuses = new Set([
  ...safeStackStatuses,
  "DELETE_FAILED",
]);
const singleImageMediaTypes = new Set([
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
]);
const imageIndexMediaTypes = new Set([
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
]);
const imageConfigMediaTypes = new Set([
  "application/vnd.docker.container.image.v1+json",
  "application/vnd.oci.image.config.v1+json",
]);
const retainingDeletionPolicies = new Set([
  "Retain",
  "RetainExceptOnCreate",
  "Snapshot",
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
    case "image-manifest-kind":
    case "image-selected-digest":
    case "image-config-digest": {
      const rendered = await readJson(
        requireOption(options, "rendered"),
        "rendered FakeCo deployment",
      );
      const response = await readBoundedJson(
        requireOption(options, "ecr-response"),
        "ECR image manifest response",
        6 * 1024 * 1024,
      );
      const inspection = inspectEcrManifest(profile, rendered, response);
      if (command === "image-manifest-kind") {
        process.stdout.write(inspection.kind);
        return;
      }
      if (command === "image-selected-digest") {
        process.stdout.write(inspection.selectedDigest);
        return;
      }
      const configInspection = inspection.kind === "single"
        ? inspection
        : inspectEcrIndexChild(
            rendered,
            inspection,
            await readBoundedJson(
              requireOption(options, "child-ecr-response"),
              "ECR child image manifest response",
              6 * 1024 * 1024,
            ),
          );
      process.stdout.write(configInspection.configDigest);
      return;
    }
    case "verify-image-manifest": {
      const rendered = await readJson(
        requireOption(options, "rendered"),
        "rendered FakeCo deployment",
      );
      const response = await readBoundedJson(
        requireOption(options, "ecr-response"),
        "ECR image manifest response",
        6 * 1024 * 1024,
      );
      const inspection = inspectEcrManifest(profile, rendered, response);
      const configInspection = inspection.kind === "single"
        ? inspection
        : inspectEcrIndexChild(
            rendered,
            inspection,
            await readBoundedJson(
              requireOption(options, "child-ecr-response"),
              "ECR child image manifest response",
              6 * 1024 * 1024,
            ),
          );
      const result = verifyImageConfig(
        configInspection,
        await readBoundedJsonDocument(
          requireOption(options, "config"),
          "container image config",
          10 * 1024 * 1024,
        ),
        inspection.kind,
      );
      printJson({
        ok: true,
        kind: result.kind,
        os: result.os,
        architecture: result.architecture,
      });
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
      const template = await readBoundedText(
        requireOption(options, "template"),
        "reviewed CloudFormation template",
        2 * 1024 * 1024,
      );
      const liveTemplateResponse = await readBoundedJson(
        requireOption(options, "live-template-response"),
        "live CloudFormation template response",
        2 * 1024 * 1024,
      );
      const retentionContract = verifyRetentionContract(
        retention,
        template,
        liveTemplateResponse,
        resources,
      );
      const plan = buildTeardownPlan(
        profile,
        rendered,
        stack,
        resources,
        retention,
        retentionContract,
      );
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
        "usage: foundation.mjs <validate-profile|render|verify|parameter-overrides|image-manifest-kind|image-selected-digest|image-config-digest|verify-image-manifest|teardown-plan> [options]",
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
  assertOpaqueEqual(
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
  assertOpaqueEqual(
    stack.RoleARN,
    rendered.target.cloudFormationServiceRoleArn,
    "observed CloudFormation service role",
  );
  const allowedStatuses = rendered.phase === "teardown"
    ? safeTeardownStackStatuses
    : safeStackStatuses;
  if (!allowedStatuses.has(stack.StackStatus)) {
    throw new Error(`stack status ${String(stack.StackStatus)} is not safe for this operation`);
  }
  const observedParameters = parameterMap(stack.Parameters ?? []);
  for (const [key, value] of expectedParameters) {
    assertOpaqueEqual(observedParameters.get(key), value, `observed stack parameter ${key}`);
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

function buildTeardownPlan(
  profile,
  rendered,
  stack,
  resourcesDocument,
  retention,
  retentionContract,
) {
  if (rendered.phase !== "teardown") {
    throw new Error("teardown-plan requires a teardown-phase render");
  }
  verifyRendered(profile, rendered, stack);
  const retentionResources = validateRetentionManifest(retention);
  requireObject(retentionContract, "retention contract proof");
  const stackResources = resourcesDocument?.StackResources;
  if (!Array.isArray(stackResources)) throw new Error("stack resources document is invalid");
  if (stackResources.some((resource) => resource.LogicalResourceId === "ContainerRepository")) {
    throw new Error("FakeCo stack unexpectedly owns an ECR repository");
  }
  const observed = new Map(stackResources.map((resource) => [resource.LogicalResourceId, resource]));
  const retainedResources = retentionResources.map((entry) => {
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
    retentionContract,
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

function validateRetentionManifest(retention) {
  requireObject(retention, "retained resource manifest");
  assertEqual(retention.schemaVersion, 1, "retention schemaVersion");
  assertEqual(retention.stackDeletionMode, "STANDARD", "stack deletion mode");
  if (!Array.isArray(retention.resources) || retention.resources.length === 0) {
    throw new Error("retained resource manifest is empty");
  }
  const logicalIds = new Set();
  for (const entry of retention.resources) {
    requireObject(entry, `retained resource ${String(entry?.logicalId ?? "unknown")}`);
    if (!/^[A-Za-z][A-Za-z0-9]+$/u.test(entry.logicalId ?? "")) {
      throw new Error("retained resource logical id is invalid");
    }
    if (logicalIds.has(entry.logicalId)) {
      throw new Error(`retained resource ${entry.logicalId} is duplicated`);
    }
    logicalIds.add(entry.logicalId);
    if (typeof entry.type !== "string" || !entry.type.startsWith("AWS::")) {
      throw new Error(`retained resource ${entry.logicalId} type is invalid`);
    }
    if (!new Set(["retain", "snapshot"]).has(entry.disposition)) {
      throw new Error(`retained resource ${entry.logicalId} has an invalid disposition`);
    }
  }
  return retention.resources;
}

function verifyRetentionContract(
  retention,
  reviewedTemplate,
  liveTemplateResponse,
  resourcesDocument,
) {
  const retentionResources = validateRetentionManifest(retention);
  requireObject(liveTemplateResponse, "live CloudFormation template response");
  const liveTemplate = liveTemplateResponse.TemplateBody;
  if (typeof liveTemplate !== "string" || liveTemplate.length === 0) {
    throw new Error("live CloudFormation template response has no template body");
  }
  const reviewedBlocks = extractResourceBlocks(reviewedTemplate, "reviewed template");
  const liveBlocks = extractResourceBlocks(liveTemplate, "live template");
  const stackResources = resourcesDocument?.StackResources;
  if (!Array.isArray(stackResources)) throw new Error("stack resources document is invalid");
  const manifestedLogicalIds = new Set(
    retentionResources.map((entry) => entry.logicalId),
  );
  const observedLogicalIds = new Set();
  for (const resource of stackResources) {
    requireObject(resource, "observed stack resource");
    const logicalId = resource.LogicalResourceId;
    if (!/^[A-Za-z][A-Za-z0-9]+$/u.test(logicalId ?? "")) {
      throw new Error("observed stack resource logical id is invalid");
    }
    if (observedLogicalIds.has(logicalId)) {
      throw new Error(`observed stack resource ${logicalId} is duplicated`);
    }
    observedLogicalIds.add(logicalId);
    const liveBlock = liveBlocks.get(logicalId);
    if (!liveBlock) throw new Error(`live template resource ${logicalId} is missing`);
    const deletionPolicy = optionalTopLevelResourceField(
      liveBlock,
      "DeletionPolicy",
      logicalId,
    );
    if (
      retainingDeletionPolicies.has(deletionPolicy) &&
      !manifestedLogicalIds.has(logicalId)
    ) {
      throw new Error(`retained live resource ${logicalId} is not declared in the manifest`);
    }
  }
  const contractHash = createHash("sha256");
  const sortedResources = [...retentionResources]
    .sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  for (const entry of sortedResources) {
    const reviewedBlock = reviewedBlocks.get(entry.logicalId);
    const liveBlock = liveBlocks.get(entry.logicalId);
    if (!reviewedBlock || !liveBlock) {
      throw new Error(`retention contract resource ${entry.logicalId} is missing`);
    }
    const expectedDeletionPolicy = entry.disposition === "snapshot"
      ? "Snapshot"
      : "RetainExceptOnCreate";
    const expectedUpdateReplacePolicy = entry.disposition === "snapshot"
      ? "Snapshot"
      : "Retain";
    assertEqual(
      topLevelResourceField(reviewedBlock, "Type", entry.logicalId),
      entry.type,
      `reviewed retention resource type ${entry.logicalId}`,
    );
    assertEqual(
      topLevelResourceField(reviewedBlock, "DeletionPolicy", entry.logicalId),
      expectedDeletionPolicy,
      `reviewed deletion policy ${entry.logicalId}`,
    );
    assertEqual(
      topLevelResourceField(reviewedBlock, "UpdateReplacePolicy", entry.logicalId),
      expectedUpdateReplacePolicy,
      `reviewed update-replace policy ${entry.logicalId}`,
    );
    const reviewedDigest = createHash("sha256").update(reviewedBlock).digest("hex");
    const liveDigest = createHash("sha256").update(liveBlock).digest("hex");
    // AWS CLI v2 uploads template_str verbatim; GetTemplate Original returns that submitted YAML.
    if (liveDigest !== reviewedDigest) {
      throw new Error(`live retention contract differs for ${entry.logicalId}`);
    }
    contractHash.update(entry.logicalId).update("\0").update(reviewedBlock).update("\0");
  }
  return {
    algorithm: "sha256",
    digest: contractHash.digest("hex"),
    resourceCount: sortedResources.length,
    liveTemplateVerified: true,
  };
}

function extractResourceBlocks(template, label) {
  if (typeof template !== "string" || template.length === 0) {
    throw new Error(`${label} is empty`);
  }
  const lines = template.replace(/\r\n?/gu, "\n").split("\n");
  const resourcesIndexes = lines
    .map((line, index) => line === "Resources:" ? index : -1)
    .filter((index) => index >= 0);
  if (resourcesIndexes.length !== 1) {
    throw new Error(`${label} must contain one top-level Resources section`);
  }
  const blocks = new Map();
  for (let index = resourcesIndexes[0] + 1; index < lines.length;) {
    if (/^[A-Za-z][A-Za-z0-9]*:/u.test(lines[index] ?? "")) break;
    const resource = /^  ([A-Za-z][A-Za-z0-9]+):\s*$/u.exec(lines[index] ?? "");
    if (!resource) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length) {
      if (/^[A-Za-z][A-Za-z0-9]*:/u.test(lines[end] ?? "") ||
          /^  [A-Za-z][A-Za-z0-9]+:\s*$/u.test(lines[end] ?? "")) {
        break;
      }
      end += 1;
    }
    const logicalId = resource[1];
    if (blocks.has(logicalId)) throw new Error(`${label} duplicates resource ${logicalId}`);
    const block = `${lines.slice(index, end).map((line) => line.trimEnd()).join("\n").trimEnd()}\n`;
    blocks.set(logicalId, block);
    index = end;
  }
  return blocks;
}

function topLevelResourceField(block, field, logicalId) {
  const value = optionalTopLevelResourceField(block, field, logicalId);
  if (value === undefined) {
    throw new Error(`retention resource ${logicalId} must have one ${field}`);
  }
  return value;
}

function optionalTopLevelResourceField(block, field, logicalId) {
  const expression = new RegExp(`^    ${field}:\\s*([^#\\r\\n]+?)\\s*$`, "gmu");
  const matches = [...block.matchAll(expression)];
  if (matches.length > 1) {
    throw new Error(`retention resource ${logicalId} must have one ${field}`);
  }
  return matches.length === 0 ? undefined : matches[0][1].trim();
}

function inspectEcrManifest(profile, rendered, response) {
  verifyRendered(profile, rendered);
  const parameters = parameterMap(rendered.parameters);
  const imageUri = parameters.get("ImageUri");
  const expectedDigest = imageUri.slice(imageUri.lastIndexOf("@") + 1);
  const parsed = parseBoundEcrManifest(
    rendered,
    response,
    expectedDigest,
    "ECR image manifest",
  );
  if (singleImageMediaTypes.has(parsed.mediaType)) {
    return inspectSingleManifest(parsed, expectedDigest, "container image");
  }
  if (imageIndexMediaTypes.has(parsed.mediaType)) {
    if (!Array.isArray(parsed.manifest.manifests) || parsed.manifest.manifests.length === 0) {
      throw new Error("container image index has no child manifests");
    }
    const candidates = parsed.manifest.manifests.filter((descriptor) => {
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return false;
      return descriptor.platform?.os === "linux" && descriptor.platform?.architecture === "amd64";
    });
    if (candidates.length === 0) {
      throw new Error("container image index has no Linux/AMD64 child");
    }
    if (candidates.length !== 1) {
      throw new Error("container image index has ambiguous Linux/AMD64 children");
    }
    const candidate = candidates[0];
    if (!singleImageMediaTypes.has(candidate.mediaType)) {
      throw new Error("Linux/AMD64 child manifest media type is unsupported");
    }
    return {
      kind: "index",
      selectedDigest: requireSha256Digest(
        candidate.digest,
        "Linux/AMD64 child manifest digest",
      ),
      selectedMediaType: candidate.mediaType,
    };
  }
  throw new Error("container image manifest media type is unsupported");
}

function inspectEcrIndexChild(rendered, indexInspection, response) {
  if (indexInspection.kind !== "index") {
    throw new Error("child image inspection requires an image index");
  }
  const parsed = parseBoundEcrManifest(
    rendered,
    response,
    indexInspection.selectedDigest,
    "ECR child image manifest",
  );
  if (!singleImageMediaTypes.has(parsed.mediaType)) {
    throw new Error("Linux/AMD64 child did not resolve to a single image manifest");
  }
  assertOpaqueEqual(
    parsed.mediaType,
    indexInspection.selectedMediaType,
    "Linux/AMD64 child manifest media type",
  );
  return inspectSingleManifest(
    parsed,
    indexInspection.selectedDigest,
    "Linux/AMD64 child image",
  );
}

function parseBoundEcrManifest(rendered, response, expectedDigest, label) {
  requireObject(response, "ECR image manifest response");
  if (!Array.isArray(response.failures) || response.failures.length !== 0) {
    throw new Error(`${label} lookup reported a failure`);
  }
  if (!Array.isArray(response.images) || response.images.length !== 1) {
    throw new Error(`${label} lookup must return exactly one image`);
  }
  const image = response.images[0];
  requireObject(image, label);
  requireObject(image.imageId, `${label} id`);
  const expectedRepository = rendered.target.ecrRepositoryArn.split(":repository/")[1];
  assertOpaqueEqual(image.registryId, rendered.target.accountId, `${label} registry account`);
  assertOpaqueEqual(image.repositoryName, expectedRepository, `${label} repository`);
  assertOpaqueEqual(image.imageId.imageDigest, expectedDigest, `${label} digest`);
  if (typeof image.imageManifest !== "string" || image.imageManifest.length > 5 * 1024 * 1024) {
    throw new Error(`${label} must be bounded JSON text`);
  }
  let manifest;
  try {
    manifest = JSON.parse(image.imageManifest);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  requireObject(manifest, label);
  assertEqual(manifest.schemaVersion, 2, `${label} schemaVersion`);
  const responseMediaType = image.imageManifestMediaType;
  const embeddedMediaType = manifest.mediaType;
  if (responseMediaType !== undefined && typeof responseMediaType !== "string") {
    throw new Error(`${label} media type is invalid`);
  }
  if (embeddedMediaType !== undefined && typeof embeddedMediaType !== "string") {
    throw new Error(`embedded ${label} media type is invalid`);
  }
  if (responseMediaType && embeddedMediaType && responseMediaType !== embeddedMediaType) {
    throw new Error(`ECR response and embedded ${label} media types disagree`);
  }
  const mediaType = responseMediaType || embeddedMediaType;
  if (!singleImageMediaTypes.has(mediaType) && !imageIndexMediaTypes.has(mediaType)) {
    throw new Error(`${label} media type is unsupported`);
  }
  return { manifest, mediaType };
}

function inspectSingleManifest(parsed, selectedDigest, label) {
  requireObject(parsed.manifest.config, `${label} config descriptor`);
  if (!imageConfigMediaTypes.has(parsed.manifest.config.mediaType)) {
    throw new Error(`${label} config media type is unsupported`);
  }
  return {
    kind: "single",
    selectedDigest,
    configDigest: requireSha256Digest(
      parsed.manifest.config.digest,
      `${label} config digest`,
    ),
  };
}

function verifyImageConfig(inspection, document, outputKind) {
  const actualDigest = `sha256:${createHash("sha256").update(document.bytes).digest("hex")}`;
  assertOpaqueEqual(actualDigest, inspection.configDigest, "container image config digest");
  const config = document.value;
  requireObject(config, "container image config");
  if (config.os !== "linux" || config.architecture !== "amd64") {
    throw new Error("container image config must declare os=linux and architecture=amd64");
  }
  return {
    kind: outputKind,
    os: config.os,
    architecture: config.architecture,
    selectedDigest: inspection.selectedDigest,
    configDigest: inspection.configDigest,
  };
}

function requireSha256Digest(value, label) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
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
      assertOpaqueEqual(value, expected, "FakeCo CloudFormation artifact bucket");
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
      assertOpaqueEqual(value, expected, "FakeCo ECR repository ARN");
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
      if (
        hostname.endsWith(".") ||
        hostname === "clawrouter.openclaw.ai" ||
        hostname.endsWith(".invalid")
      ) {
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
  assertOpaqueEqual(value, expected, `FakeCo ${resourceType} ARN`);
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

async function readBoundedJson(filePath, label, maximumBytes) {
  return (await readBoundedJsonDocument(filePath, label, maximumBytes)).value;
}

async function readBoundedJsonDocument(filePath, label, maximumBytes) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new Error(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${label} exceeds its size limit`);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function readBoundedText(filePath, label, maximumBytes) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new Error(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${label} exceeds its size limit`);
  }
  const value = bytes.toString("utf8");
  if (value.includes("\ufffd")) throw new Error(`${label} is not valid UTF-8 text`);
  return value;
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

function assertOpaqueEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} does not match the verified FakeCo selection`);
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
