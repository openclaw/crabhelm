# FakeCo AWS foundation

This profile deploys one disposable Crabhelm installation into one pre-existing AWS account. It locks the cost and identity-sensitive choices while keeping account foundation, secrets, DNS, and image publication outside the application stack.

Nothing in this directory creates an AWS account, organization unit, IAM Identity Center assignment, SCP, GitHub OIDC provider, GitHub Environment, IAM boundary, deployment role, CloudFormation service role, ECR repository, CloudFormation artifact bucket, application secret, KMS key, ACM certificate, DNS record, budget, or anomaly monitor.

## Locked contract

[`profile.json`](profile.json) fixes:

- stack `crabhelm-fakeco` in the account and Region named by the profile inputs;
- GitHub Environments `fakeco` and `fakeco-teardown`;
- OIDC subjects `repo:openclaw/crabhelm:environment:fakeco` and `repo:openclaw/crabhelm:environment:fakeco-teardown`;
- one shared concurrency group, `crabhelm-fakeco`, with in-progress runs never cancelled;
- protected `main` as the only accepted workflow ref;
- external ECR only, using `openclaw/fakeco/crabhelm@sha256:<digest>` from the target account and Region;
- `CreateEcrRepository=false` and `ProvisionService=true`; the billable `ProvisionService=false` bootstrap is invalid for FakeCo;
- workload roles under `/openclaw/fakeco/crabhelm/`, both using the required account-owned permissions boundary;
- one ECS task, one NAT gateway, single-AZ RDS, 20 GiB RDS with storage autoscaling disabled, one-day automated backups, RDS log export disabled, and seven-day ECS log retention;
- metadata-only Prometheus enabled, ClawRouter enabled with retention controlled by the application contract, and no direct provider credential;
- stack tags `Project=crabhelm`, `Environment=fakeco`, and `ManagedBy=github-actions`.

The S3 gateway endpoint keeps application S3 traffic off the NAT gateway at no endpoint-hour charge. Other external HTTPS traffic still uses the single NAT gateway in public subnet A. This is explicitly non-HA: an Availability Zone or NAT failure can interrupt task egress even though the ALB spans two public subnets.

## Account-foundation prerequisites

Create and review these outside this repository before enabling either workflow:

1. A dedicated member account and its organization, Identity Center, SCP, and budget/anomaly controls.
2. The GitHub OIDC provider with audience `sts.amazonaws.com`.
3. Separate GitHub roles:
   - `arn:aws:iam::<account>:role/openclaw/fakeco/github/crabhelm-deploy`, trusted only for `repo:openclaw/crabhelm:environment:fakeco`;
   - `arn:aws:iam::<account>:role/openclaw/fakeco/github/crabhelm-teardown`, trusted only for `repo:openclaw/crabhelm:environment:fakeco-teardown`.
4. `arn:aws:iam::<account>:role/openclaw/fakeco/cloudformation/crabhelm-service`, the only CloudFormation service role either GitHub role may pass.
5. `arn:aws:iam::<account>:policy/openclaw/fakeco/crabhelm-workload-boundary`, which permits only the reviewed ECS workload role envelope.
6. Private, encrypted, versioned S3 bucket `openclaw-fakeco-cfn-<account>-<region>` for non-secret CloudFormation templates. The deploy role needs access only to `crabhelm/fakeco/cloudformation/*`.
7. Immutable, scan-on-push ECR repository `openclaw/fakeco/crabhelm` and a reviewed image already pushed by digest.
8. The application secret and customer-managed KMS key. The workflow receives only their ARNs and calls `DescribeSecret`/`DescribeKey`; it never reads a secret value.
9. ACM certificate, external DNS, ALB OIDC client, Crabbox target, ClawRouter installation, audit-alert SNS topic, and digest-pinned post-overlay OpenClaw appliance.

The deploy GitHub role needs only OIDC session admission, metadata reads for the named prerequisites, writes to the exact CloudFormation artifact-bucket prefix, CloudFormation change-set/stack operations for `crabhelm-fakeco`, and `iam:PassRole` for the exact CloudFormation service role. The teardown role needs stack/resource reads, standard stack deletion, and the same exact `iam:PassRole`; it does not need create/update permissions. The CloudFormation service role owns stack mutation and must constrain workload IAM creation to the fixed path and require the named permissions boundary.

The application secret format remains the one documented in the parent [AWS guide](../README.md). Secret values never belong in GitHub variables, workflow inputs, rendered parameter files, stack parameters, logs, or teardown artifacts.

## GitHub Environment contract

Create two protected Environments only after account foundation review:

- `fakeco`: protected branch `main`, required reviewers as appropriate, `FAKECO_GITHUB_ROLE_ARN` set to the deploy role;
- `fakeco-teardown`: protected branch `main`, separate required approval, `FAKECO_GITHUB_ROLE_ARN` set to the teardown role.

Both Environments use variables—not GitHub secrets—for these non-secret names, ARNs, IDs, URLs, hosts, and digests:

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

The validator requires every ARN and the ECR image URI to match the selected account and Region. It rejects the production ClawRouter origin, wildcard/broad role paths, tagged images, missing inputs, and cross-target resources.

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

## Manual deployment

[`deploy-fakeco.yml`](../../../.github/workflows/deploy-fakeco.yml) is `workflow_dispatch` only. It refuses non-protected or non-`main` refs, renders before requesting AWS credentials, checks the caller account and exact prerequisite identities, confirms the digest exists in the external ECR repository, and performs one CloudFormation deployment with:

- `CAPABILITY_IAM`;
- the exact CloudFormation service-role ARN;
- the account-owned template bucket/prefix;
- the locked parameters and tags;
- no stack-owned ECR or `ProvisionService=false` stage.

After deployment it verifies observed parameters, tags, service role, outputs, singleton ECS stability, and runtime `/healthz`. It does not create DNS, upload an appliance, seed secrets, or prove routed inference; those remain explicit installation steps.

## Manual teardown

[`teardown-fakeco.yml`](../../../.github/workflows/teardown-fakeco.yml) requires the literal stack name `crabhelm-fakeco`, the separately protected `fakeco-teardown` Environment, and the same concurrency lock as deployment. Before deletion it verifies the live stack against the locked profile and uploads a names/ARNs/IDs-only teardown plan built from [`retained-resources.json`](retained-resources.json).

Deletion uses only:

```text
cloudformation:DeleteStack
deletion mode STANDARD
```

There is no force-delete fallback and no `--retain-resources` override. If deletion protection or profile drift is observed, the workflow stops; restore the reviewed locked profile before retrying.

Standard stack deletion deliberately leaves or creates:

- the final RDS snapshot and retained database credential;
- appliance, encrypted OAuth-vault, and audit buckets plus their deny-insecure-transport policies;
- source and dead-letter audit queues;
- the seven-day ECS log group.

The plan records their logical and physical IDs before deletion. External ECR, template bucket, IAM/OIDC resources, boundary, service role, application secret/KMS key, ACM/DNS, budgets, and anomaly monitoring are account-foundation-owned and untouched. Retained-data disposal, legal retention decisions, account closure, and data-deletion requests are outside this repository.
