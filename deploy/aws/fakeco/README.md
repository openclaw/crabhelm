# FakeCo AWS foundation

This profile deploys one disposable Crabhelm installation into one pre-existing AWS account. It locks the cost and identity-sensitive choices while keeping account foundation, secrets, DNS, and image publication resources outside the application stack.

Nothing in this directory creates an AWS account, organization unit, IAM Identity Center assignment, SCP, GitHub OIDC provider, GitHub Environment, IAM boundary, deployment role, CloudFormation service role, ECR repository, CloudFormation artifact bucket, application secret, KMS key, ACM certificate, DNS record, budget, or anomaly monitor.

## Locked contract

[`profile.json`](profile.json) fixes:

- stack `crabhelm-fakeco` in the account and Region named by the profile inputs;
- GitHub Environments `fakeco`, `fakeco-teardown`, and `fakeco-image-publish`;
- exact OIDC subjects `repo:openclaw/crabhelm:environment:fakeco`, `repo:openclaw/crabhelm:environment:fakeco-teardown`, and `repo:openclaw/crabhelm:environment:fakeco-image-publish`;
- one shared concurrency group, `crabhelm-fakeco`, with in-progress runs never cancelled;
- an independent non-cancelling image-publication group, `crabhelm-fakeco-image-publish`;
- protected `main` as the only accepted workflow ref;
- external ECR only, using `openclaw/fakeco/crabhelm@sha256:<digest>` from the target account and Region;
- Linux/AMD64 image compatibility before stack mutation: a single manifest must declare `os=linux` and `architecture=amd64`, while an image index must contain exactly one Linux/AMD64 descriptor whose resolved child config proves the same platform;
- `CreateEcrRepository=false` and `ProvisionService=true`; the billable `ProvisionService=false` bootstrap is invalid for FakeCo;
- workload roles under `/openclaw/fakeco/crabhelm/`, both using the required account-owned permissions boundary;
- one ECS task, one NAT gateway, single-AZ RDS, 20 GiB RDS with storage autoscaling disabled, one-day automated backups, RDS log export disabled, and seven-day ECS log retention;
- metadata-only Prometheus enabled, ClawRouter enabled with retention controlled by the application contract, and no direct provider credential;
- Slack disabled for the first canary, with no Slack secret injection and both Slack ingress paths closed;
- stack tags `Project=crabhelm`, `Environment=fakeco`, and `ManagedBy=github-actions`.

The S3 gateway endpoint keeps application S3 traffic and regional ECR image-layer downloads off the NAT gateway at no endpoint-hour charge. Its least-privilege policy includes the AWS-owned `prod-<region>-starport-layer-bucket` required for private ECR pulls. Other external HTTPS traffic still uses the single NAT gateway in public subnet A. This is explicitly non-HA: an Availability Zone or NAT failure can interrupt task egress even though the ALB spans two public subnets.

## Account-foundation prerequisites

Create and review these outside this repository before enabling any workflow:

1. A dedicated member account and its organization, Identity Center, SCP, and budget/anomaly controls.
2. The GitHub OIDC provider with audience `sts.amazonaws.com`.
3. Separate GitHub roles:
   - `arn:aws:iam::<account>:role/openclaw/fakeco/github/crabhelm-deploy`, trusted only for `repo:openclaw/crabhelm:environment:fakeco`;
   - `arn:aws:iam::<account>:role/openclaw/fakeco/github/crabhelm-teardown`, trusted only for `repo:openclaw/crabhelm:environment:fakeco-teardown`;
   - `arn:aws:iam::<account>:role/openclaw/fakeco/github/crabhelm-image-publish`, trusted only for `repo:openclaw/crabhelm:environment:fakeco-image-publish` and never reused for deployment.
4. `arn:aws:iam::<account>:role/openclaw/fakeco/cloudformation/crabhelm-service`, the only CloudFormation service role either deployment GitHub role may pass; the image-publication role cannot pass it.
5. `arn:aws:iam::<account>:policy/openclaw/fakeco/crabhelm-workload-boundary`, which permits only the reviewed ECS workload role envelope.
6. Private, encrypted, versioned S3 bucket `openclaw-fakeco-cfn-<account>-<region>` for non-secret CloudFormation templates. The deploy role needs access only to `crabhelm/fakeco/cloudformation/*`.
7. Immutable ECR repository `openclaw/fakeco/crabhelm` covered by BASIC scan-on-push or ENHANCED scan-on-push/continuous scanning. It starts empty; the repository-owned manual publisher produces the reviewed Linux/AMD64 image before deployment.
8. The application secret encrypted by the named customer-managed KMS key. The initial `SlackMode=off` secret omits `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`; do not create placeholder values. The workflow receives only the secret and key ARNs, resolves the secret's KMS identifier to its canonical ARN with `DescribeSecret`/`DescribeKey`, and never reads a secret value.
9. ACM certificate, external DNS, ALB OIDC client, Crabbox target, ClawRouter installation, an existing audit-alert SNS topic, and a digest-pinned post-overlay OpenClaw appliance.

### Image-publisher OIDC trust

The image-publication role trust must use `StringEquals`, never `StringLike`, for the live GitHub token claims. For the repository's current name-based subject format, the required conditions are:

```json
{
  "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
  "token.actions.githubusercontent.com:sub": "repo:openclaw/crabhelm:environment:fakeco-image-publish",
  "token.actions.githubusercontent.com:environment": "fakeco-image-publish",
  "token.actions.githubusercontent.com:ref": "refs/heads/main",
  "token.actions.githubusercontent.com:repository": "openclaw/crabhelm",
  "token.actions.githubusercontent.com:repository_id": "<verified-repository-id>",
  "token.actions.githubusercontent.com:repository_owner_id": "<verified-owner-id>"
}
```

The `ref` condition is separate because an environment-based `sub` does not encode the branch. Do not trust a release-tag family, wildcard ref, repository-name family, or both old and new subject formats.

GitHub's immutable-subject transition begins July 15, 2026 for newly created repositories and later renames/transfers; existing repositories can opt in earlier. Before creating this role, use an approved protected claim-inspection run or GitHub's OIDC preview to observe the exact live `sub`, `repository_id`, `repository_owner_id`, `ref`, `environment`, and `aud` emitted for this job. If the live subject is already immutable, replace only the `sub` value above with exactly `repo:openclaw@<verified-owner-id>/crabhelm@<verified-repository-id>:environment:fakeco-image-publish`. Bind one observed format and the observed immutable ID claims; never add both subject formats as alternatives. Do not persist or print the signed JWT itself. See GitHub's [OIDC claim reference](https://docs.github.com/en/actions/reference/security/oidc) and AWS's [GitHub OIDC condition-key mapping](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html).

The deploy GitHub role needs only OIDC session admission, metadata reads for the named prerequisites (including `sns:GetTopicAttributes` on the exact alert topic), `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` on the exact repository, writes to the exact CloudFormation artifact-bucket prefix, CloudFormation change-set/stack operations for `crabhelm-fakeco`, and `iam:PassRole` for the exact CloudFormation service role. The teardown role needs stack/resource reads including `cloudformation:GetTemplate`, standard stack deletion, and the same exact `iam:PassRole`; it does not need create/update permissions. The CloudFormation service role owns stack mutation and must constrain workload IAM creation to the fixed path and require the named permissions boundary.

The image-publication role has no CloudFormation, IAM, S3, Secrets Manager, Systems Manager, or GitHub Environment permissions. It needs `ecr:GetAuthorizationToken`; repository and scan metadata reads (`DescribeRepositories`, `DescribeImages`, `BatchGetImage`, `GetDownloadUrlForLayer`, `GetRegistryScanningConfiguration`, `BatchGetRepositoryScanningConfiguration`, and `DescribeImageScanFindings`); and the exact-repository layer/image upload actions (`BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, and `PutImage`). It cannot create or delete a repository, change scan settings, delete an image/tag, or write any other registry.

The application secret format remains the one documented in the parent [AWS guide](../README.md). Secret values never belong in GitHub variables, workflow inputs, rendered parameter files, stack parameters, logs, or teardown artifacts.

## GitHub Environment contract

Create three protected Environments only after account foundation review:

- `fakeco`: protected branch `main`, required reviewers as appropriate, `FAKECO_GITHUB_ROLE_ARN` set to the deploy role;
- `fakeco-teardown`: protected branch `main`, separate required approval, `FAKECO_GITHUB_ROLE_ARN` set to the teardown role;
- `fakeco-image-publish`: protected branch `main`, separate required approval, `FAKECO_IMAGE_PUBLISH_ROLE_ARN` set only to the dedicated image-publication role.

The deploy and teardown Environments use variables—not GitHub secrets—for these non-secret names, ARNs, IDs, URLs, hosts, and digests:

```text
FAKECO_AWS_ACCOUNT_ID
FAKECO_AWS_REGION
FAKECO_GITHUB_ROLE_ARN
FAKECO_CLOUDFORMATION_SERVICE_ROLE_ARN
FAKECO_CLOUDFORMATION_ARTIFACT_BUCKET
FAKECO_ECR_REPOSITORY_ARN
FAKECO_IMAGE_URI
FAKECO_WORKLOAD_PERMISSIONS_BOUNDARY_ARN
FAKECO_CERTIFICATE_ARN
FAKECO_CONSOLE_HOSTNAME
FAKECO_RUNTIME_HOSTNAME
FAKECO_OIDC_ISSUER
FAKECO_OIDC_AUTHORIZATION_ENDPOINT
FAKECO_OIDC_TOKEN_ENDPOINT
FAKECO_OIDC_USERINFO_ENDPOINT
FAKECO_OIDC_CLIENT_ID
FAKECO_OIDC_CLIENT_SECRET_VERSION
FAKECO_APPLICATION_SECRET_ARN
FAKECO_APPLICATION_SECRET_KMS_KEY_ARN
FAKECO_CRABBOX_URL
FAKECO_CRABBOX_TARGET_ID
FAKECO_CRABBOX_TARGET_LABEL
FAKECO_CRABBOX_TARGET_REGION
FAKECO_ADMIN_EMAILS
FAKECO_GITHUB_OAUTH_CLIENT_ID
FAKECO_CLAWROUTER_BASE_URL
FAKECO_NODE_RUNTIME_SHA256
FAKECO_APPLIANCE_ARCHIVE_SHA256
FAKECO_APPLIANCE_MANIFEST_SHA256
FAKECO_OPERATOR_ALERT_TOPIC_NAME
```

The image-publication Environment has a smaller variable surface and shares no deploy-role variable:

```text
FAKECO_AWS_ACCOUNT_ID
FAKECO_AWS_REGION
FAKECO_IMAGE_PUBLISH_ROLE_ARN
FAKECO_ECR_REPOSITORY_ARN
FAKECO_ECR_REPOSITORY_URI
```

The validator requires every ARN and the ECR image URI to match the selected account and Region. It rejects the production ClawRouter origin, wildcard/broad role paths, tagged images, missing inputs, cross-target resources, ARM-only images, missing platform evidence, and ambiguous image indexes. ARM64 migration is outside this profile.

## Local validation and rendering

Profile validation is offline:

```bash
pnpm aws:fakeco:validate
```

With the exact non-secret variables above loaded from an approved local source, render and verify the deployment parameters:

```bash
node deploy/aws/fakeco/foundation.mjs render \
  --phase deploy \
  --output deploy/aws/fakeco/deploy-rendered.json
node deploy/aws/fakeco/foundation.mjs verify \
  --rendered deploy/aws/fakeco/deploy-rendered.json
```

Rendered files are mode `0600` and ignored by Git. They contain application-secret and KMS ARNs, never secret values. `parameter-overrides` emits one shell-safe `Key=Value` line per validated parameter for the workflow's Bash array.

## Manual Crabhelm control-plane image publication

[`publish-fakeco-image.yml`](../../../.github/workflows/publish-fakeco-image.yml) is the only repository-owned FakeCo publisher. It is `workflow_dispatch` only, runs from protected current `main`, uses the independently approved `fakeco-image-publish` Environment, and accepts one exact lowercase 40-character source commit. A full checkout proves that commit is an ancestor of the current `main`; `git archive` creates the exact build context without switching the validator away from current policy.

The job runs natively on an x86_64 GitHub-hosted runner and builds only [`Dockerfile.aws`](../../../Dockerfile.aws) for `linux/amd64`. BuildKit pushes SBOM and maximum-provenance attestations under the commit-derived immutable staging tag `git-<source-sha>`. The role authenticates with GitHub OIDC and an ephemeral ECR login token; there is no static AWS key, secret read, repository creation/deletion, scan-configuration mutation, tag deletion, deploy-role reuse, or public-registry push.

Before upload, the workflow verifies the caller account, exact repository ARN/URI/name, strict `IMMUTABLE` tag policy, and BASIC scan-on-push or ENHANCED scan-on-push/continuous coverage. After upload it:

1. compares BuildKit's pushed digest with ECR's digest for the exact commit tag;
2. resolves the digest through the existing FakeCo manifest owner;
3. accepts one exact Linux/AMD64 image, or one Linux/AMD64 child in an attestation-bearing OCI index, only after the digest-bound child config also reports `linux`/`amd64`;
4. polls the selected runnable image digest for BASIC `COMPLETE` or ENHANCED `ACTIVE`/`COMPLETE` plus a completion timestamp;
5. blocks publication when `CRITICAL > 0`, while reporting HIGH and lower aggregate counts for operator review.

The workflow uploads one seven-day, non-secret `fakeco-crabhelm-image-<source-sha>` JSON artifact and writes its digest-bound ECR URI to the run summary. The artifact contains source/digest/platform/scan metadata only—no package findings, descriptions, credentials, or signed tokens. An operator reviews it and manually copies `imageUri` into `FAKECO_IMAGE_URI` in the separately protected `fakeco` Environment. The publisher never mutates that Environment. Because the repository is immutable, reusing an already-published commit tag fails rather than overwriting it.

Artifact ownership is intentionally disjoint:

- this workflow publishes the Crabhelm ECS control-plane image in `openclaw/fakeco/crabhelm`;
- OpenClaw standalone/Gateway OCI images have their own publisher and repository and are never pushed here;
- Crabbox's x86_64 Gateway appliance is a private archive identified by `FAKECO_NODE_RUNTIME_SHA256`, `FAKECO_APPLIANCE_ARCHIVE_SHA256`, and `FAKECO_APPLIANCE_MANIFEST_SHA256`; this workflow neither builds nor uploads that digest triple.

## Manual deployment

[`deploy-fakeco.yml`](../../../.github/workflows/deploy-fakeco.yml) is `workflow_dispatch` only. It refuses non-protected or non-`main` refs, renders before requesting AWS credentials, and checks the caller account and exact prerequisite identities, including the alert topic and the application secret's canonical KMS-key binding. Before CloudFormation, it reads the selected ECR manifest. For a single image it downloads only the referenced, digest-verified config blob and accepts exact `linux`/`amd64`; for an OCI or Docker index it requires exactly one Linux/AMD64 descriptor, fetches that digest-bound child manifest, and verifies the child's digest-bound config reports the same platform. The presigned config URL and config document are temporary, never uploaded or printed, and no image layer is pulled. It then performs one CloudFormation deployment with:

- `CAPABILITY_IAM`;
- the exact CloudFormation service-role ARN;
- the account-owned template bucket/prefix;
- the locked parameters and tags;
- no stack-owned ECR or `ProvisionService=false` stage.

After deployment it verifies observed parameters, tags, service role, outputs, exactly one desired/running ECS task with no pending task or second deployment, and runtime `/healthz`. It does not create DNS, upload an appliance, seed secrets, or prove routed inference; those remain explicit installation steps.

### Enabling Slack after the first canary

Keep Slack off until console authentication, logout, ClawRouter inference, lifecycle, diagnostics, and metadata-only usage are live-proven. A later Slack canary requires a separate reviewed profile change from locked `SlackMode=off` to `on`, real sandbox `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` values in the existing application secret, and the two runtime-host Slack callback URLs configured in that sandbox app. Redeploy the stack and require `/api/state` to report Slack configured before sending a signed test event. Never use inert credentials merely to satisfy deployment configuration.

## Manual teardown

[`teardown-fakeco.yml`](../../../.github/workflows/teardown-fakeco.yml) requires the literal stack name `crabhelm-fakeco`, the separately protected `fakeco-teardown` Environment, and the same concurrency lock as deployment. Immediately before deletion it verifies the live stack against the locked profile, fetches the live original template, and cryptographically compares every retained resource block with the reviewed template and [`retained-resources.json`](retained-resources.json). The instantiated live template's retained-resource logical IDs must exactly match that manifest; conditional retained resources that were never created are ignored. A retention-policy or retained-resource drift stops deletion. If a reviewed template changes a retained block, deploy that template successfully before teardown.

Deletion uses only:

```text
cloudformation:DeleteStack
deletion mode STANDARD
```

There is no force-delete fallback and no `--retain-resources` override. A stack in `DELETE_FAILED` can retry the same standard deletion after the external cause is corrected; deploy verification remains stricter. If deletion protection or profile drift is observed, the workflow stops; restore the reviewed locked profile before retrying.

Standard stack deletion deliberately leaves or creates:

- the final RDS snapshot and retained database credential;
- appliance, encrypted OAuth-vault, and audit buckets plus their deny-insecure-transport policies;
- source and dead-letter audit queues;
- the seven-day ECS log group.

The plan records their logical and physical IDs before deletion. Because that inventory contains private deployment metadata, the workflow keeps it in mode-`0600` runner-temporary storage and never uploads or prints it; an operator can generate the same plan locally through the documented CLI when an approved private copy is required. External ECR, template bucket, IAM/OIDC resources, boundary, service role, application secret/KMS key, ACM/DNS, budgets, and anomaly monitoring are account-foundation-owned and untouched. Retained-data disposal, legal retention decisions, account closure, and data-deletion requests are outside this repository.
