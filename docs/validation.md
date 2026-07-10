# Validation ledger

Live evidence is separate from unit and simulator evidence. Detailed production records are retained outside the public repository.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Cloudflare reference control plane | Configured console and runtime hosts; organization and per-claw Durable Objects; alarm reconciliation | Live |
| AWS control plane | Singleton ECS/Fargate service behind an HTTPS ALB; ALB OIDC assertion verification; native runtime WebSockets; PostgreSQL state; private S3 stores; SQS audit delivery | Implemented + automated; deployment-specific live proof required |
| Identity-aware console | Cloudflare Access JWT issuer, audience, signature, and expiry verified before principal resolution; AWS verifies the ALB assertion signature, signer ARN, OIDC client, issuer, and expiry, then maps configured emails and groups to the administrator role | Cloudflare live; AWS automated |
| Private appliance | Digest-pinned archive under top-level `bundle/` in private R2 or S3; archive and manifest digests enforced before bootstrap | Cloudflare live; AWS automated |
| Real placement | Crabbox-created workspace with provider resource evidence; no simulator selected in production | Live |
| OpenClaw child | Gateway `2026.6.11`, loopback readiness, exact model `openai/gpt-5.5`, managed persona, read-only instructions and skills | Live |
| Actual inference | Bounded `openclaw agent` challenge returned the exact expected marker; `authReady: true`; `liveInferenceProbe: true` | Live |
| ClawRouter integration | Per-claw policy and epoch credential registration, hash-only control-plane secret handling, exact router/model bootstrap config, health/catalog/usage projection, credential rotation, and route-gated readiness | Implemented + automated; disposable FakeCo live proof required |
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
pnpm exec wrangler deploy --dry-run --config wrangler.production.jsonc
curl --fail "${CRABHELM_RUNTIME_URL:?set the production runtime URL}/healthz"
```

AWS implementation checks:

```bash
pnpm exec tsgo -p tsconfig.aws.json --noEmit
node --import tsx --test tests/aws/*.test.ts
aws cloudformation validate-template \
  --template-body file://deploy/aws/template.yaml
```

PostgreSQL integration coverage runs when `CRABHELM_TEST_POSTGRES_URL` identifies an isolated test database. Before treating an AWS installation as production-ready, also complete the stack, DNS, OIDC, appliance-upload, health, runtime-reconnect, and lifecycle checks in the [AWS deployment guide](../deploy/aws/README.md). Never point those checks at a Cloudflare installation's state or secrets.

Authenticated state for the existing direct-provider reference proof must show the claw as `ready`, Gateway `2026.6.11`, configured and resolved model `openai/gpt-5.5`, `authReady: true`, `liveInferenceProbe: true`, and one connected runtime bridge. A ClawRouter/FakeCo proof must instead show the desired `clawrouter/<provider>/<model>`, matching observed router origin/provider scope, `routerHealthy: true`, `catalogReady: true`, `routeVerified: true`, a fresh live inference marker for the current credential epoch, and one connected runtime bridge. Production readiness is never inferred from provider allocation, ClawRouter configuration alone, echoed shell source, or process existence.

## Production proof publication policy

The current live validation record confirms the reference Cloudflare Worker deployment, digest-pinned appliance, ready direct-provider claw, authenticated runtime reconnect, exact Slack probe delivery, credential refresh, and administrator access. It does not claim a live ClawRouter or AWS FakeCo deployment. Each AWS/ClawRouter installation requires its own equivalent live record; automated and template validation are not substitutes. Public documentation intentionally omits deployment IDs, resource IDs, job IDs, exact artifact digests, and administrator identities.
