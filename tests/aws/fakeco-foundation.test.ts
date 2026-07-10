import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const foundationCli = path.join(repositoryRoot, "deploy/aws/fakeco/foundation.mjs");
const profilePath = path.join(repositoryRoot, "deploy/aws/fakeco/profile.json");
const retentionPath = path.join(repositoryRoot, "deploy/aws/fakeco/retained-resources.json");

test("FakeCo profile locks target identity and exact GitHub OIDC subjects", () => {
  const result = runFoundation(["validate-profile"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    ok: boolean;
    stackName: string;
    oidcSubjects: Record<string, string>;
  };
  assert.equal(output.ok, true);
  assert.equal(output.stackName, "crabhelm-fakeco");
  assert.deepEqual(output.oidcSubjects, {
    deploy: "repo:openclaw/crabhelm:environment:fakeco",
    teardown: "repo:openclaw/crabhelm:environment:fakeco-teardown",
    imagePublish: "repo:openclaw/crabhelm:environment:fakeco-image-publish",
  });
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as {
    lockedParameters: Record<string, string>;
  };
  assert.equal(profile.lockedParameters.SlackMode, "off");
});

test("FakeCo render emits digest-only external-ECR parameters without secret values", async (t) => {
  const directory = await temporaryDirectory(t);
  const renderedPath = path.join(directory, "rendered.json");
  const result = runFoundation(
    ["render", "--phase", "deploy", "--output", renderedPath],
    fakecoEnvironment("deploy"),
  );
  assert.equal(result.status, 0, result.stderr);

  const rendered = JSON.parse(await readFile(renderedPath, "utf8")) as RenderedDeployment;
  assert.equal(rendered.phase, "deploy");
  assert.equal(rendered.target.accountId, "123456789012");
  assert.equal(
    rendered.target.githubRoleArn,
    "arn:aws:iam::123456789012:role/openclaw/fakeco/github/crabhelm-deploy",
  );
  assert.deepEqual(rendered.tags, [
    { Key: "Environment", Value: "fakeco" },
    { Key: "ManagedBy", Value: "github-actions" },
    { Key: "Project", Value: "crabhelm" },
  ]);
  const parameters = new Map(
    rendered.parameters.map((entry) => [entry.ParameterKey, entry.ParameterValue]),
  );
  assert.equal(parameters.get("CreateEcrRepository"), "false");
  assert.equal(parameters.get("ProvisionService"), "true");
  assert.equal(parameters.get("SlackMode"), "off");
  assert.equal(parameters.get("DatabaseStorageAutoscaling"), "false");
  assert.equal(parameters.get("DatabaseMaxAllocatedStorage"), "20");
  assert.equal(parameters.get("DatabaseBackupRetentionDays"), "1");
  assert.equal(parameters.get("DatabaseLogExports"), "off");
  assert.equal(parameters.get("LogRetentionDays"), "7");
  assert.match(parameters.get("ImageUri") ?? "", /@sha256:[0-9a-f]{64}$/u);
  for (const forbidden of [
    "OPENAI_API_KEY",
    "CLAWROUTER_ADMIN_TOKEN",
    "CLAWROUTER_CREDENTIAL_SECRET",
    "OIDC_CLIENT_SECRET",
    "DATABASE_PASSWORD",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
  ]) {
    assert.equal(parameters.has(forbidden), false);
  }

  const verify = runFoundation(["verify", "--rendered", renderedPath]);
  assert.equal(verify.status, 0, verify.stderr);
});

test("FakeCo render fails closed on tags, target drift, production router, or broad roles", async (t) => {
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, "rendered.json");
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    [
      "tagged image",
      { FAKECO_IMAGE_URI: "123456789012.dkr.ecr.us-west-2.amazonaws.com/openclaw/fakeco/crabhelm:latest" },
      /repo@sha256 digest URI/u,
    ],
    [
      "cross-account repository",
      { FAKECO_ECR_REPOSITORY_ARN: "arn:aws:ecr:us-west-2:999999999999:repository/openclaw/fakeco/crabhelm" },
      /FakeCo ECR repository ARN/u,
    ],
    [
      "production router",
      { FAKECO_CLAWROUTER_BASE_URL: "https://clawrouter.openclaw.ai" },
      /explicit non-production origin/u,
    ],
    [
      "production router with an FQDN dot",
      { FAKECO_CLAWROUTER_BASE_URL: "https://clawrouter.openclaw.ai." },
      /explicit non-production origin/u,
    ],
    [
      "unbounded GitHub role",
      { FAKECO_GITHUB_ROLE_ARN: "arn:aws:iam::123456789012:role/Administrator" },
      /FakeCo role ARN/u,
    ],
  ];
  for (const [label, overrides, expected] of cases) {
    const result = runFoundation(
      ["render", "--phase", "deploy", "--output", output],
      { ...fakecoEnvironment("deploy"), ...overrides },
    );
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, expected, label);
  }
});

test("FakeCo verify binds the observed stack to parameters, tags, and service role", async (t) => {
  const directory = await temporaryDirectory(t);
  const renderedPath = path.join(directory, "rendered.json");
  assert.equal(
    runFoundation(
      ["render", "--phase", "deploy", "--output", renderedPath],
      fakecoEnvironment("deploy"),
    ).status,
    0,
  );
  const rendered = JSON.parse(await readFile(renderedPath, "utf8")) as RenderedDeployment;
  const stackPath = path.join(directory, "stack.json");
  await writeFile(stackPath, JSON.stringify(stackDescription(rendered)), "utf8");
  const verified = runFoundation(["verify", "--rendered", renderedPath, "--stack", stackPath]);
  assert.equal(verified.status, 0, verified.stderr);

  const drifted = stackDescription(rendered);
  drifted.Stacks[0]!.RoleARN = "arn:aws:iam::123456789012:role/Administrator";
  await writeFile(stackPath, JSON.stringify(drifted), "utf8");
  const rejected = runFoundation(["verify", "--rendered", renderedPath, "--stack", stackPath]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /observed CloudFormation service role/u);
  assert.doesNotMatch(rejected.stderr, /arn:aws:iam/u);

  const parameterDrift = stackDescription(rendered);
  const adminEmails = parameterDrift.Stacks[0]!.Parameters.find(
    (entry) => entry.ParameterKey === "AdminEmails",
  );
  assert.ok(adminEmails);
  adminEmails.ParameterValue = "drifted-private-user@fakeco.example";
  await writeFile(stackPath, JSON.stringify(parameterDrift), "utf8");
  const privateRejected = runFoundation([
    "verify", "--rendered", renderedPath, "--stack", stackPath,
  ]);
  assert.notEqual(privateRejected.status, 0);
  assert.match(privateRejected.stderr, /observed stack parameter AdminEmails/u);
  assert.doesNotMatch(privateRejected.stderr, /@fakeco\.example/u);

  const deleteFailed = stackDescription(rendered);
  deleteFailed.Stacks[0]!.StackStatus = "DELETE_FAILED";
  await writeFile(stackPath, JSON.stringify(deleteFailed), "utf8");
  const deployRejected = runFoundation([
    "verify", "--rendered", renderedPath, "--stack", stackPath,
  ]);
  assert.notEqual(deployRejected.status, 0);
  assert.match(deployRejected.stderr, /DELETE_FAILED is not safe/u);
});

test("FakeCo image preflight accepts only unambiguous Linux AMD64 artifacts", async (t) => {
  const directory = await temporaryDirectory(t);
  const renderedPath = path.join(directory, "rendered.json");
  const render = runFoundation(
    ["render", "--phase", "deploy", "--output", renderedPath],
    fakecoEnvironment("deploy"),
  );
  assert.equal(render.status, 0, render.stderr);
  const responsePath = path.join(directory, "ecr-response.json");
  const childResponsePath = path.join(directory, "ecr-child-response.json");
  const configPath = path.join(directory, "image-config.json");
  const topDigest = `sha256:${"a".repeat(64)}`;
  const configBytes = JSON.stringify({ os: "linux", architecture: "amd64" });
  const configDigest = `sha256:${createHash("sha256").update(configBytes).digest("hex")}`;
  const childDigest = `sha256:${"f".repeat(64)}`;
  const singleMediaType = "application/vnd.oci.image.manifest.v1+json";
  const childMediaType = "application/vnd.oci.image.manifest.v1+json";
  const indexMediaType = "application/vnd.oci.image.index.v1+json";

  await writeFile(responsePath, JSON.stringify(ecrResponse(topDigest, singleMediaType, {
    schemaVersion: 2,
    mediaType: singleMediaType,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: 200,
    },
    layers: [],
  })), "utf8");
  const digestResult = runFoundation([
    "image-config-digest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
  ]);
  assert.equal(digestResult.status, 0, digestResult.stderr);
  assert.equal(digestResult.stdout, configDigest);
  const singleKind = runFoundation([
    "image-manifest-kind",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
  ]);
  assert.equal(singleKind.status, 0, singleKind.stderr);
  assert.equal(singleKind.stdout, "single");
  await writeFile(configPath, configBytes, "utf8");
  const singleVerified = runFoundation([
    "verify-image-manifest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
    "--config", configPath,
  ]);
  assert.equal(singleVerified.status, 0, singleVerified.stderr);
  assert.deepEqual(JSON.parse(singleVerified.stdout), {
    ok: true,
    kind: "single",
    os: "linux",
    architecture: "amd64",
  });

  await writeFile(configPath, `${configBytes}\n`, "utf8");
  const changedConfig = runFoundation([
    "verify-image-manifest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
    "--config", configPath,
  ]);
  assert.notEqual(changedConfig.status, 0);
  assert.match(changedConfig.stderr, /container image config digest/u);
  assert.doesNotMatch(changedConfig.stderr, /sha256:/u);

  const armConfigBytes = JSON.stringify({ os: "linux", architecture: "arm64" });
  const armConfigDigest = `sha256:${createHash("sha256").update(armConfigBytes).digest("hex")}`;
  await writeFile(responsePath, JSON.stringify(ecrResponse(topDigest, singleMediaType, {
    schemaVersion: 2,
    mediaType: singleMediaType,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: armConfigDigest,
      size: 200,
    },
    layers: [],
  })), "utf8");
  await writeFile(configPath, armConfigBytes, "utf8");
  const armSingle = runFoundation([
    "verify-image-manifest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
    "--config", configPath,
  ]);
  assert.notEqual(armSingle.status, 0);
  assert.match(armSingle.stderr, /os=linux and architecture=amd64/u);

  const validIndex = {
    schemaVersion: 2,
    mediaType: indexMediaType,
    manifests: [
      {
        mediaType: childMediaType,
        digest: childDigest,
        size: 500,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        mediaType: childMediaType,
        digest: `sha256:${"1".repeat(64)}`,
        size: 500,
        platform: { os: "linux", architecture: "arm64" },
      },
      {
        mediaType: childMediaType,
        digest: `sha256:${"2".repeat(64)}`,
        size: 500,
        platform: { os: "unknown", architecture: "unknown" },
      },
    ],
  };
  await writeFile(
    responsePath,
    JSON.stringify(ecrResponse(topDigest, indexMediaType, validIndex)),
    "utf8",
  );
  const indexKind = runFoundation([
    "image-manifest-kind",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
  ]);
  assert.equal(indexKind.status, 0, indexKind.stderr);
  assert.equal(indexKind.stdout, "index");
  const selectedChild = runFoundation([
    "image-selected-digest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
  ]);
  assert.equal(selectedChild.status, 0, selectedChild.stderr);
  assert.equal(selectedChild.stdout, childDigest);
  const childManifest = {
    schemaVersion: 2,
    mediaType: childMediaType,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: 200,
    },
    layers: [],
  };
  await writeFile(
    childResponsePath,
    JSON.stringify(ecrResponse(childDigest, childMediaType, childManifest)),
    "utf8",
  );
  await writeFile(configPath, configBytes, "utf8");
  const indexDigest = runFoundation([
    "image-config-digest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
    "--child-ecr-response", childResponsePath,
  ]);
  assert.equal(indexDigest.status, 0, indexDigest.stderr);
  assert.equal(indexDigest.stdout, configDigest);
  const indexVerified = runFoundation([
    "verify-image-manifest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
    "--child-ecr-response", childResponsePath,
    "--config", configPath,
  ]);
  assert.equal(indexVerified.status, 0, indexVerified.stderr);
  assert.deepEqual(JSON.parse(indexVerified.stdout), {
    ok: true,
    kind: "index",
    os: "linux",
    architecture: "amd64",
  });
  const missingChild = runFoundation([
    "verify-image-manifest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
    "--config", configPath,
  ]);
  assert.notEqual(missingChild.status, 0);
  assert.match(missingChild.stderr, /--child-ecr-response is required/u);

  const deceptiveChildManifest = {
    ...childManifest,
    config: { ...childManifest.config, digest: armConfigDigest },
  };
  await writeFile(
    childResponsePath,
    JSON.stringify(ecrResponse(childDigest, childMediaType, deceptiveChildManifest)),
    "utf8",
  );
  await writeFile(configPath, armConfigBytes, "utf8");
  const deceptiveChild = runFoundation([
    "verify-image-manifest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
    "--child-ecr-response", childResponsePath,
    "--config", configPath,
  ]);
  assert.notEqual(deceptiveChild.status, 0);
  assert.match(deceptiveChild.stderr, /os=linux and architecture=amd64/u);

  await writeFile(
    childResponsePath,
    JSON.stringify(ecrResponse(`sha256:${"8".repeat(64)}`, childMediaType, childManifest)),
    "utf8",
  );
  const wrongChildDigest = runFoundation([
    "image-config-digest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
    "--child-ecr-response", childResponsePath,
  ]);
  assert.notEqual(wrongChildDigest.status, 0);
  assert.match(wrongChildDigest.stderr, /ECR child image manifest digest/u);
  assert.doesNotMatch(wrongChildDigest.stderr, /sha256:/u);

  const dockerIndexMediaType = "application/vnd.docker.distribution.manifest.list.v2+json";
  const dockerChildMediaType = "application/vnd.docker.distribution.manifest.v2+json";
  const dockerIndex = {
    ...validIndex,
    mediaType: dockerIndexMediaType,
    manifests: validIndex.manifests.map((entry) => ({
      ...entry,
      mediaType: dockerChildMediaType,
    })),
  };
  await writeFile(
    responsePath,
    JSON.stringify(ecrResponse(topDigest, dockerIndexMediaType, dockerIndex)),
    "utf8",
  );
  const dockerChildManifest = {
    schemaVersion: 2,
    mediaType: dockerChildMediaType,
    config: {
      mediaType: "application/vnd.docker.container.image.v1+json",
      digest: configDigest,
      size: 200,
    },
    layers: [],
  };
  await writeFile(
    childResponsePath,
    JSON.stringify(ecrResponse(childDigest, dockerChildMediaType, dockerChildManifest)),
    "utf8",
  );
  await writeFile(configPath, configBytes, "utf8");
  const dockerIndexVerified = runFoundation([
    "verify-image-manifest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
    "--child-ecr-response", childResponsePath,
    "--config", configPath,
  ]);
  assert.equal(dockerIndexVerified.status, 0, dockerIndexVerified.stderr);
  assert.deepEqual(JSON.parse(dockerIndexVerified.stdout), {
    ok: true,
    kind: "index",
    os: "linux",
    architecture: "amd64",
  });

  const invalidIndexes: Array<[string, unknown, RegExp]> = [
    [
      "ARM-only",
      { ...validIndex, manifests: validIndex.manifests.filter((entry) => entry.platform.architecture !== "amd64") },
      /no Linux\/AMD64 child/u,
    ],
    [
      "ambiguous AMD64",
      { ...validIndex, manifests: [validIndex.manifests[0], { ...validIndex.manifests[0], digest: `sha256:${"3".repeat(64)}` }] },
      /ambiguous Linux\/AMD64 children/u,
    ],
    [
      "missing children",
      { ...validIndex, manifests: [] },
      /no child manifests/u,
    ],
    [
      "missing child digest",
      { ...validIndex, manifests: [{ ...validIndex.manifests[0], digest: undefined }] },
      /child manifest digest must be/u,
    ],
  ];
  for (const [label, manifest, error] of invalidIndexes) {
    await writeFile(
      responsePath,
      JSON.stringify(ecrResponse(topDigest, indexMediaType, manifest)),
      "utf8",
    );
    const result = runFoundation([
      "verify-image-manifest",
      "--rendered", renderedPath,
      "--ecr-response", responsePath,
    ]);
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, error, label);
  }

  await writeFile(
    responsePath,
    JSON.stringify(ecrResponse(`sha256:${"9".repeat(64)}`, indexMediaType, validIndex)),
    "utf8",
  );
  const wrongDigest = runFoundation([
    "verify-image-manifest",
    "--rendered", renderedPath,
    "--ecr-response", responsePath,
  ]);
  assert.notEqual(wrongDigest.status, 0);
  assert.match(wrongDigest.stderr, /ECR image manifest digest/u);
  assert.doesNotMatch(wrongDigest.stderr, /sha256:/u);
});

test("FakeCo teardown plan is standard-only and inventories retained resources", async (t) => {
  const directory = await temporaryDirectory(t);
  const renderedPath = path.join(directory, "rendered.json");
  const environment = fakecoEnvironment("teardown");
  const render = runFoundation(
    ["render", "--phase", "teardown", "--output", renderedPath],
    environment,
  );
  assert.equal(render.status, 0, render.stderr);
  const rendered = JSON.parse(await readFile(renderedPath, "utf8")) as RenderedDeployment;
  const retention = JSON.parse(await readFile(retentionPath, "utf8")) as RetentionManifest;
  const stackPath = path.join(directory, "stack.json");
  const resourcesPath = path.join(directory, "resources.json");
  const liveTemplatePath = path.join(directory, "live-template.json");
  const planPath = path.join(directory, "plan.json");
  const template = await readFile(path.join(repositoryRoot, "deploy/aws/template.yaml"), "utf8");
  await writeFile(stackPath, JSON.stringify(stackDescription(rendered)), "utf8");
  const resourcesDocument = {
    StackResources: retention.resources.map((entry) => ({
      LogicalResourceId: entry.logicalId,
      PhysicalResourceId: `physical-${entry.logicalId}`,
      ResourceType: entry.type,
    })),
  };
  await writeFile(resourcesPath, JSON.stringify(resourcesDocument), "utf8");
  await writeFile(liveTemplatePath, JSON.stringify({ TemplateBody: template }), "utf8");

  const result = runFoundation([
    "teardown-plan",
    "--rendered", renderedPath,
    "--stack", stackPath,
    "--resources", resourcesPath,
    "--template", path.join(repositoryRoot, "deploy/aws/template.yaml"),
    "--live-template-response", liveTemplatePath,
    "--output", planPath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(await readFile(planPath, "utf8")) as {
    deletion: { mode: string; force: boolean; command: string[] };
    retentionContract: { algorithm: string; resourceCount: number; liveTemplateVerified: boolean };
    retainedResources: Array<{ logicalId: string; physicalId: string }>;
    externalPrerequisites: Array<{ kind: string; disposition: string }>;
  };
  assert.equal(plan.deletion.mode, "STANDARD");
  assert.equal(plan.deletion.force, false);
  assert.ok(plan.deletion.command.includes("STANDARD"));
  assert.equal(plan.retentionContract.algorithm, "sha256");
  assert.equal(plan.retentionContract.resourceCount, retention.resources.length);
  assert.equal(plan.retentionContract.liveTemplateVerified, true);
  assert.equal(plan.retainedResources.length, retention.resources.length);
  assert.ok(plan.retainedResources.some((entry) => entry.logicalId === "Database"));
  assert.ok(plan.externalPrerequisites.some((entry) =>
    entry.kind === "ecr-repository" && entry.disposition === "account-foundation-owned"));

  const retryStack = stackDescription(rendered);
  retryStack.Stacks[0]!.StackStatus = "DELETE_FAILED";
  await writeFile(stackPath, JSON.stringify(retryStack), "utf8");
  const retry = runFoundation([
    "teardown-plan",
    "--rendered", renderedPath,
    "--stack", stackPath,
    "--resources", resourcesPath,
    "--template", path.join(repositoryRoot, "deploy/aws/template.yaml"),
    "--live-template-response", liveTemplatePath,
    "--output", path.join(directory, "retry-plan.json"),
  ]);
  assert.equal(retry.status, 0, retry.stderr);

  const driftedTemplatePath = path.join(directory, "drifted-live-template.json");
  await writeFile(driftedTemplatePath, JSON.stringify({
    TemplateBody: template.replace(
      "  Database:\n    Type: AWS::RDS::DBInstance\n    DeletionPolicy: Snapshot",
      "  Database:\n    Type: AWS::RDS::DBInstance\n    DeletionPolicy: Delete",
    ),
  }), "utf8");
  const drifted = runFoundation([
    "teardown-plan",
    "--rendered", renderedPath,
    "--stack", stackPath,
    "--resources", resourcesPath,
    "--template", path.join(repositoryRoot, "deploy/aws/template.yaml"),
    "--live-template-response", driftedTemplatePath,
    "--output", path.join(directory, "drifted-plan.json"),
  ]);
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /live retention contract differs for Database/u);

  const extraTemplate = template.replace(
    "\nOutputs:",
    [
      "",
      "  UndeclaredRetained:",
      "    Type: AWS::S3::Bucket",
      "    DeletionPolicy: Retain",
      "    UpdateReplacePolicy: Retain",
      "    Properties: {}",
      "",
      "Outputs:",
    ].join("\n"),
  );
  const extraTemplatePath = path.join(directory, "extra-template.yaml");
  const extraLiveTemplatePath = path.join(directory, "extra-live-template.json");
  const extraResourcesPath = path.join(directory, "extra-resources.json");
  await writeFile(extraTemplatePath, extraTemplate, "utf8");
  await writeFile(
    extraLiveTemplatePath,
    JSON.stringify({ TemplateBody: extraTemplate }),
    "utf8",
  );
  await writeFile(extraResourcesPath, JSON.stringify({
    StackResources: [
      ...resourcesDocument.StackResources,
      {
        LogicalResourceId: "UndeclaredRetained",
        PhysicalResourceId: "private-unmanifested-bucket",
        ResourceType: "AWS::S3::Bucket",
      },
    ],
  }), "utf8");
  const unmanifested = runFoundation([
    "teardown-plan",
    "--rendered", renderedPath,
    "--stack", stackPath,
    "--resources", extraResourcesPath,
    "--template", extraTemplatePath,
    "--live-template-response", extraLiveTemplatePath,
    "--output", path.join(directory, "unmanifested-plan.json"),
  ]);
  assert.notEqual(unmanifested.status, 0);
  assert.match(unmanifested.stderr, /UndeclaredRetained is not declared in the manifest/u);
});

test("FakeCo workflows are manual, protected-main, isolated, pinned, and secret-read free", async () => {
  const deploy = await readFile(
    path.join(repositoryRoot, ".github/workflows/deploy-fakeco.yml"),
    "utf8",
  );
  const teardown = await readFile(
    path.join(repositoryRoot, ".github/workflows/teardown-fakeco.yml"),
    "utf8",
  );
  for (const workflow of [deploy, teardown]) {
    assert.match(workflow, /workflow_dispatch:/u);
    assert.doesNotMatch(workflow, /\n\s+(?:push|pull_request|schedule):/u);
    assert.match(workflow, /permissions:\n\s+contents: read\n\s+id-token: write/u);
    assert.match(workflow, /group: crabhelm-fakeco\n\s+cancel-in-progress: false/u);
    assert.match(workflow, /github\.ref == 'refs\/heads\/main' && github\.ref_protected/u);
    assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./u);
    assert.doesNotMatch(workflow, /get-secret-value/u);
    for (const uses of workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
      assert.match(uses[1] ?? "", /@[0-9a-f]{40}$/u);
    }
  }
  assert.match(deploy, /environment: fakeco/u);
  assert.match(deploy, /Slack ingress disabled for the initial canary/u);
  assert.match(deploy, /--parameter-overrides "\$\{parameter_overrides\[@\]\}"/u);
  assert.match(deploy, /parameter-overrides[\s\S]*>"\$parameters_file"/u);
  assert.match(deploy, /mapfile -t parameter_overrides <"\$parameters_file"/u);
  assert.doesNotMatch(deploy, /mapfile[^\n]*< <\(/u);
  assert.match(deploy, /--tags Environment=fakeco ManagedBy=github-actions Project=crabhelm/u);
  assert.match(deploy, /ecr batch-get-image/u);
  assert.ok((deploy.match(/ecr batch-get-image/gu) ?? []).length >= 2);
  assert.match(deploy, /ecr get-download-url-for-layer/u);
  assert.match(deploy, /image-manifest-kind/u);
  assert.match(deploy, /image-selected-digest/u);
  assert.match(deploy, /--child-ecr-response/u);
  assert.match(deploy, /verify-image-manifest/u);
  assert.ok(deploy.indexOf("verify-image-manifest") < deploy.indexOf("cloudformation deploy"));
  assert.match(deploy, /secret_kms_key_id="\$\(aws secretsmanager describe-secret/u);
  assert.match(deploy, /kms describe-key[\s\S]*--key-id "\$secret_kms_key_id"/u);
  assert.match(deploy, /sns get-topic-attributes/u);
  assert.ok(deploy.indexOf("sns get-topic-attributes") < deploy.indexOf("cloudformation deploy"));
  assert.match(
    deploy,
    /services\[0\]\.\[desiredCount,runningCount,pendingCount,length\(deployments\)\]/u,
  );
  for (const check of [
    '[[ "$desired_count" == "1" ]]',
    '[[ "$running_count" == "1" ]]',
    '[[ "$pending_count" == "0" ]]',
    '[[ "$deployment_count" == "1" ]]',
  ]) {
    assert.ok(deploy.includes(check));
  }
  assert.match(teardown, /environment: fakeco-teardown/u);
  assert.match(teardown, /CONFIRM_STACK_NAME: \$\{\{ inputs\.confirm_stack_name \}\}/u);
  assert.doesNotMatch(teardown, /\[\[ "\$\{\{ inputs\./u);
  assert.match(teardown, /--deletion-mode STANDARD/u);
  assert.match(teardown, /cloudformation get-template/u);
  assert.match(teardown, /--live-template-response/u);
  assert.doesNotMatch(teardown, /upload-artifact|retention-days/u);
  assert.doesNotMatch(teardown, /FORCE_DELETE_STACK|--retain-resources/u);

  const guide = await readFile(
    path.join(repositoryRoot, "deploy/aws/fakeco/README.md"),
    "utf8",
  );
  assert.match(guide, /initial `SlackMode=off` secret omits `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`/u);
  assert.match(guide, /Never use inert credentials/u);
  assert.match(guide, /later Slack canary[\s\S]*real sandbox/u);
});

test("AWS template enforces boundary, scoped IAM, digest XOR, and bounded FakeCo storage", async () => {
  const template = await readFile(path.join(repositoryRoot, "deploy/aws/template.yaml"), "utf8");
  const guide = await readFile(path.join(repositoryRoot, "deploy/aws/README.md"), "utf8");
  assert.match(template, /WorkloadPermissionsBoundaryArn:[\s\S]*WorkloadRolePath:/u);
  assert.equal((template.match(/PermissionsBoundary: !Ref WorkloadPermissionsBoundaryArn/gu) ?? []).length, 2);
  assert.equal((template.match(/Path: !Ref WorkloadRolePath/gu) ?? []).length, 2);
  assert.doesNotMatch(template, /AmazonECSTaskExecutionRolePolicy|ManagedPolicyArns:/u);
  assert.match(template, /ExistingEcrRepositoryArn:[\s\S]*ImageUri:[\s\S]*@sha256:/u);
  assert.match(template, /ImageSourceExclusive:[\s\S]*Choose exactly one image source/u);
  assert.match(template, /DatabaseStorageAutoscaling:[\s\S]*DatabaseMaxAllocatedStorage:/u);
  assert.match(template, /MaxAllocatedStorage: !If[\s\S]*EnableDatabaseStorageAutoscaling/u);
  assert.doesNotMatch(template, /MaxAllocatedStorage: 1024/u);
  assert.match(template, /BackupRetentionPeriod: !Ref DatabaseBackupRetentionDays/u);
  assert.match(template, /EnableCloudwatchLogsExports: !If[\s\S]*ExportDatabaseLogs/u);
  assert.match(template, /S3GatewayEndpoint:[\s\S]*VpcEndpointType: Gateway/u);
  assert.match(
    template,
    /arn:\$\{AWS::Partition\}:s3:::prod-\$\{AWS::Region\}-starport-layer-bucket\/\*/u,
  );
  assert.match(
    template,
    /RuntimePlatform:\n\s+CpuArchitecture: X86_64\n\s+OperatingSystemFamily: LINUX/u,
  );
  assert.match(guide, /--platform linux\/amd64/u);
  assert.match(template, /SlackMode:[\s\S]*AllowedValues: \["on", "off"\]/u);
  assert.match(template, /UseSlack: !Equals \[!Ref SlackMode, "on"\]/u);
  assert.match(template, /DisableSlack: !Equals \[!Ref SlackMode, "off"\]/u);
  assert.match(template, /Name: CRABHELM_SLACK\n\s+Value: !Ref SlackMode/u);
  assert.match(
    template,
    /- !If\n\s+- UseSlack\n\s+- Name: SLACK_BOT_TOKEN[\s\S]*- !If\n\s+- UseSlack\n\s+- Name: SLACK_SIGNING_SECRET/u,
  );
  assert.match(
    template,
    /SlackDisabledRuntimeRule:[\s\S]*Condition: DisableSlack[\s\S]*\/slack\/events[\s\S]*\/slack\/interactions/u,
  );
  assert.match(
    template,
    /ConsoleLogoutRule:[\s\S]*\/logout[\s\S]*\/signed-out[\s\S]*Priority: 1/u,
  );
  const logoutRule = template.slice(
    template.indexOf("  ConsoleLogoutRule:"),
    template.indexOf("  SlackDisabledRuntimeRule:"),
  );
  assert.doesNotMatch(logoutRule, /authenticate-oidc/u);
  assert.equal(
    (template.match(/!Sub AWSELBAuthSessionCookie-\$\{OidcClientSecretVersion\}/gu) ?? []).length,
    2,
  );

  const taskRole = template.slice(template.indexOf("  TaskRole:"), template.indexOf("  TaskDefinition:"));
  for (const action of [
    "s3:GetObject",
    "s3:PutObject",
    "s3:DeleteObject",
    "sqs:DeleteMessage",
    "sqs:ReceiveMessage",
    "sqs:SendMessage",
  ]) {
    assert.match(taskRole, new RegExp(action, "u"));
  }
  for (const unused of [
    "s3:ListBucket",
    "s3:AbortMultipartUpload",
    "s3:ListMultipartUploadParts",
    "sqs:ChangeMessageVisibility",
    "sqs:GetQueueAttributes",
    "sqs:GetQueueUrl",
  ]) {
    assert.doesNotMatch(taskRole, new RegExp(unused, "u"));
  }
});

test("retained-resource manifest matches template deletion policies", async () => {
  const template = await readFile(path.join(repositoryRoot, "deploy/aws/template.yaml"), "utf8");
  const retention = JSON.parse(await readFile(retentionPath, "utf8")) as RetentionManifest;
  for (const entry of retention.resources) {
    const start = template.indexOf(`  ${entry.logicalId}:`);
    assert.notEqual(start, -1, entry.logicalId);
    const tail = template.slice(start + 1);
    const nextResource = /\n  [A-Za-z][A-Za-z0-9]+:\n/u.exec(tail);
    const next = nextResource ? start + 1 + nextResource.index : -1;
    const block = template.slice(start, next === -1 ? undefined : next);
    assert.match(block, new RegExp(`Type: ${escapeRegex(entry.type)}`, "u"), entry.logicalId);
    assert.match(
      block,
      entry.disposition === "snapshot"
        ? /DeletionPolicy: Snapshot/u
        : /DeletionPolicy: RetainExceptOnCreate/u,
      entry.logicalId,
    );
  }
});

function runFoundation(args: string[], environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, [foundationCli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment as unknown as NodeJS.ProcessEnv,
  });
}

function fakecoEnvironment(phase: "deploy" | "teardown"): Record<string, string> {
  const digest = (character: string) => character.repeat(64);
  return {
    FAKECO_AWS_ACCOUNT_ID: "123456789012",
    FAKECO_AWS_REGION: "us-west-2",
    FAKECO_GITHUB_ROLE_ARN: `arn:aws:iam::123456789012:role/openclaw/fakeco/github/crabhelm-${phase}`,
    FAKECO_CLOUDFORMATION_SERVICE_ROLE_ARN:
      "arn:aws:iam::123456789012:role/openclaw/fakeco/cloudformation/crabhelm-service",
    FAKECO_CLOUDFORMATION_ARTIFACT_BUCKET: "openclaw-fakeco-cfn-123456789012-us-west-2",
    FAKECO_ECR_REPOSITORY_ARN:
      "arn:aws:ecr:us-west-2:123456789012:repository/openclaw/fakeco/crabhelm",
    FAKECO_IMAGE_URI:
      `123456789012.dkr.ecr.us-west-2.amazonaws.com/openclaw/fakeco/crabhelm@sha256:${digest("a")}`,
    FAKECO_WORKLOAD_PERMISSIONS_BOUNDARY_ARN:
      "arn:aws:iam::123456789012:policy/openclaw/fakeco/crabhelm-workload-boundary",
    FAKECO_CERTIFICATE_ARN:
      "arn:aws:acm:us-west-2:123456789012:certificate/11111111-2222-3333-4444-555555555555",
    FAKECO_CONSOLE_HOSTNAME: "crabhelm.fakeco.example",
    FAKECO_RUNTIME_HOSTNAME: "crabhelm-runtime.fakeco.example",
    FAKECO_OIDC_ISSUER: "https://identity.fakeco.example",
    FAKECO_OIDC_AUTHORIZATION_ENDPOINT: "https://identity.fakeco.example/oauth2/authorize",
    FAKECO_OIDC_TOKEN_ENDPOINT: "https://identity.fakeco.example/oauth2/token",
    FAKECO_OIDC_USERINFO_ENDPOINT: "https://identity.fakeco.example/oauth2/userinfo",
    FAKECO_OIDC_CLIENT_ID: "fakeco-client-id",
    FAKECO_OIDC_CLIENT_SECRET_VERSION: "1",
    FAKECO_APPLICATION_SECRET_ARN:
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:" +
      "openclaw/fakeco/crabhelm-abcdef",
    FAKECO_APPLICATION_SECRET_KMS_KEY_ARN:
      "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555",
    FAKECO_CRABBOX_URL: "https://crabbox.fakeco.example/control",
    FAKECO_CRABBOX_TARGET_ID: "fakeco",
    FAKECO_CRABBOX_TARGET_LABEL: "FakeCo disposable target",
    FAKECO_CRABBOX_TARGET_REGION: "us-west-2",
    FAKECO_ADMIN_EMAILS: "admin@fakeco.example",
    FAKECO_GITHUB_OAUTH_CLIENT_ID: "fakeco-github-client",
    FAKECO_CLAWROUTER_BASE_URL: "https://clawrouter.fakeco.example",
    FAKECO_NODE_RUNTIME_SHA256: digest("b"),
    FAKECO_APPLIANCE_ARCHIVE_SHA256: digest("c"),
    FAKECO_APPLIANCE_MANIFEST_SHA256: digest("d"),
    FAKECO_OPERATOR_ALERT_TOPIC_NAME: "crabhelm-fakeco-alerts",
  };
}

function stackDescription(rendered: RenderedDeployment) {
  return {
    Stacks: [{
      StackName: rendered.stackName,
      StackStatus: "UPDATE_COMPLETE",
      RoleARN: rendered.target.cloudFormationServiceRoleArn,
      Parameters: rendered.parameters,
      Tags: rendered.tags,
      Outputs: [
        { OutputKey: "AlbDnsName", OutputValue: "alb.example" },
        { OutputKey: "ConsoleOrigin", OutputValue: "https://crabhelm.fakeco.example" },
        { OutputKey: "RuntimeOrigin", OutputValue: "https://crabhelm-runtime.fakeco.example" },
        { OutputKey: "EcsClusterName", OutputValue: "cluster" },
        { OutputKey: "EcsServiceArn", OutputValue: "arn:aws:ecs:us-west-2:123456789012:service/test" },
        { OutputKey: "VpcId", OutputValue: "vpc-123" },
      ],
    }],
  };
}

function ecrResponse(imageDigest: string, mediaType: string, manifest: unknown) {
  return {
    failures: [],
    images: [{
      registryId: "123456789012",
      repositoryName: "openclaw/fakeco/crabhelm",
      imageId: { imageDigest },
      imageManifestMediaType: mediaType,
      imageManifest: JSON.stringify(manifest),
    }],
  };
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crabhelm-fakeco-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

type RenderedDeployment = {
  phase: "deploy" | "teardown";
  stackName: string;
  target: {
    accountId: string;
    githubRoleArn: string;
    cloudFormationServiceRoleArn: string;
    cloudFormationArtifactBucket: string;
  };
  tags: Array<{ Key: string; Value: string }>;
  parameters: Array<{ ParameterKey: string; ParameterValue: string }>;
};

type RetentionManifest = {
  resources: Array<{
    logicalId: string;
    type: string;
    disposition: "retain" | "snapshot";
  }>;
};
