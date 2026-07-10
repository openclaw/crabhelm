import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const foundationCli = path.join(repositoryRoot, "deploy/aws/fakeco/foundation.mjs");
const workflowPath = path.join(
  repositoryRoot,
  ".github/workflows/publish-fakeco-image.yml",
);
const sourceSha = "b".repeat(40);
const imageDigest = `sha256:${"a".repeat(64)}`;
const repositoryName = "openclaw/fakeco/crabhelm";
const repositoryArn =
  `arn:aws:ecr:us-west-2:123456789012:repository/${repositoryName}`;
const repositoryUri =
  `123456789012.dkr.ecr.us-west-2.amazonaws.com/${repositoryName}`;

test("FakeCo profile locks the independent image-publication identity", () => {
  const result = runFoundation(["validate-profile"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    oidcSubjects: Record<string, string>;
  };
  assert.equal(
    output.oidcSubjects.imagePublish,
    "repo:openclaw/crabhelm:environment:fakeco-image-publish",
  );
});

test("image publication render accepts only the exact non-secret target and source SHA", async (t) => {
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, "target.json");
  const result = runFoundation(
    ["render-image-publication", "--source-sha", sourceSha, "--output", output],
    publicationEnvironment(),
  );
  assert.equal(result.status, 0, result.stderr);
  const rendered = JSON.parse(await readFile(output, "utf8")) as PublicationTarget;
  assert.equal(rendered.sourceSha, sourceSha);
  assert.equal(rendered.temporaryTag, `git-${sourceSha}`);
  assert.equal(rendered.taggedImageUri, `${repositoryUri}:git-${sourceSha}`);
  assert.equal(rendered.target.githubRoleArn,
    "arn:aws:iam::123456789012:role/openclaw/fakeco/github/crabhelm-image-publish");
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(rendered), /password|secret value|access key/iu);

  const invalidCases: Array<[string, Record<string, string>, RegExp]> = [
    ["short SHA", {}, /source SHA must be an exact/u],
    [
      "deploy role reuse",
      {
        FAKECO_IMAGE_PUBLISH_ROLE_ARN:
          "arn:aws:iam::123456789012:role/openclaw/fakeco/github/crabhelm-deploy",
      },
      /FakeCo role ARN/u,
    ],
    [
      "wrong repository URI",
      {
        FAKECO_ECR_REPOSITORY_URI:
          "123456789012.dkr.ecr.us-west-2.amazonaws.com/openclaw/fakeco/openclaw",
      },
      /ECR repository URI/u,
    ],
  ];
  for (const [label, overrides, expected] of invalidCases) {
    const args = label === "short SHA"
      ? ["render-image-publication", "--source-sha", "abc", "--output", output]
      : ["render-image-publication", "--source-sha", sourceSha, "--output", output];
    const rejected = runFoundation(args, { ...publicationEnvironment(), ...overrides });
    assert.notEqual(rejected.status, 0, label);
    assert.match(rejected.stderr, expected, label);
  }
});

test("publication target requires the exact immutable repository and automatic scanning", async (t) => {
  const fixture = await prepareTarget(t, "ENHANCED", "CONTINUOUS_SCAN");
  const verified = runFoundation([
    "verify-image-publication-target",
    "--rendered", fixture.renderedPath,
    "--repository-response", fixture.repositoryPath,
    "--registry-scan-response", fixture.registryScanPath,
    "--repository-scan-response", fixture.repositoryScanPath,
    "--output", fixture.verifiedPath,
  ]);
  assert.equal(verified.status, 0, verified.stderr);
  const proof = JSON.parse(await readFile(fixture.verifiedPath, "utf8")) as {
    repositoryVerified: boolean;
    scan: { type: string; frequency: string };
  };
  assert.equal(proof.repositoryVerified, true);
  assert.deepEqual(proof.scan, { type: "ENHANCED", frequency: "CONTINUOUS_SCAN" });

  const mutable = repositoryDescription("MUTABLE");
  await writeFile(fixture.repositoryPath, JSON.stringify(mutable), "utf8");
  const mutableRejected = runFoundation([
    "verify-image-publication-target",
    "--rendered", fixture.renderedPath,
    "--repository-response", fixture.repositoryPath,
    "--registry-scan-response", fixture.registryScanPath,
    "--repository-scan-response", fixture.repositoryScanPath,
    "--output", fixture.verifiedPath,
  ]);
  assert.notEqual(mutableRejected.status, 0);
  assert.match(mutableRejected.stderr, /image tag mutability must equal "IMMUTABLE"/u);

  await writeFile(
    fixture.repositoryPath,
    JSON.stringify(repositoryDescription("IMMUTABLE")),
    "utf8",
  );
  await writeFile(
    fixture.repositoryScanPath,
    JSON.stringify(repositoryScanning("MANUAL", false)),
    "utf8",
  );
  const manualRejected = runFoundation([
    "verify-image-publication-target",
    "--rendered", fixture.renderedPath,
    "--repository-response", fixture.repositoryPath,
    "--registry-scan-response", fixture.registryScanPath,
    "--repository-scan-response", fixture.repositoryScanPath,
    "--output", fixture.verifiedPath,
  ]);
  assert.notEqual(manualRejected.status, 0);
  assert.match(manualRejected.stderr, /scan-on-push setting/u);
});

test("publication binds the BuildKit digest to the immutable ECR tag", async (t) => {
  const fixture = await preparePublication(t);
  const publication = JSON.parse(await readFile(fixture.publicationPath, "utf8")) as {
    imageDigest: string;
    imageUri: string;
    temporaryTag: string;
  };
  assert.equal(publication.imageDigest, imageDigest);
  assert.equal(publication.imageUri, `${repositoryUri}@${imageDigest}`);
  assert.equal(publication.temporaryTag, `git-${sourceSha}`);

  await writeFile(
    fixture.ecrImagePath,
    JSON.stringify(ecrImageDescription(`sha256:${"c".repeat(64)}`)),
    "utf8",
  );
  const rejected = runFoundation([
    "finalize-image-publication",
    "--target", fixture.verifiedPath,
    "--build-metadata", fixture.buildMetadataPath,
    "--ecr-image", fixture.ecrImagePath,
    "--output", path.join(fixture.directory, "rejected.json"),
  ]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /BuildKit and ECR image digest/u);
  assert.doesNotMatch(rejected.stderr, /sha256:/u);
});

test("published artifacts reuse the canonical Linux AMD64 manifest verifier", async (t) => {
  const fixture = await preparePublication(t);
  const configBytes = JSON.stringify({ os: "linux", architecture: "amd64" });
  const configDigest = `sha256:${createHash("sha256").update(configBytes).digest("hex")}`;
  const manifestMediaType = "application/vnd.oci.image.manifest.v1+json";
  const manifestPath = path.join(fixture.directory, "manifest.json");
  const configPath = path.join(fixture.directory, "config.json");
  const platformPath = path.join(fixture.directory, "platform.json");
  await writeFile(manifestPath, JSON.stringify(ecrManifestResponse(
    imageDigest,
    manifestMediaType,
    {
      schemaVersion: 2,
      mediaType: manifestMediaType,
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: configBytes.length,
      },
      layers: [],
    },
  )), "utf8");
  await writeFile(configPath, configBytes, "utf8");
  const verified = runFoundation([
    "verify-image-manifest",
    "--rendered", fixture.publicationPath,
    "--ecr-response", manifestPath,
    "--config", configPath,
    "--output", platformPath,
  ]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(await readFile(platformPath, "utf8")), {
    ok: true,
    kind: "single",
    os: "linux",
    architecture: "amd64",
    imageDigest,
  });

  const armBytes = JSON.stringify({ os: "linux", architecture: "arm64" });
  const armDigest = `sha256:${createHash("sha256").update(armBytes).digest("hex")}`;
  await writeFile(manifestPath, JSON.stringify(ecrManifestResponse(
    imageDigest,
    manifestMediaType,
    {
      schemaVersion: 2,
      mediaType: manifestMediaType,
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: armDigest,
        size: armBytes.length,
      },
      layers: [],
    },
  )), "utf8");
  await writeFile(configPath, armBytes, "utf8");
  const armRejected = runFoundation([
    "verify-image-manifest",
    "--rendered", fixture.publicationPath,
    "--ecr-response", manifestPath,
    "--config", configPath,
  ]);
  assert.notEqual(armRejected.status, 0);
  assert.match(armRejected.stderr, /os=linux and architecture=amd64/u);
});

test("image scan waits for readiness and emits only thresholded metadata", async (t) => {
  const fixture = await preparePublication(t);
  const platformPath = path.join(fixture.directory, "platform.json");
  const findingsPath = path.join(fixture.directory, "findings.json");
  const finalPath = path.join(fixture.directory, "final.json");
  await writeFile(platformPath, JSON.stringify({
    ok: true,
    kind: "single",
    os: "linux",
    architecture: "amd64",
    imageDigest,
  }), "utf8");
  await writeFile(findingsPath, JSON.stringify(scanFindings("IN_PROGRESS", {})), "utf8");
  const pending = runFoundation([
    "image-scan-state",
    "--publication", fixture.publicationPath,
    "--scan-digest", imageDigest,
    "--scan-findings", findingsPath,
  ]);
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(pending.stdout, "pending");

  await writeFile(findingsPath, JSON.stringify(scanFindings("ACTIVE", {
    HIGH: 2,
    MEDIUM: 3,
  })), "utf8");
  const ready = runFoundation([
    "image-scan-state",
    "--publication", fixture.publicationPath,
    "--scan-digest", imageDigest,
    "--scan-findings", findingsPath,
  ]);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.stdout, "ready");
  const finalized = runFoundation([
    "finalize-image-scan",
    "--publication", fixture.publicationPath,
    "--platform-proof", platformPath,
    "--scan-digest", imageDigest,
    "--scan-findings", findingsPath,
    "--output", finalPath,
  ]);
  assert.equal(finalized.status, 0, finalized.stderr);
  const artifact = JSON.parse(await readFile(finalPath, "utf8")) as {
    kind: string;
    imageUri: string;
    scan: {
      threshold: { maximumCriticalFindings: number };
      findingSeverityCounts: Record<string, number>;
    };
  };
  assert.equal(artifact.kind, "fakeco-crabhelm-control-plane-image");
  assert.equal(artifact.imageUri, `${repositoryUri}@${imageDigest}`);
  assert.equal(artifact.scan.threshold.maximumCriticalFindings, 0);
  assert.equal(artifact.scan.findingSeverityCounts.CRITICAL, 0);
  assert.equal(artifact.scan.findingSeverityCounts.HIGH, 2);
  assert.doesNotMatch(JSON.stringify(artifact), /description|findingArn|packageVulnerability/iu);
  const summary = runFoundation([
    "image-publication-summary",
    "--publication", finalPath,
  ]);
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Digest-bound image/u);
  assert.match(summary.stdout, /manually set `FAKECO_IMAGE_URI`/u);

  await writeFile(findingsPath, JSON.stringify(scanFindings("ACTIVE", {
    CRITICAL: 1,
  })), "utf8");
  const criticalRejected = runFoundation([
    "finalize-image-scan",
    "--publication", fixture.publicationPath,
    "--platform-proof", platformPath,
    "--scan-digest", imageDigest,
    "--scan-findings", findingsPath,
    "--output", finalPath,
  ]);
  assert.notEqual(criticalRejected.status, 0);
  assert.match(criticalRejected.stderr, /1 CRITICAL findings; maximum is 0/u);
});

test("basic scanning requires COMPLETE while enhanced scanning accepts ACTIVE", async (t) => {
  const fixture = await preparePublication(t, "BASIC", "SCAN_ON_PUSH");
  const findingsPath = path.join(fixture.directory, "basic-findings.json");
  await writeFile(findingsPath, JSON.stringify(scanFindings("ACTIVE", {})), "utf8");
  const activeRejected = runFoundation([
    "image-scan-state",
    "--publication", fixture.publicationPath,
    "--scan-digest", imageDigest,
    "--scan-findings", findingsPath,
  ]);
  assert.notEqual(activeRejected.status, 0);
  assert.match(activeRejected.stderr, /non-ready terminal status/u);

  await writeFile(findingsPath, JSON.stringify(scanFindings("COMPLETE", {})), "utf8");
  const complete = runFoundation([
    "image-scan-state",
    "--publication", fixture.publicationPath,
    "--scan-digest", imageDigest,
    "--scan-findings", findingsPath,
  ]);
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(complete.stdout, "ready");
});

test("publication workflow is manual, isolated, pinned, and mutation bounded", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+source_sha:/u);
  assert.doesNotMatch(workflow, /\n\s+(?:push|pull_request|schedule):/u);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+id-token: write/u);
  assert.match(workflow, /group: crabhelm-fakeco-image-publish\n\s+cancel-in-progress: false/u);
  assert.match(workflow, /environment: fakeco-image-publish/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main' && github\.ref_protected/u);
  assert.match(workflow, /GITHUB_REF_PROTECTED/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$SOURCE_SHA" "\$GITHUB_SHA"/u);
  assert.match(workflow, /git archive --format=tar "\$SOURCE_SHA"/u);
  assert.match(workflow, /FAKECO_IMAGE_PUBLISH_ROLE_ARN/u);
  assert.doesNotMatch(workflow, /FAKECO_GITHUB_ROLE_ARN/u);
  assert.match(workflow, /uname -m[\s\S]*x86_64/u);
  assert.match(workflow, /--platform linux\/amd64/u);
  assert.match(workflow, /--file "\$RUNNER_TEMP\/fakeco-source\/Dockerfile\.aws"/u);
  assert.match(workflow, /--sbom=true/u);
  assert.match(workflow, /--provenance=mode=max/u);
  assert.match(workflow, /--metadata-file/u);
  assert.match(workflow, /--tag "\$\{FAKECO_ECR_REPOSITORY_URI\}:git-\$\{SOURCE_SHA\}"/u);
  assert.match(workflow, /finalize-image-publication/u);
  assert.match(workflow, /verify-image-manifest/u);
  assert.match(workflow, /describe-image-scan-findings/u);
  assert.match(workflow, /finalize-image-scan/u);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /fakeco-crabhelm-image-\$\{\{ inputs\.source_sha \}\}/u);
  assert.doesNotMatch(workflow, /setup-qemu|docker\.io|ghcr\.io/u);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/u);
  assert.doesNotMatch(workflow, /get-secret-value|ssm get-parameter|secretsmanager/u);
  assert.doesNotMatch(
    workflow,
    /create-repository|delete-repository|batch-delete-image|put-registry-scanning-configuration/u,
  );
  assert.doesNotMatch(workflow, /github-script|gh (?:api|variable|secret)|environments\//u);
  for (const uses of workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
    assert.match(uses[1] ?? "", /@[0-9a-f]{40}$/u);
  }
});

test("account-foundation docs lock OIDC claims and separate artifact owners", async () => {
  const guide = await readFile(
    path.join(repositoryRoot, "deploy/aws/fakeco/README.md"),
    "utf8",
  );
  for (const exactClaim of [
    '"token.actions.githubusercontent.com:aud": "sts.amazonaws.com"',
    '"token.actions.githubusercontent.com:sub": "repo:openclaw/crabhelm:environment:fakeco-image-publish"',
    '"token.actions.githubusercontent.com:environment": "fakeco-image-publish"',
    '"token.actions.githubusercontent.com:ref": "refs/heads/main"',
    '"token.actions.githubusercontent.com:repository": "openclaw/crabhelm"',
    '"token.actions.githubusercontent.com:repository_id": "<verified-repository-id>"',
    '"token.actions.githubusercontent.com:repository_owner_id": "<verified-owner-id>"',
  ]) {
    assert.ok(guide.includes(exactClaim), exactClaim);
  }
  assert.match(guide, /StringEquals`, never `StringLike/u);
  assert.match(guide, /July 15, 2026/u);
  assert.match(guide, /Do not trust a release-tag family/u);
  assert.match(guide, /Bind one observed format[\s\S]*never add both subject formats/u);
  assert.match(guide, /OpenClaw standalone\/Gateway OCI images have their own publisher/u);
  assert.match(guide, /FAKECO_NODE_RUNTIME_SHA256/u);
  assert.match(guide, /FAKECO_APPLIANCE_ARCHIVE_SHA256/u);
  assert.match(guide, /FAKECO_APPLIANCE_MANIFEST_SHA256/u);
  assert.match(guide, /Crabhelm ECS control-plane image/u);
});

async function prepareTarget(
  t: TestContext,
  scanType: "BASIC" | "ENHANCED",
  frequency: "SCAN_ON_PUSH" | "CONTINUOUS_SCAN",
) {
  const directory = await temporaryDirectory(t);
  const renderedPath = path.join(directory, "target.json");
  const repositoryPath = path.join(directory, "repository.json");
  const registryScanPath = path.join(directory, "registry-scan.json");
  const repositoryScanPath = path.join(directory, "repository-scan.json");
  const verifiedPath = path.join(directory, "verified.json");
  const rendered = runFoundation(
    ["render-image-publication", "--source-sha", sourceSha, "--output", renderedPath],
    publicationEnvironment(),
  );
  assert.equal(rendered.status, 0, rendered.stderr);
  await writeFile(
    repositoryPath,
    JSON.stringify(repositoryDescription("IMMUTABLE")),
    "utf8",
  );
  await writeFile(registryScanPath, JSON.stringify({ scanType }), "utf8");
  await writeFile(
    repositoryScanPath,
    JSON.stringify(repositoryScanning(frequency, true)),
    "utf8",
  );
  return {
    directory,
    renderedPath,
    repositoryPath,
    registryScanPath,
    repositoryScanPath,
    verifiedPath,
  };
}

async function preparePublication(
  t: TestContext,
  scanType: "BASIC" | "ENHANCED" = "ENHANCED",
  frequency: "SCAN_ON_PUSH" | "CONTINUOUS_SCAN" = "CONTINUOUS_SCAN",
) {
  const fixture = await prepareTarget(t, scanType, frequency);
  const target = runFoundation([
    "verify-image-publication-target",
    "--rendered", fixture.renderedPath,
    "--repository-response", fixture.repositoryPath,
    "--registry-scan-response", fixture.registryScanPath,
    "--repository-scan-response", fixture.repositoryScanPath,
    "--output", fixture.verifiedPath,
  ]);
  assert.equal(target.status, 0, target.stderr);
  const buildMetadataPath = path.join(fixture.directory, "build-metadata.json");
  const ecrImagePath = path.join(fixture.directory, "ecr-image.json");
  const publicationPath = path.join(fixture.directory, "publication.json");
  await writeFile(
    buildMetadataPath,
    JSON.stringify({ "containerimage.digest": imageDigest }),
    "utf8",
  );
  await writeFile(ecrImagePath, JSON.stringify(ecrImageDescription(imageDigest)), "utf8");
  const finalized = runFoundation([
    "finalize-image-publication",
    "--target", fixture.verifiedPath,
    "--build-metadata", buildMetadataPath,
    "--ecr-image", ecrImagePath,
    "--output", publicationPath,
  ]);
  assert.equal(finalized.status, 0, finalized.stderr);
  return {
    ...fixture,
    buildMetadataPath,
    ecrImagePath,
    publicationPath,
  };
}

function publicationEnvironment(): Record<string, string> {
  return {
    FAKECO_AWS_ACCOUNT_ID: "123456789012",
    FAKECO_AWS_REGION: "us-west-2",
    FAKECO_IMAGE_PUBLISH_ROLE_ARN:
      "arn:aws:iam::123456789012:role/openclaw/fakeco/github/crabhelm-image-publish",
    FAKECO_ECR_REPOSITORY_ARN: repositoryArn,
    FAKECO_ECR_REPOSITORY_URI: repositoryUri,
  };
}

function repositoryDescription(mutability: string) {
  return {
    repositories: [{
      registryId: "123456789012",
      repositoryArn,
      repositoryName,
      repositoryUri,
      imageTagMutability: mutability,
    }],
  };
}

function repositoryScanning(frequency: string, scanOnPush: boolean) {
  return {
    failures: [],
    scanningConfigurations: [{
      repositoryArn,
      repositoryName,
      scanOnPush,
      scanFrequency: frequency,
    }],
  };
}

function ecrImageDescription(digest: string) {
  return {
    imageDetails: [{
      registryId: "123456789012",
      repositoryName,
      imageDigest: digest,
      imageTags: [`git-${sourceSha}`],
    }],
  };
}

function ecrManifestResponse(digest: string, mediaType: string, manifest: unknown) {
  return {
    failures: [],
    images: [{
      registryId: "123456789012",
      repositoryName,
      imageId: { imageDigest: digest },
      imageManifestMediaType: mediaType,
      imageManifest: JSON.stringify(manifest),
    }],
  };
}

function scanFindings(status: string, counts: Record<string, number>) {
  return {
    registryId: "123456789012",
    repositoryName,
    imageId: { imageDigest },
    imageScanStatus: { status },
    ...(status === "IN_PROGRESS" ? {} : {
      imageScanFindings: {
        imageScanCompletedAt: "2026-07-10T06:30:00.000Z",
        findingSeverityCounts: counts,
      },
    }),
  };
}

function runFoundation(args: string[], environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, [foundationCli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment as unknown as NodeJS.ProcessEnv,
  });
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crabhelm-image-publish-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

type PublicationTarget = {
  sourceSha: string;
  temporaryTag: string;
  taggedImageUri: string;
  target: { githubRoleArn: string };
};
