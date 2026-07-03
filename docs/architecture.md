# Architecture

Crabhelm is a Cloudflare-hosted control plane. It does not run inside an OpenClaw parent, require a permanent controller VM, or accept inbound tunnels.

```text
Slack / web / internal surfaces
             |
             v
Cloudflare edge: authentication, ingress, policy, persona routing
             |
             +---- fleet index + policy Durable Objects
             +---- per-claw reconciliation Durable Objects
             +---- private R2: signed agent artifacts and appliances
             +---- audit Queue -> R2 / approved SIEM
             |
             v
deployment adapter -> isolated OpenClaw runtime on any approved substrate
             |
             v
signed invocation grant -> governed tool wrapper -> token broker / OAuth vault
```

Cloudflare is the global control plane, not the agent compute substrate. Agent runtimes initiate outbound HTTPS/WSS calls; Crabhelm requires no inbound tunnel or permanent parent VM.

## Cloudflare control plane

The Worker owns HTTP authentication, static assets, bootstrap delivery, security headers, control-plane routing, and the bounded GitHub wrapper. One named organization Durable Object owns fleet and governance records. A separate Durable Object instance per claw atomically registers and consumes one-time invocation grants and tracks active governed runs.

Audit fan-out leaves the request path through a Queue and lands in a dedicated R2 archive. Lifecycle reconciliation remains in the organization object; invocation replay protection and run coordination are already sharded by claw. Moving lifecycle reconciliation into the same per-claw atom is the remaining scale step.

Durable Object storage uses namespaced key-value records with transaction boundaries matching the existing registry contract. Fleet state survives Worker isolates and deployments. Audit storage is bounded and metadata-only.

The private R2 bucket stores a digest-pinned `openclaw-core` appliance. The public bootstrap route never exposes the bucket directly: a child-specific HMAC token gates the installer, bundle, and credential response, all with `no-store` headers.

## Identity-aware invocation

Ingress accepts the Cloudflare operator credential or a signed, eight-hour principal session minted by an administrator. It resolves one administrator-approved persona. Before governed tool execution, Crabhelm issues a five-minute signed invocation grant containing:

- requester, persona, permitted actor mode, and optional service identity;
- claw and runtime audience;
- allowed capability set and policy version;
- invocation correlation id, issued-at, expiry, target, and exact argument digest;
- confirmation requirements, without credential material.

The per-claw coordinator registers the grant JTI before release and consumes it atomically once. Prompt text, channel metadata, and runtime-supplied identity claims are never authority. Substrate-native workload attestation remains required before exposing the runtime-token ingress beyond the current bootstrap channel.

## Governed tool path

The agent runtime proposes a capability call; it does not receive a durable OAuth token. The controlled GitHub wrapper verifies and consumes the invocation grant, recomputes capability-specific arguments, enforces actor and confirmation policy, decrypts the selected credential only for the outbound provider request, and returns a bounded result projection. Long-lived grants remain as AES-GCM envelopes in a dedicated private R2 vault; Durable Object state contains metadata only.

Wrappers may run on Cloudflare or an approved internal substrate. Cloudflare-hosted components use bindings for internal calls where possible; external brokers use outbound mTLS and workload-bound signed requests. No component exposes the vault directly to an agent runtime.

Each decision emits identity-complete audit metadata. High-volume audit delivery uses a Queue and approved durable sink; reconciliation state retains only bounded operational evidence.

## Read-only agent specification

Persona identity, baseline instructions, skill manifests, capability policy, and Gateway configuration are immutable versioned artifacts owned by Crabhelm. The appliance verifies their digest and materializes them read-only. Runtime memory, sessions, and work products remain separate writable state. An agent cannot promote a skill, rewrite its identity, or broaden its own tool policy.

## Deployment adapters

`ChildCoreProvider` is the placement boundary:

- `provision` allocates an isolated resource;
- `inspect` requires live readiness evidence;
- `disable` proves ingress is closed;
- `drain` proves active work is zero;
- `remove` releases and confirms the exact provider identity;
- `revokeControl` removes or confirms absence of the exact control link.

`RoutedChildCoreProvider` binds an administrator-defined target id to an exact profile and region. Browser requests select only the target id; they cannot override provider, class, controller URL, executable command, TTL, or credentials.

The current production adapter uses `https://crabbox.openclaw.ai` and target `aws-us-east`. Crabbox creates the workspace and exposes a bearer-authenticated server-to-server terminal. Crabhelm uses Cloudflare's outbound HTTPS WebSocket upgrade to inspect that terminal; no inbound child endpoint exists.

## Agent bootstrap and readiness

1. Registry persists desired state and stable child UUID.
2. Crabbox creates `crabhelm-<slug>` with an idempotency key equal to that workspace id.
3. The workspace fetches a private installer from Crabhelm using its deterministic HMAC token.
4. Installer verifies the manifest and every artifact, activates child-local credentials, writes the exact desired model, starts a loopback-only OpenClaw Gateway, and writes a readiness marker.
5. Reconciliation attaches through Crabbox, requires exact terminal sentinel lines, writes the exact desired model again, restarts the Gateway, and runs a real `openclaw agent` turn.
6. Only the exact expected model response creates the inference marker. Crabhelm then reports `ready`, `authReady: true`, and `liveInferenceProbe: true`.

Allocation, echoed command text, HTTP success, and a process existing are not sufficient readiness evidence.

## State and trust boundaries

One claw equals one provider resource, OpenClaw Gateway, state root, credential file, session store, memory, and OS identity. The control plane stores lifecycle identifiers, desired policy, bounded health evidence, and audit metadata. It does not store prompts, model replies, messages, tool output, child credentials, or opaque upstream bodies.

Operator token, Crabbox token, bootstrap/session/invocation/runtime signing secrets, the OAuth vault master key, and model credentials are Cloudflare Worker secrets. The operator token authenticates only control-plane API requests and is never forwarded to children. Child credential delivery is scoped by the HMAC bootstrap token and occurs only during appliance installation. Admission closes unless all required signing and vault material passes local shape checks.

Model credentials still use the fixed bootstrap path because OpenClaw itself calls the model backend. Provider-tool OAuth credentials use the governed vault and never enter the claw. The current GitHub broker and wrapper share one Worker trust boundary; splitting the broker into a separate workload-identity service is optional hardening for additional high-risk providers.

## Removal

Removal is staged and retryable: prove ingress disabled, observe zero active runs across a quiet interval, release the exact provider identity, confirm provider absence, revoke or confirm absence of the exact control link, then mark the registry record deleted. A missing or malformed evidence step fails closed.

## Local simulator

The simulator remains a test utility for registry, reconciliation, and UI development. Production Wrangler configuration always constructs the real Crabbox provider and never selects the simulator.
