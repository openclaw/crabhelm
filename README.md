# Crabhelm

Cloudflare-hosted, identity-aware control plane for independently deployed OpenClaw teammates.

Crabhelm itself runs as a Cloudflare Worker. One Durable Object owns fleet state, reconciliation, immutable policies, and bounded audit metadata. Private, digest-pinned agent appliances live in R2. Deployment adapters create isolated agent machines wherever an administrator configures them; the first production adapter is Crabbox targeting AWS US East.

No inbound tunnel or permanent parent VM is required. The Worker calls provider APIs outbound, and every agent keeps its own OpenClaw Gateway, state root, credentials, sessions, memory, and OS identity.

The execution plane separates requester, persona, and actor; governs skills and tool capabilities; issues signed one-time invocation grants; keeps durable OAuth credentials in an encrypted R2 vault; requires argument-bound confirmation for external writes; delivers managed identity and skills read-only; and records identity-complete audit evidence through a Cloudflare Queue and R2 archive. The first controlled provider wrapper supports bounded GitHub repository/issue reads and confirmed issue comments.

## Production

- Console: <https://crabhelm.openclaw.ai>
- Runtime: Cloudflare Workers + Durable Objects
- Appliance store: private Cloudflare R2 bucket `crabhelm-appliances`
- Current deployment target: `aws-us-east` through Crabbox
- Operator access: Cloudflare Access identity; no shared operator bearer
- Automation access: account-scoped Cloudflare service binding; no public administration endpoint
- Team ingress: one signed Slack app at `crabhelm-runtime.openclaw.ai`; personas bind approved workspaces/channels to claws
- Provider delegation: GitHub OAuth grants stay encrypted in R2 and are used only by the governed edge wrapper
- Agent bootstrap: deterministic per-agent HMAC token, short private R2 delivery path, outbound HTTPS/WSS only

The current Crabbox target creates a real workspace, installs digest-pinned OpenClaw and Crabhelm artifacts, starts a loopback Gateway, runs a real model challenge, then starts the outbound runtime bridge. A claw reports ready only after the exact inference response and bridge launch succeed. Simulator code remains for tests and local domain development; production never selects it.

## Deploy

Requirements: Node.js 22+, pnpm, Wrangler authenticated to the OpenClaw Cloudflare account.

```bash
pnpm install
pnpm check
pnpm worker:deploy
```

Required Worker secrets:

```text
BOOTSTRAP_SIGNING_SECRET
CRABBOX_TOKEN
OPENAI_API_KEY
SESSION_SIGNING_SECRET
INVOCATION_SIGNING_SECRET
RUNTIME_SIGNING_SECRET
VAULT_MASTER_KEY
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
GITHUB_OAUTH_CLIENT_SECRET
```

Signing secrets must contain at least 32 bytes. `VAULT_MASTER_KEY` is a base64url-encoded 32-byte AES key. `MODEL_SIGNING_SECRET` (≥32 bytes) is additionally required only when the edge model proxy is enabled (`CRABHELM_MODEL_PROXY=on`).

`GITHUB_OAUTH_CLIENT_ID` and Cloudflare Access team/audience settings are non-secret Worker variables. Slack sends signed events to `https://crabhelm-runtime.openclaw.ai/slack/events` and interactions to `https://crabhelm-runtime.openclaw.ai/slack/interactions`. The GitHub OAuth callback is `https://crabhelm.openclaw.ai/api/oauth/github/callback`. Use `wrangler secret put NAME`; never place secret values in `wrangler.jsonc`, `.dev.vars`, logs, or registry state.

After rotating a delivered secret (for example `OPENAI_API_KEY`), bump the affected claw's credential epoch with the **Rotate credentials** drawer button or `POST /api/claws/<id>/rotate-credentials`. The claw performs one release-pinned in-place reinstall that re-fetches `credentials.env`, then must pass the live inference probe again before it reports ready.

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
pnpm exec wrangler r2 object put crabhelm-appliances/releases/$APPLIANCE_ARCHIVE_SHA256.tgz \
  --file /tmp/crabhelm-bundle.tgz --remote
```

Verify the remote archive bytes, then update both `APPLIANCE_ARCHIVE_SHA256` and `APPLIANCE_MANIFEST_SHA256` to the generated digests before deploying the Worker.

## Local development

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4177>. Local development uses an explicitly labeled simulator. Production Wrangler configuration always uses the real Crabbox adapter.

## Edge model proxy (experimental)

By default a claw is delivered the raw `OPENAI_API_KEY`. Setting the `CRABHELM_MODEL_PROXY` Worker var to `on` (and putting the `MODEL_SIGNING_SECRET` secret) instead delivers a per-claw, audience-bound model token plus an edge base URL, and reroutes the child's OpenClaw OpenAI provider through `https://crabhelm-runtime.openclaw.ai/model/v1`. The Worker verifies the token, strips the caller's authorization, injects the real provider key, and forwards to a single fixed upstream over an allowlisted set of endpoints. The raw provider key never reaches the agent VM, and each claw's access is independently scoped and bounded to its substrate lifetime rather than sharing one fleet-wide credential.

This is experimental and default-off. First enablement requires an appliance built from this version; after that appliance is pinned, change modes by rotating each claw's credential epoch so the managed provider base URL and credential are reinstalled together. The proxy continues accepting previously issued model tokens while new issuance is off, allowing a rolling rollback; keep `MODEL_SIGNING_SECRET` configured through the longest previously issued token lifetime (four hours by default, at most 24 hours). Confirm the existing live inference probe on staging before enabling in production.

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

## Testing

`pnpm check` runs both test tiers. `pnpm test` runs the fast Node domain suite (`node:test`). `pnpm test:workers` runs the Worker and both Durable Objects inside workerd via `@cloudflare/vitest-pool-workers` (`tests/workers/`), covering router host-splitting, the Access auth gate, SQLite-backed control-plane state, and the hibernatable runtime-bridge reconnect path against the real runtime.

## Safety boundaries

- Placement target, region, profile, TTL, and idle timeout are administrator policy—not browser-supplied provider overrides.
- A provider resource becomes ready only from live child evidence; allocation alone is not readiness.
- Registry and audit state exclude prompts, messages, tool output, credential values, and opaque provider response bodies.
- Bootstrap endpoints require a per-agent HMAC bearer, return `no-store`, and expose only that agent's fixed appliance and credentials.
- Slack signing is verified before parsing; Cloudflare Access JWTs are verified against the team JWKS and application audience.
- Access-authenticated clients and enrolled runtimes may redeem governed grants; actor policy, argument digest, expiry, and the one-use fence still apply.
- Runtime turns, credential rotation, health, and reconnect use one authenticated outbound WebSocket to a per-claw Durable Object; reset generations abort active process groups, and persona-bound job payloads remain encrypted at rest.
- The owner-only runtime workload credential is audience-bound, expires after ten minutes, rotates through a one-use mint fence with encrypted idempotent response replay, and is never inherited by model/tool processes; persistence permits bridge crash and host restart recovery.
- The OpenClaw Gateway runs as a dedicated unprivileged service account. A root-owned nftables service restricts its workspace to loopback, DNS, NTP, DHCP, and TCP 443, blocks cloud instance metadata before credentials land, and must pass live-rule verification before readiness. Enforcement is fail-closed by default; `CRABHELM_EGRESS_LOCKDOWN=off` is an explicit operational escape hatch.
- With the edge model proxy enabled the agent never holds the raw provider key: it presents a per-claw, audience-bound model token that the Worker exchanges for the real key against a single fixed, endpoint-allowlisted upstream.
- Removal remains evidence-driven: disable ingress, drain active work, release the exact provider identity, confirm absence, then revoke the exact control link.

See [architecture](docs/architecture.md), [product contract](docs/product.md), and the [Crabbox appliance profile](deploy/crabbox-profile/README.md) for implementation detail and the identity-aware execution contract.
