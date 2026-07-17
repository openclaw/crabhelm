# Crabhelm

Identity-aware control plane for independently deployed OpenClaw teammates, deployable on Cloudflare or AWS.

Each Crabhelm installation selects one control-plane backend. The reference Cloudflare deployment uses Workers, Durable Objects, R2, and Queues. The AWS deployment uses a singleton ECS/Fargate service behind an Application Load Balancer, PostgreSQL on RDS, private S3 buckets, and SQS. Both expose the same fleet, governance, bootstrap, runtime, and audit contracts. They are alternative installations, not active-active replicas of one fleet, and must not share state or signing material.

Deployment adapters create isolated agent machines wherever an administrator configures them; the first production adapter uses Crabbox.

No inbound tunnel or permanent parent VM is required. The control-plane service calls provider APIs outbound, and every agent keeps its own OpenClaw Gateway, state root, credentials, sessions, memory, and OS identity.

The execution plane separates requester, persona, and actor; governs skills and tool capabilities; issues signed one-time invocation grants; keeps durable OAuth credentials in an encrypted private object-store vault; requires argument-bound confirmation for external writes; delivers managed identity and skills read-only; and records identity-complete audit evidence through the selected backend's queue and archive. The first controlled provider wrapper supports bounded GitHub repository/issue reads and confirmed issue comments.

## Production backends

- Cloudflare (reference): Worker ingress, organization and per-claw Durable Objects, private R2, Queue-backed audit export, and Cloudflare Access.
- AWS: one long-lived ECS/Fargate task, ALB OIDC for the console, native ALB WebSockets for the runtime host, PostgreSQL on RDS, private S3, and SQS-backed audit export.

The AWS service intentionally runs one task until distributed coordinator ownership exists. Deploy Cloudflare and AWS as separate fleets; active-active operation or a shared control-plane database is unsupported.

Common production properties:

- Console and runtime: separate deployment-specific HTTPS hosts
- Appliance store: private R2 or S3 bucket configured per deployment
- Deployment target: configured privately through Crabbox
- Operator access: verified Cloudflare Access identity or ALB OIDC identity; no shared operator bearer
- Cloudflare automation access: account-scoped service binding; no public administration endpoint
- Team ingress: one signed Slack app at the configured runtime host; personas bind approved workspaces/channels to claws
- Provider delegation: GitHub OAuth grants stay encrypted in the private object-store vault and are used only by the governed wrapper
- Agent bootstrap: deterministic per-agent HMAC token, short private object-store delivery path, outbound HTTPS/WSS only

The current Crabbox target creates a real workspace, installs digest-pinned OpenClaw and Crabhelm artifacts, starts a loopback Gateway, runs a real model challenge, then starts the outbound runtime bridge. A claw reports ready only after the exact inference response and bridge launch succeed. Simulator code remains for tests and local domain development; production never selects it.

## Deploy on Cloudflare

Requirements: Node.js 22+, pnpm, Wrangler authenticated to the target Cloudflare account.

The committed `wrangler.jsonc` is an example configuration with reserved hosts, empty identity settings, example resource names, and zero artifact digests. Copy it to the ignored `wrangler.production.jsonc`, then configure the real account, routes, bindings, variables, and release digests there. `pnpm worker:deploy` always uses that untracked production file.

```bash
pnpm install
pnpm check
pnpm worker:deploy
```

Required Worker secrets:

```text
BOOTSTRAP_SIGNING_SECRET
CRABBOX_TOKEN
SESSION_SIGNING_SECRET
INVOCATION_SIGNING_SECRET
RUNTIME_SIGNING_SECRET
VAULT_MASTER_KEY
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
GITHUB_OAUTH_CLIENT_SECRET
```

Signing secrets must contain at least 32 bytes. `VAULT_MASTER_KEY` is a base64url-encoded 32-byte AES key. Direct inference (`CRABHELM_CLAWROUTER=off`) also requires `OPENAI_API_KEY`. A ClawRouter fleet (`CRABHELM_CLAWROUTER=on`) instead requires `CLAWROUTER_ADMIN_TOKEN` and a fleet-local `CLAWROUTER_CREDENTIAL_SECRET` of at least 32 bytes; add the `CLAWROUTER_ACCESS_CLIENT_ID` and `CLAWROUTER_ACCESS_CLIENT_SECRET` pair when the separate ClawRouter installation is protected by Cloudflare Access. `CRABHELM_PROMETHEUS=on` additionally requires `METRICS_BEARER_TOKEN` of at least 32 bytes.

`GITHUB_OAUTH_CLIENT_ID`, `CRABHELM_PROBE_EMAIL`, and Cloudflare Access team/audience settings are non-secret production Worker variables. Slack sends signed events to `${RUNTIME_URL}/slack/events` and interactions to `${RUNTIME_URL}/slack/interactions`. The GitHub OAuth callback is `${PUBLIC_URL}/api/oauth/github/callback`. Use `wrangler secret put NAME --config wrangler.production.jsonc`; never place secret values in `wrangler.jsonc`, `.dev.vars`, logs, or registry state.

After rotating a delivered secret, bump the affected claw's credential epoch with the **Rotate credentials** drawer button or `POST /api/claws/<id>/rotate-credentials`. The claw performs one release-pinned in-place reinstall that re-fetches the epoch-bound `credentials.env`, then must pass the live inference probe again before it reports ready. In ClawRouter mode the control plane registers the new credential hash before delivering the derived child token; upstream provider secrets remain exclusively in ClawRouter.

Build and upload a reviewed appliance after guest-profile changes:

```bash
deploy/crabbox-profile/build-bundle.sh \
  --node-tarball /absolute/node-v22.23.1-linux-x64.tar.xz \
  --openclaw-tarball /absolute/openclaw.tgz \
  --slack-tarball /absolute/slack.tgz \
  --otel-tarball /absolute/diagnostics-otel.tgz \
  --output /tmp/crabhelm-bundle
tar -C /tmp -s '|^crabhelm-bundle|bundle|' \
  -czf /tmp/crabhelm-bundle.tgz crabhelm-bundle
: "${CRABHELM_APPLIANCE_BUCKET:?set the private R2 appliance bucket name}"
pnpm exec wrangler r2 object put "$CRABHELM_APPLIANCE_BUCKET/releases/$APPLIANCE_ARCHIVE_SHA256.tgz" \
  --file /tmp/crabhelm-bundle.tgz --remote --config wrangler.production.jsonc
```

Verify the remote archive bytes, then update both `APPLIANCE_ARCHIVE_SHA256` and `APPLIANCE_MANIFEST_SHA256` to the generated digests before deploying the Worker.

## Deploy on AWS

The AWS stack builds the same control-plane service for Node.js and provisions ECS/Fargate, an HTTPS ALB, PostgreSQL RDS, private S3 buckets, SQS, and supporting network and IAM resources. DNS may remain managed by Cloudflare or another provider; point the console and runtime hostnames at the ALB as described in the [AWS deployment guide](deploy/aws/README.md).

The AWS backend is a separate installation boundary. Do not attach it to an existing Cloudflare fleet or reuse that fleet's database, buckets, queue, signing secrets, runtime credentials, or hostnames.

Disposable FakeCo uses a [locked AWS profile](deploy/aws/fakeco/README.md) with offline publication/render/verify/teardown-plan commands and separate manual protected-main image-publish, deploy, and teardown workflows. The image publisher builds only the Crabhelm ECS control plane from `Dockerfile.aws`; OpenClaw standalone images and the x86_64 Gateway appliance digest triple remain separate artifact owners. All workflow inputs are non-secret names, ARNs, IDs, origins, commit IDs, and digests; account/OIDC/IAM/ECR/KMS/ACM/DNS/budget foundation remains external.

## Local development

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4177>. Local development uses an explicitly labeled simulator. Production Cloudflare and AWS configurations always use the real Crabbox adapter.

## ClawRouter inference

Set `CRABHELM_CLAWROUTER=on` to make the separately installed ClawRouter service the canonical inference boundary. Configure its exact HTTPS origin, tenant, provider allowlist, exact model-to-provider map, and fleet default with `CLAWROUTER_BASE_URL`, `CLAWROUTER_TENANT_ID`, `CLAWROUTER_ALLOWED_PROVIDERS`, `CLAWROUTER_MODEL_PROVIDER_MAP`, and `CLAWROUTER_DEFAULT_MODEL`. The map uses comma-separated `<clawrouter-model-ref>=<canonical-catalog-provider-id>` entries, for example `clawrouter/google/gemini-3.5-flash=google-gemini`; Crabhelm never infers a policy provider from the model namespace. Models use the explicit `clawrouter/<catalog-model-id>` form. Each claw receives immutable desired router metadata, a stable `crabhelm_<uuid>` policy/credential identity, its selected primary/fallback models, and optional monthly budget.

During reconciliation Crabhelm upserts that claw's ClawRouter policy with content retention disabled, registers only the SHA-256 hash of an epoch-derived credential suffix, and delivers the complete scoped token only to the child. The ClawRouter admin credential and all upstream provider credentials never enter bootstrap output, registry state, logs, or the child. The control plane then verifies `/v1/health`, `/v1/key/inspect`, `/v1/catalog`, and bounded `/v1/usage` metadata. The child configures `models.providers.clawrouter.baseUrl`, an env-backed `models.providers.clawrouter.apiKey` reference to `CLAWROUTER_API_KEY`, static `X-ClawRouter-Project-Id: <raw-claw-uuid>` attribution, and the bundled `clawrouter` plugin without creating a fixed `models[]` catalog. Crabhelm removes stale explicit Agent/Session/Request attribution headers so OpenClaw can supply their live values, while preserving unrelated explicit provider headers. Readiness requires `/readyz`, a successful `openclaw models status --probe --probe-provider clawrouter --probe-max-tokens 16 --json`, and an exact-model canary returning `CLAWROUTER_CANARY_OK`; direct OpenAI completion cannot satisfy this proof. Ongoing Gateway liveness uses `/healthz`.

The console and API expose desired versus observed router/model/provider identities, credential epoch, router and catalog health, live-route verification, Gateway/runtime readiness, budget, and aggregate request/token/cost counters. Project attribution is never used as a Prometheus label, preventing per-claw metric cardinality and identity disclosure. The existing bounded runtime diagnostics endpoint exposes only redacted sentinel/log summaries. This integration does not add a Crabhelm-owned inference proxy: Crabhelm and ClawRouter remain separate installations with separate state and secrets.

Treat the fleet router origin, tenant, provider allowlist, model-to-provider map, and credential-derivation secret as installation identity. Existing claws fail closed if their persisted desired router no longer matches those settings; move a disposable fleet or use a reviewed migration rather than changing them in place. Routine scoped-token rotation uses each claw's credential epoch and does not rotate the fleet derivation secret.

## Managed OpenTelemetry

Administrators can set per-claw trace and metric export through `PATCH /api/claws/<id>` or the service-bound admin RPC. Supply an HTTPS OTLP base endpoint; Crabhelm appends `/v1/traces` and `/v1/metrics`, keeps OTLP logs and all prompt/response/tool/system-prompt capture disabled, and requires at least one of traces or metrics when export is enabled.

```json
{
  "observability": {
    "otel": {
      "enabled": true,
      "endpoint": "https://collector.example.com/otlp",
      "serviceName": "crabhelm-research",
      "traces": true,
      "metrics": true,
      "sampleRate": 0.1,
      "flushIntervalMs": 60000
    }
  }
}
```

The current contract intentionally has no collector-auth header field; use an approved authenticated network endpoint or gateway rather than putting credentials in the URL. Enabling this for the first time requires an appliance containing the pinned offline `diagnostics-otel` plugin.

For pull-based fleet health, set `CRABHELM_PROMETHEUS=on` and request `GET /metrics` on the runtime host with `Authorization: Bearer <METRICS_BEARER_TOKEN>`. The Prometheus-compatible response contains aggregate lifecycle phase, Gateway readiness, route-verification, request, token, and cost numbers only. It has no per-claw labels, prompts, completions, messages, tool output, diagnostic text, or credential material.

## Testing

`pnpm check` runs build and type checks plus the Node, AWS adapter, and Worker test tiers. `pnpm test` runs the fast Node domain suite (`node:test`). Tests under `tests/aws/` cover AWS identity, configuration, storage, PostgreSQL state, and coordinator behavior. `pnpm test:workers` runs the Worker and both Durable Objects inside workerd via `@cloudflare/vitest-pool-workers` (`tests/workers/`), covering router host-splitting, the Access auth gate, SQLite-backed control-plane state, and the hibernatable runtime-bridge reconnect path against the real runtime.

## Safety boundaries

- Placement target, region, profile, TTL, and idle timeout are administrator policy—not browser-supplied provider overrides.
- A provider resource becomes ready only from live child evidence; allocation alone is not readiness.
- Registry and audit state exclude prompts, messages, tool output, credential values, and opaque provider response bodies.
- Bootstrap endpoints require a per-agent HMAC bearer, return `no-store`, and expose only that agent's fixed appliance and credentials.
- Slack signing is verified before parsing; Cloudflare Access JWTs or ALB OIDC assertions are verified against the configured issuer, audience/client, signer, and identity role-mapping policy.
- Access-authenticated clients and enrolled runtimes may redeem governed grants; actor policy, argument digest, expiry, and the one-use fence still apply.
- Runtime turns, credential rotation, health, and reconnect use one authenticated outbound WebSocket to a per-claw coordinator (a Durable Object on Cloudflare or transactionally persisted PostgreSQL state on AWS); reset generations abort active process groups, and persona-bound job payloads remain encrypted at rest.
- The owner-only runtime workload credential is audience-bound, expires after ten minutes, rotates through a one-use mint fence with encrypted idempotent response replay, and is never inherited by model/tool processes; persistence permits bridge crash and host restart recovery.
- The OpenClaw Gateway runs as a dedicated unprivileged service account. A root-owned nftables service restricts its workspace to loopback, DNS, NTP, DHCP, and TCP 443, blocks cloud instance metadata before credentials land, and must pass live-rule verification before readiness. Enforcement is fail-closed by default; `CRABHELM_EGRESS_LOCKDOWN=off` is an explicit operational escape hatch.
- With ClawRouter enabled the agent holds only its epoch-scoped ClawRouter token. Crabhelm registers only its hash, while the separate ClawRouter installation owns upstream provider credentials, routing, and inference enforcement.
- Removal remains evidence-driven: disable ingress, drain active work, release the exact provider identity, confirm absence, then revoke the exact control link.

See [architecture](docs/architecture.md), [product contract](docs/product.md), the [AWS deployment guide](deploy/aws/README.md), and the [Crabbox appliance profile](deploy/crabbox-profile/README.md) for implementation detail and the identity-aware execution contract.
