# AWS deployment

This deployment runs the Crabhelm control plane as one long-lived Node.js task on ECS/Fargate. An internet-facing Application Load Balancer terminates HTTPS, authenticates the console host with OIDC, and forwards the separately authenticated runtime host without OIDC. PostgreSQL replaces Durable Object storage; private S3 buckets replace R2; SQS replaces the audit Queue.

The template supports the standard AWS commercial partition and AWS GovCloud (US). AWS China Regions are not yet supported; the template rejects `aws-cn` certificate, secret, and KMS key ARNs.

The stack intentionally starts one task. Its deployment policy is `MaximumPercent=100` and `MinimumHealthyPercent=0`, so an update stops the old actor before starting the replacement. The runtime bridge reconnects after the connection closes. Do not raise the desired count until cross-task coordinator ownership and signaling are implemented.

ClawRouter is a separate installation boundary. This stack may call its OpenAI-compatible inference and administrative APIs, but it does not deploy ClawRouter, own its upstream provider credentials, or share database, buckets, queues, signing material, or control-plane state with it. Deploy and validate ClawRouter independently before enabling `ClawRouterMode`.

## Resources and cost

[`template.yaml`](template.yaml) creates:

- one VPC with two public ALB subnets, two private task subnets, two isolated database subnets, and one NAT gateway;
- one HTTPS ALB with host rules for the console and runtime origins;
- one 0.5-vCPU/1-GiB Fargate task;
- one encrypted PostgreSQL RDS instance, Multi-AZ by default, with stack-generated credentials in Secrets Manager;
- separate private, encrypted, versioned appliance, OAuth-vault, and audit buckets;
- an encrypted audit queue and retained dead-letter queue, with optional SNS-wired source-age and dead-letter alarms;
- an ECS cluster, least-privilege task roles, and a retained CloudWatch log group;
- optionally, an immutable-tag ECR repository.

The NAT gateway, ALB, and Multi-AZ database have baseline hourly costs even at zero traffic. Set `DatabaseMultiAz=false` only for a disposable environment.

The stack does not create DNS records. It outputs the ALB DNS name for externally managed records.

## Prerequisites

- Docker.
- AWS CLI credentials for the target account and Region.
- An ACM certificate in that Region covering both hostnames.
- An OIDC web client whose callback is `https://<console-host>/oauth2/idpresponse`.
- A same-account, same-Region Secrets Manager JSON secret.
- Reviewed appliance and runtime digests.

The OIDC issuer and endpoints must use publicly trusted certificates and publicly resolvable DNS. The ALB must be able to reach the token and user-info endpoints over IPv4 HTTPS; an IPv6-only or otherwise unreachable endpoint will make console authentication fail even if stack creation succeeds. A publicly resolvable name may resolve to private IPv4 addresses when VPC routing and security controls allow the ALB to reach them.

The OIDC client must allow the scopes configured in `OidcScopes`, which defaults to `openid email profile`, and the identity provider must restrict access to the intended organization. Add the provider-specific group scope when `AdminGroups` is used. The resulting signed ALB assertion must contain an email claim and may contain a `groups` array.

Every successfully authenticated identity receives the member role. `AdminEmails` is required and must contain at least one known bootstrap administrator; this prevents a missing or mis-scoped group claim from leaving the deployment with no administrator. `AdminGroups` may grant the administrator role to additional identities.

## Application secret

Create the JSON secret outside CloudFormation so secret values never enter stack parameters or task-definition plaintext. It must contain:

```json
{
  "OIDC_CLIENT_SECRET": "replace",
  "CRABBOX_TOKEN": "replace",
  "BOOTSTRAP_SIGNING_SECRET": "replace-with-at-least-32-bytes",
  "SESSION_SIGNING_SECRET": "replace-with-at-least-32-bytes",
  "INVOCATION_SIGNING_SECRET": "replace-with-at-least-32-bytes",
  "RUNTIME_SIGNING_SECRET": "replace-with-at-least-32-bytes",
  "VAULT_MASTER_KEY": "replace-with-a-base64url-encoded-32-byte-key",
  "SLACK_BOT_TOKEN": "replace",
  "SLACK_SIGNING_SECRET": "replace",
  "GITHUB_OAUTH_CLIENT_SECRET": "replace"
}
```

For direct inference (`ClawRouterMode=off`), add:

```json
{
  "OPENAI_API_KEY": "replace"
}
```

For ClawRouter inference (`ClawRouterMode=on`), omit `OPENAI_API_KEY` and add:

```json
{
  "CLAWROUTER_ADMIN_TOKEN": "replace",
  "CLAWROUTER_CREDENTIAL_SECRET": "replace-with-at-least-32-bytes"
}
```

When the separate ClawRouter admin API is protected by Cloudflare Access, also add `CLAWROUTER_ACCESS_CLIENT_ID` and `CLAWROUTER_ACCESS_CLIENT_SECRET`, then set `ClawRouterAccessServiceToken=on`. For authenticated Prometheus export, add `METRICS_BEARER_TOKEN` with at least 32 bytes and set `PrometheusMode=on`. Never place upstream provider credentials in the Crabhelm application secret for routed mode; those remain only in ClawRouter. Never commit the populated JSON. Local `deploy/aws/*.local.json` and `deploy/aws/*secret*.json` files are excluded from the Docker build context, but still keep them outside source control.

Secrets encrypted with the account's default Secrets Manager key need no extra parameter. For a customer-managed key, pass `ApplicationSecretKmsKeyArn`; the CloudFormation deployment principal also needs permission to decrypt it because the ALB OIDC action resolves the client secret during deployment.

## Build an image

`Dockerfile.aws` bundles the exported server in `aws/server.ts`, copies the SQL migrations and web console, and installs the separate AWS commercial and GovCloud RDS global CA bundles. The service selects the bundle from `AWS_REGION`. The container's small ESM launcher calls `startAwsServer()`. The Node image and both reviewed CA bundles are digest-pinned; update those pins intentionally. Build for the task architecture and use an immutable tag:

```bash
docker build \
  --platform linux/amd64 \
  --file Dockerfile.aws \
  --tag "$IMAGE_URI" \
  .
docker push "$IMAGE_URI"
```

`ImageUri` may reference ECR in this account, cross-account ECR with a suitable repository policy, or another registry reachable by ECS. Private non-ECR registries need additional repository credentials and are not configured by this template.

### Stack-owned ECR

CloudFormation cannot push the first image into a repository it is creating. Use two updates:

1. Deploy with `CreateEcrRepository=true` and `ProvisionService=false`.
2. Read the `EcrRepositoryUri` output, authenticate Docker, and push `ImageTag`.
3. Update the stack with the same parameters and `ProvisionService=true`.

The repository uses immutable tags. Use a new commit-derived `ImageTag` for every deployment.

## Deploy

The abbreviated command below shows required inputs. Keep deployment-specific values in an approved local parameter workflow rather than committing them.

```bash
aws cloudformation deploy \
  --stack-name crabhelm-aws \
  --template-file deploy/aws/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ImageUri="$IMAGE_URI" \
    CertificateArn="$CERTIFICATE_ARN" \
    ConsoleHostname="$CONSOLE_HOSTNAME" \
    RuntimeHostname="$RUNTIME_HOSTNAME" \
    OidcIssuer="$OIDC_ISSUER" \
    OidcAuthorizationEndpoint="$OIDC_AUTHORIZATION_ENDPOINT" \
    OidcTokenEndpoint="$OIDC_TOKEN_ENDPOINT" \
    OidcUserInfoEndpoint="$OIDC_USERINFO_ENDPOINT" \
    OidcClientId="$OIDC_CLIENT_ID" \
    ApplicationSecretArn="$APPLICATION_SECRET_ARN" \
    AdminEmails="$ADMIN_EMAILS" \
    GitHubOauthClientId="$GITHUB_OAUTH_CLIENT_ID" \
    CrabboxUrl="$CRABBOX_URL" \
    NodeRuntimeSha256="$NODE_RUNTIME_SHA256" \
    ApplianceArchiveSha256="$APPLIANCE_ARCHIVE_SHA256" \
    ApplianceManifestSha256="$APPLIANCE_MANIFEST_SHA256"
```

### Disposable FakeCo profile

For a disposable FakeCo installation, keep the singleton coordinator and separate-installation boundaries intact. Use a unique stack name, hosts, application secret, ClawRouter tenant, and Crabbox target; do not reuse any Cloudflare or production fleet state. The relevant overrides are:

```text
ClawRouterMode=on
ClawRouterBaseUrl=https://<separate-clawrouter-host>
ClawRouterTenantId=fakeco
ClawRouterAllowedProviders=openai
ClawRouterDefaultModel=clawrouter/openai/gpt-5.5
DatabaseMultiAz=false
DatabaseDeletionProtection=false
LoadBalancerDeletionProtection=false
PrometheusMode=on
```

`DatabaseMultiAz=false` and disabled deletion protection are disposable-environment choices, not production defaults. `PrometheusMode=on` requires the secret described above. If ClawRouter uses Cloudflare Access, also set `ClawRouterAccessServiceToken=on`. This profile does not change `DesiredCount=1`; scaling the ECS service remains unsupported.

For group-based administrator grants, keep at least one bootstrap address in `AdminEmails`, pass `AdminGroups`, and set `OidcScopes="openid email profile <provider-group-scope>"`. Group scope and claim names are provider-specific; confirm the signed ALB assertion contains a `groups` array before depending on group grants. Supply the fixed target parameters when their defaults are not the intended production policy.

For production alerting, pass an existing SNS topic name as `OperatorAlertTopicName`. The stack constructs a same-account, same-Region ARN in the current commercial or GovCloud partition, then alarms when the source audit queue's oldest visible message exceeds five minutes or the audit dead-letter queue has one or more visible messages. The topic and confirmed operator subscriptions are managed outside this stack. Leaving the parameter empty omits both alarms, which is useful for disposable deployments but requires equivalent external queue monitoring.

The initial deployment leaves ALB and database deletion protection disabled so CloudFormation can roll back a failed first create cleanly. After DNS, TLS, health checks, console authentication, and runtime connectivity have been validated, update the stack with `LoadBalancerDeletionProtection=true` and `DatabaseDeletionProtection=true`.

The deployment forces TLS to PostgreSQL and verifies the server chain with the packaged RDS CA bundle. Database credentials are generated once in a retained Secrets Manager secret, injected as ECS secrets, URL-encoded in process, and never placed in task-definition plaintext. This minimal stack does not enable automatic database-password rotation; rotate the RDS password, secret value, and ECS task together during a maintenance window.

## DNS and callbacks

Read the `AlbDnsName` output, then point both configured hostnames to it using CNAME, ALIAS, or ANAME records supported by the external DNS provider. Preserve the configured hostnames: the ALB default rule returns 404 for any other host.

When Cloudflare manages DNS, either hostname may be DNS-only or proxied. For proxied records, use **Full (strict)** encryption mode, keep WebSockets enabled, and preserve the original host header. The ALB sees Cloudflare source addresses rather than client addresses: keep the default `IngressCidr=0.0.0.0/0`, or extend the template's security-group ingress to cover Cloudflare's published IPv4 ranges because the single `IngressCidr` parameter cannot express the full set. Do not place Cloudflare Access in front of the console's ALB OIDC rule unless the two authentication layers, callback flow, and cookies have been deliberately configured and tested together.

Configure integrations after DNS and TLS resolve:

- OIDC callback: `https://<console-host>/oauth2/idpresponse`
- GitHub OAuth callback: `https://<console-host>/api/oauth/github/callback`
- Slack events: `https://<runtime-host>/slack/events`
- Slack interactions: `https://<runtime-host>/slack/interactions`

Upload the reviewed appliance to `s3://<AppliancesBucketName>/releases/<ApplianceArchiveSha256>.tgz`. The task role can read that prefix but cannot upload or replace appliances.

## Transport and OIDC trust boundary

The ALB terminates public TLS and forwards health checks and application traffic to port 8080 over private HTTP. The task has no public IP, its security group accepts port 8080 only from the ALB security group, and the ALB security group limits application egress to that task security group. This security-group boundary limits network reachability, but it does not encrypt the ALB-to-task hop.

For console requests, the ALB places selected OIDC user-info claims—including email and, when supplied, groups—in the signed `x-amzn-oidc-data` assertion. The task validates the AWS signature, ALB signer ARN, issuer, client ID, and expiration. The assertion and request remain readable on the private HTTP hop; this deployment accepts the resulting claim and request disclosure risk within the VPC and security-group boundary. Deployments whose compliance policy requires encryption on every hop must add task-side TLS and an HTTPS target group, or another approved backend-TLS design; this template does not provide backend TLS.

## Verify and operate

Wait for the singleton service and check the public runtime health endpoint:

```bash
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE"
curl --fail --silent --show-error "https://$RUNTIME_HOSTNAME/healthz"
```

For a ClawRouter installation, create or reconcile a test claw and require the console/API to show matching desired and observed router origin, model, providers, policy/credential ids, and credential epoch plus `routerHealthy`, `catalogReady`, and `routeVerified`. Gateway readiness and a fresh live-inference marker must also be present; router configuration alone is not readiness. Budget and usage views contain only bounded counters. **View diagnostics** (or authenticated `GET /api/claws/<id>/runtime-diagnostics` on the console host) returns allowlisted process state and redacted log summaries, never raw model or tool content.

When `PrometheusMode=on`, verify the metadata-only endpoint with its dedicated machine credential:

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer ${METRICS_BEARER_TOKEN:?set the metrics bearer token}" \
  "https://$RUNTIME_HOSTNAME/metrics"
```

The response is aggregate and intentionally has no per-claw labels, prompts, completions, messages, tool output, diagnostics text, or credentials. Keep the metrics token out of shell history and logs through the installation's approved secret-injection workflow.

The ALB idle timeout is 1,200 seconds. Runtime bridges send a heartbeat every 45 seconds, keeping their WebSockets active. ECS allows 120 seconds for graceful shutdown, and the target group uses the same deregistration delay.

### Audit dead-letter queue runbook

An audit source-age alarm means the poller is not keeping up or cannot receive messages; check ECS task health, IAM, SQS reachability, and poller errors before the 14-day source retention expires. A DLQ alarm means at least one message exhausted the queue's five-receive policy and is awaiting operator action. First inspect the ECS logs and a sample DLQ message in an approved environment, identify and fix the consumer or destination failure, and assess whether replay could duplicate a previously completed archive write. Do not purge the queue or redrive it before that review.

Use the `AuditDeadLetterQueueUrl` and `AuditDeadLetterQueueArn` stack outputs to check the backlog and, after remediation, start a rate-limited redrive to the source audit queue:

```bash
aws sqs get-queue-attributes \
  --queue-url "$AUDIT_QUEUE_URL" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

aws sqs get-queue-attributes \
  --queue-url "$AUDIT_DLQ_URL" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible QueueArn

aws sqs start-message-move-task \
  --source-arn "$AUDIT_DLQ_ARN" \
  --max-number-of-messages-per-second 10

aws sqs list-message-move-tasks \
  --source-arn "$AUDIT_DLQ_ARN"
```

Watch the ECS consumer logs, source queue, and DLQ until the move finishes and the visible-message alarm clears. If messages return to the DLQ, stop redriving and continue incident diagnosis.

For an image update, change `ImageUri` or `ImageTag` and update the stack. Rotations are credential-specific. For a server credential that is safe to refresh by restart—such as the Crabbox token, Slack credentials, or GitHub OAuth client secret—force a deployment:

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --force-new-deployment
```

After rotating `OPENAI_API_KEY`, also bump every affected direct-mode claw's credential epoch through the normal **Rotate credentials** operation; restarting ECS alone does not replace a key already delivered to a child. In ClawRouter mode, that operation derives the next per-claw token from `CLAWROUTER_CREDENTIAL_SECRET`, registers only its hash with ClawRouter, redelivers it, and requires fresh route proof. Use credential epochs for routine child-token rotation. Do not rotate the fleet `CLAWROUTER_CREDENTIAL_SECRET` by restart: changing the derivation seed requires a reviewed staged migration that this slice does not automate. Coordinate `CLAWROUTER_ADMIN_TOKEN` and Access service-token rotations with the separate ClawRouter installation, then restart Crabhelm. Upstream provider-key rotation is solely a ClawRouter operation and does not require child delivery. Signing-key rotations need a staged token/session migration plan. Do not rotate `VAULT_MASTER_KEY` by restart: existing OAuth vault objects are encrypted under that key and require a reviewed re-encryption migration.

`OIDC_CLIENT_SECRET` is different: the ALB, not the ECS task, consumes it. After rotating that key, increment `OidcClientSecretVersion` and update the CloudFormation stack. This changes the ALB session-cookie name, invalidates existing console sessions, and forces CloudFormation to resolve the new client secret into the listener rule. An ECS-only forced deployment does not rotate the ALB copy.

## Removal

Before deleting the stack, update it with `LoadBalancerDeletionProtection=false` and `DatabaseDeletionProtection=false`, then confirm workload removal through the normal Crabhelm lifecycle.

Database replacement/deletion takes a final snapshot. After a successful stack create, credentials, buckets and their policies, queues, the log group, and a stack-created ECR repository are retained deliberately; review and remove them separately only after retention and audit obligations are satisfied. A failed initial stack create rolls these resources back instead of retaining them, so a corrected deployment can reuse their names.
