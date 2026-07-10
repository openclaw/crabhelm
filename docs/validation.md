# Validation ledger

Live evidence is separate from unit and simulator evidence. Detailed production records are retained outside the public repository.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Cloudflare reference control plane | Configured console and runtime hosts; organization and per-claw Durable Objects; alarm reconciliation | Live |
| AWS control plane | Singleton ECS/Fargate service behind an HTTPS ALB; ALB OIDC assertion verification; native runtime WebSockets; PostgreSQL state; private S3 stores; SQS audit delivery | Implemented + automated; deployment-specific live proof required |
| FakeCo AWS foundation | Locked account/Region renderer; exact deploy/teardown/image-publish OIDC subjects; dedicated protected-main image role; landed-source reachability; BuildKit/ECR digest equality; digest-bound Linux/AMD64 config and ECR scan-threshold proof; permissions boundary and role path; bounded storage/log retention; deterministic tags; live-template-bound exact-set standard-only retained-resource teardown plan; no secret reads | Implemented + automated; GitHub Environments, ECR image publication, and AWS prerequisites not created or run |
| Identity-aware console | Cloudflare Access JWT issuer, audience, signature, and expiry verified before principal resolution; AWS additionally requires one explicit verified-email value, verifies the ALB assertion signature, signer ARN, OIDC client, issuer, and expiry, clears all ALB cookie shards on logout, then maps configured emails and groups to the administrator role | Cloudflare live; AWS automated |
| Private appliance | Digest-pinned archive under top-level `bundle/` in private R2 or S3; archive and manifest digests enforced before bootstrap | Cloudflare live; AWS automated |
| Real placement | Crabbox-created workspace with provider resource evidence; no simulator selected in production | Live |
| OpenClaw direct-reference child | Gateway `2026.6.11`, loopback readiness, exact model `openai/gpt-5.5`, managed persona, read-only instructions and skills | Live; direct mode only |
| Actual inference | Bounded `openclaw agent` challenge returned the exact expected marker; `authReady: true`; `liveInferenceProbe: true` | Live |
| ClawRouter integration | Explicit full-model-to-canonical-provider mapping, protocol-v3 project attribution, per-claw policy and epoch credential registration, hash-only control-plane secret handling, exact base URL/env SecretRef/plugin config, health/catalog/usage projection, credential rotation, `models status --probe`, and exact-model `CLAWROUTER_CANARY_OK` route proof | Implemented + automated; post-overlay appliance and disposable FakeCo live proof required |
| Slack end to end | Production DM route completed and Slack delivered exact probe replies through the remote OpenClaw runtime, including after forced reconnect | Live |
| Runtime reliability | Single-process appliance lock, authenticated outbound WebSocket dispatch and credential rotation, bounded process-group execution, delivery retry, reset-generation cancellation, and release-pinned in-place appliance rollout | Live + automated |
| Runtime authentication | Owner-only ten-minute workload credential, one-use refresh rotation, one-use connection tickets, and no credential inheritance by turn processes | Live + automated |
| GitHub delegation | OAuth grant encrypted in the selected private object store; bounded governed read executed as the connected requester; writes require argument-bound confirmation | Cloudflare live + automated; AWS automated |
| Audit archive | Identity-complete metadata through Cloudflare Queue to private R2 or through SQS to private S3; prompt and tool content excluded | Cloudflare deployed; AWS automated |
| Metadata-only telemetry | Per-claw OTLP traces/metrics with capture disabled; authenticated Prometheus-compatible aggregate lifecycle, Gateway, route, request, token, and cost metrics | Implemented + automated; deployment-specific scrape proof required |
| Browser workflow | Existing Chrome profile verified GitHub Access login, administrator role resolution, Fleet, Personas, Skills, Access, metadata-only Activity, and runtime status; Slack delivery is separately verified by exact job/delivery metadata | Live |
| No tunnel | Control plane calls Crabbox outbound; child connects outbound over HTTPS/WSS; no Cloudflare Tunnel, equivalent child tunnel, or permanent parent VM | Verified |
| Automated proof | Domain, governance, security, policy, routing, concurrency, deletion, bootstrap, appliance, persistence, static, Worker, and AWS adapter checks | Run before every deployment |

## Repeatable checks

```bash
pnpm check
pnpm exec wrangler deploy --dry-run
curl --fail "${CRABHELM_RUNTIME_URL:?set the production runtime URL}/healthz"
```

AWS implementation checks:

```bash
pnpm exec tsgo -p tsconfig.aws.json --noEmit
node --import tsx --test tests/aws/*.test.ts
pnpm aws:fakeco:validate
actionlint .github/workflows/publish-fakeco-image.yml
ruby -e 'require "psych"; Psych.parse_file(ARGV[0])' deploy/aws/template.yaml
```

The template is larger than CloudFormation's direct `TemplateBody` limit. Generic deployments and the FakeCo workflow use an account-owned encrypted template bucket; do not replace that with an unscoped bucket or inline upload. The workflow's CloudFormation change set remains the authoritative service-side template validation.

PostgreSQL integration coverage runs when `CRABHELM_TEST_POSTGRES_URL` identifies an isolated test database. Before treating an AWS installation as production-ready, also complete the stack, DNS, OIDC, appliance-upload, health, runtime-reconnect, and lifecycle checks in the [AWS deployment guide](../deploy/aws/README.md). Never point those checks at a Cloudflare installation's state or secrets.

Authenticated state for the existing direct-provider reference proof must show the claw as `ready`, Gateway `2026.6.11`, configured and resolved model `openai/gpt-5.5`, `authReady: true`, `liveInferenceProbe: true`, and one connected runtime bridge. That artifact predates the OpenClaw ClawRouter provider-overlay fix and is not evidence for routed mode. A ClawRouter/FakeCo proof requires a new digest-pinned appliance built from the landed overlay commit and must show the desired `clawrouter/<catalog-model-id>`, matching explicit canonical provider mapping and observed router scope, `routerHealthy: true`, `catalogReady: true`, `routeVerified: true`, a successful bounded `models status --probe`, a fresh exact-model `CLAWROUTER_CANARY_OK` marker for the current credential epoch, and one connected runtime bridge. Gateway startup proof uses `/readyz`; ongoing liveness uses `/healthz`. Production readiness is never inferred from provider allocation, ClawRouter configuration alone, echoed shell source, or process existence.

## Production proof publication policy

The current live validation record confirms the reference Cloudflare Worker deployment, digest-pinned appliance, ready direct-provider claw, authenticated runtime reconnect, exact Slack probe delivery, credential refresh, and administrator access. It does not claim a live ClawRouter or AWS FakeCo deployment. The first FakeCo canary intentionally keeps Slack off and must prove verified Cognito email handling plus ALB logout before Slack is enabled with real sandbox credentials. The FakeCo foundation is local/automated proof only until its account prerequisites, protected GitHub Environments, manual workflow, DNS, and full routed lifecycle are live-validated. Each AWS/ClawRouter installation requires its own equivalent live record; automated and template validation are not substitutes. Public documentation intentionally omits deployment IDs, resource IDs, job IDs, exact artifact digests, and administrator identities.
