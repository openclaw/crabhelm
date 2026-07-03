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
- Operator access: bearer token stored in 1Password; never sent to agent machines
- Agent bootstrap: deterministic per-agent HMAC token, short private R2 delivery path, outbound HTTPS/WSS only

The current Crabbox target creates a real workspace, installs pinned OpenClaw and Crabhelm artifacts, installs child-local credentials, starts a loopback Gateway, and reports ready only after terminal evidence confirms the Gateway marker. Simulator code remains for unit tests and local domain testing; production configuration does not select it.

## Deploy

Requirements: Node.js 22+, pnpm, Wrangler authenticated to the OpenClaw Cloudflare account.

```bash
pnpm install
pnpm check
pnpm worker:deploy
```

Required Worker secrets:

```text
OPERATOR_TOKEN
BOOTSTRAP_SIGNING_SECRET
CRABBOX_TOKEN
OPENAI_API_KEY
SESSION_SIGNING_SECRET
INVOCATION_SIGNING_SECRET
RUNTIME_SIGNING_SECRET
VAULT_MASTER_KEY
```

Signing secrets must contain at least 32 bytes. `VAULT_MASTER_KEY` is a base64url-encoded 32-byte AES key.

Optional Slack secrets are `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`; configure both or neither. Use `wrangler secret put NAME`. Do not place secret values in `wrangler.jsonc`, `.dev.vars`, logs, or the registry.

Build and upload a reviewed appliance after guest-profile changes:

```bash
deploy/crabbox-profile/build-bundle.sh \
  --node-tarball /absolute/node-v22.23.1-linux-x64.tar.xz \
  --openclaw-tarball /absolute/openclaw.tgz \
  --slack-tarball /absolute/slack.tgz \
  --output /tmp/crabhelm-bundle
tar -C /tmp -s '|^crabhelm-bundle|bundle|' \
  -czf /tmp/crabhelm-bundle.tgz crabhelm-bundle
wrangler r2 object put crabhelm-appliances/openclaw-core/bundle.tgz \
  --file /tmp/crabhelm-bundle.tgz --remote
```

Update `APPLIANCE_MANIFEST_SHA256` to the generated manifest digest before deploying the Worker.

## Local development

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4177>. Local development uses the same domain and UI with an explicitly labeled simulator unless Crabbox configuration is supplied.

## Safety boundaries

- Placement target, region, profile, TTL, and idle timeout are administrator policy—not browser-supplied provider overrides.
- A provider resource becomes ready only from live child evidence; allocation alone is not readiness.
- Registry and audit state exclude prompts, messages, tool output, credential values, and opaque provider response bodies.
- Bootstrap endpoints require a per-agent HMAC bearer, return `no-store`, and expose only that agent's fixed appliance and credentials.
- Removal remains evidence-driven: disable ingress, drain active work, release the exact provider identity, confirm absence, then revoke the exact control link.

See [architecture](docs/architecture.md), [product contract](docs/product.md), and the [Crabbox appliance profile](deploy/crabbox-profile/README.md) for implementation detail and the identity-aware execution contract.
