# Architecture

Crabhelm is an identity-aware control plane with Cloudflare and AWS deployment backends. It does not run inside an OpenClaw parent or accept inbound tunnels.

```text
Slack / web / internal surfaces
             |
             v
selected control-plane backend: authentication, ingress, policy, persona routing
             |
             +---- Cloudflare: Worker + Durable Objects + R2 + Queue
             |
             +---- AWS: singleton ECS task + RDS + S3 + SQS
             |
             v
deployment adapter -> isolated OpenClaw runtime on any approved substrate
             |
             v
signed invocation grant -> governed tool wrapper -> token broker / OAuth vault
```

The selected backend is the control plane, not the agent compute substrate. Agent runtimes initiate outbound HTTPS/WSS calls; Crabhelm requires no inbound tunnel to the child or permanent parent VM.

## Backend model

One installation uses one control-plane backend and owns one fleet. Cloudflare and AWS deployments implement the same service contracts but do not replicate control-plane state, coordinate sockets, or share secrets. Running them active-active for one fleet is unsupported.

The Cloudflare deployment remains the reference implementation. The AWS deployment is a separate operational option for organizations that want the control plane in their AWS account while retaining Cloudflare-managed DNS or other edge services.

## Cloudflare control plane

The Worker owns Cloudflare Access authentication, static assets, signed Slack ingress, bootstrap delivery, security headers, control-plane routing, and the bounded GitHub wrapper. One named organization Durable Object owns fleet and governance records. A separate Durable Object instance per claw owns its outbound runtime health socket, authenticated HTTPS queue, encrypted turn state, replay fence, one-time invocation grants, and active governed runs.

Audit fan-out leaves the request path through a Queue and lands in a dedicated R2 archive. Lifecycle reconciliation remains in the organization object; invocation replay protection and run coordination are already sharded by claw. Moving lifecycle reconciliation into the same per-claw atom is the remaining scale step.

Durable Object storage uses namespaced key-value records with transaction boundaries matching the existing registry contract. Fleet state survives Worker isolates and deployments. Audit storage is bounded and metadata-only.

The private R2 bucket stores a digest-pinned `openclaw-core` appliance. The public bootstrap route never exposes the bucket directly: a child-specific HMAC token backed by a signing secret of at least 32 bytes gates the installer, bundle, and credential response, all with `no-store` headers.

## AWS control plane

The AWS backend runs the portable HTTP and control-plane services as one long-lived Node.js task on ECS/Fargate. An internet-facing Application Load Balancer terminates HTTPS, applies OIDC authentication to the console host, and forwards the separately authenticated runtime host with native WebSocket support. The server verifies the signed ALB identity assertion, expected load-balancer signer, OIDC client, issuer, and expiry before resolving a principal, then maps configured emails and groups to the administrator role. The OIDC provider remains responsible for organization admission.

PostgreSQL on RDS stores organization state and per-claw coordinator records. Transactions, advisory locks, conditional updates, and delivery leases replace Durable Object transaction and alarm semantics. Private S3 buckets store appliances, encrypted OAuth envelopes, and audit archives; SQS carries audit events to the archive poller.

The ECS service intentionally has a desired count of one. Deployment stops the old task before starting its replacement, and runtime bridges reconnect after the socket closes. More than one task is unsupported until coordinator ownership, cross-task signaling, and socket routing are distributed. The workload execution and task roles require an account-foundation permissions boundary and controlled IAM path; image, log, secret, S3, and SQS permissions are scoped to the exact runtime calls.

The locked FakeCo deployment profile is an operator layer over the canonical template. It validates one account/Region, external digest-pinned ECR, exact GitHub OIDC and CloudFormation role identities, deterministic tags, bounded RDS/log retention, and live-template-bound standard-only teardown. Account organization, identity, trust, boundary policy, service role, secrets/KMS, artifact bucket, ECR, ACM/DNS, and cost controls remain outside the application stack. The profile preserves a single NAT and is deliberately non-HA; a free S3 gateway endpoint removes application S3 and regional ECR layer traffic from the NAT path. See the [AWS deployment guide](../deploy/aws/README.md).

## ClawRouter inference boundary

ClawRouter is a separate installation, not another Crabhelm backend or an embedded proxy. Crabhelm owns per-claw desired inference policy and lifecycle; ClawRouter owns upstream provider credentials, catalog/routing, budget enforcement, and inference execution. The two services must not share control-plane state, signing material, or upstream secrets.

For each routed claw, Crabhelm deterministically derives a stable policy/credential id from the child UUID. A required fleet map binds each full `clawrouter/<catalog-model-id>` ref to its canonical ClawRouter catalog provider id; this handles non-identical pairs such as `google-gemini`/`google`, `aws-bedrock`/`bedrock`, and `local-openai`/`local` without widening credential scope. Reconciliation uses ClawRouter's OpenAI-compatible administrative contract to upsert an enabled provider/tenant/budget policy with request-content retention disabled, then registers only the SHA-256 hash of an epoch-derived credential suffix. The complete `clawrouter-live-<credential-id>-<secret>` token is delivered only through that child's authenticated bootstrap path. Credential rotation advances the claw epoch, registers the replacement hash first, reinstalls the child credential, and invalidates prior readiness proof.

Observed inference state is a bounded projection of ClawRouter health, credential scope, catalog availability, configured model, budget, and aggregate usage counters. Crabhelm does not retain ClawRouter event records or any prompt, completion, message, tool output, credential, or upstream body. Both bootstrap paths set the static `X-ClawRouter-Project-Id` provider header to the immutable raw claw UUID, preserve unrelated explicit headers, and remove stale explicit Agent/Session/Request attribution so the OpenClaw overlay supplies dynamic values. This static attribution participates in managed drift hashing but never becomes a Prometheus label. A routed claw becomes ready only after the Gateway reports the exact `models.providers.clawrouter.baseUrl`, uses the env-backed `models.providers.clawrouter.apiKey` reference to `CLAWROUTER_API_KEY`, reports `/readyz`, completes the bounded `models status --probe` for provider `clawrouter`, and returns `CLAWROUTER_CANARY_OK` from an `openclaw agent --model clawrouter/<catalog-model-id>` canary. The provider plugin owns the credential-scoped catalog; Crabhelm never writes a `models[]` workaround.

## Identity-aware ingress and invocation

Browser ingress is protected by Cloudflare Access on Cloudflare or ALB OIDC on AWS. The control-plane service serves console APIs and assets only on the configured HTTPS console origin, rejects cross-site browser mutations before forwarding, and verifies the backend identity assertion before resolving a canonical email principal. Runtime APIs, Slack ingress, private bootstrap delivery, and the optional authenticated Prometheus endpoint are accepted only on the separate configured HTTPS runtime origin. There is no shared operator bearer.

Non-interactive fleet administration uses a named Cloudflare service-binding RPC entrypoint. It is reachable only by another Worker explicitly bound inside the Cloudflare account, exposes a narrow state/persona/runtime/removal surface, and injects the same administrator role and audit principal used by the control plane. It is not routed to a public hostname and does not accept a bearer token. Its production probe posts a labeled Slack parent, routes an encrypted turn through the bound persona and remote runtime, then reports metadata-only execution and delivery status.

Slack uses one organization app. The edge verifies Slack's timestamped HMAC signature over the raw body before parsing it, resolves the requester through Slack, and routes only through an administrator-approved workspace/channel persona binding. The runtime never receives Slack credentials.

For every accepted turn, the per-claw coordinator encrypts the prompt with AES-GCM and binds it to the job id. The isolated runtime claims, acknowledges, and completes one persona-bound job over one authenticated outbound WebSocket, which also carries health, reconnect, and credential rotation. The runtime invokes the real local OpenClaw Gateway through `openclaw agent`; the turn process does not receive a model-provider credential. Crabhelm's owner-only workload credential expires after ten minutes, rotates through a one-use mint fence, persists only for restart recovery, and is not inherited by turn processes. The encrypted refresh response is replayable for the old credential's remaining lifetime, so a control-plane restart after consumption cannot strand the runtime. Reset generations sent over the same socket abort the active process group when an administrator resets a runtime. Before governed tool execution, Crabhelm issues a five-minute signed invocation grant containing:

- requester, persona, permitted actor mode, and optional service identity;
- claw and runtime audience;
- allowed capability set and policy version;
- invocation correlation id, issued-at, expiry, target, and exact argument digest;
- confirmation requirements, without credential material.

The per-claw coordinator registers the grant JTI before release and consumes it atomically once, using Durable Object storage on Cloudflare or transactional PostgreSQL state on AWS. Prompt text and runtime-supplied identity claims are never authority. Runtime and turn tokens are audience-bound; the turn fixes requester, persona, claw, and Slack response location.

## Governed tool path

The agent runtime proposes a capability call; it does not receive a durable OAuth token. The controlled GitHub wrapper verifies and consumes the invocation grant, recomputes capability-specific arguments, enforces actor and confirmation policy, decrypts the selected credential only for the outbound provider request, and returns a bounded result projection. Long-lived OAuth grants remain as AES-GCM envelopes in the selected backend's dedicated private object-store vault; control-plane state contains metadata only. GitHub connects through the OAuth authorization-code flow; direct credential upload is disabled.

Wrappers run inside the selected control-plane trust boundary or on an approved internal substrate. Backend-native bindings or workload identity protect internal calls where possible; external brokers use outbound mTLS and workload-bound signed requests. No component exposes the vault directly to an agent runtime.

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

The production adapter uses a deployment-specific Crabbox control URL and target identifier kept outside public source. Crabbox creates the workspace and exposes a bearer-authenticated server-to-server terminal. Crabhelm uses its backend-specific outbound HTTPS WebSocket dialer to inspect that terminal; no inbound child endpoint exists. The runtime separately initiates one authenticated outbound WebSocket to the configured runtime host, so deployment does not require Cloudflare Tunnel or an equivalent inbound child tunnel.

## Agent bootstrap and readiness

1. Registry persists desired state and stable child UUID.
2. Crabbox creates `crabhelm-<slug>` with an idempotency key equal to that workspace id.
3. The workspace fetches a private installer from Crabhelm using its deterministic HMAC token.
4. Installer verifies the manifest and every artifact, activates child-local model/runtime credentials, writes the exact desired model and optional ClawRouter origin, starts a loopback-only OpenClaw Gateway, installs the runtime-bridge launcher, and writes a Gateway readiness marker.
5. Reconciliation attaches through Crabbox, requires exact terminal sentinel lines, writes the exact desired model and router origin again, restarts the Gateway, and runs a real `openclaw agent` turn.
6. Only the exact expected model response starts the runtime bridge and creates the inference marker. The bridge exchanges its ten-minute workload credential through the redacted authorization header for a 30-second, one-use connection ticket. Only that consumed ticket enters the WebSocket subprotocol; the workload credential rotates through a separate one-use mint fence with encrypted idempotent response replay.

Allocation, echoed command text, HTTP success, and a process existing are not sufficient readiness evidence.

## State and trust boundaries

One claw equals one provider resource, OpenClaw Gateway, state root, credential file, session store, memory, and OS identity. The control plane stores lifecycle identifiers, desired policy, bounded health evidence, and audit metadata. It does not store prompts, model replies, messages, tool output, child credentials, or opaque upstream bodies.

Crabbox credentials, Slack credentials, GitHub OAuth client secret, bootstrap/session/invocation/runtime signing secrets, the OAuth vault master key, and inference-control credentials are backend-managed secrets: Worker secrets on Cloudflare and Secrets Manager values injected into ECS on AWS. Control-plane users authenticate through Cloudflare Access or ALB OIDC; there is no shared operator-token bypass. In direct mode the configured model credential enters the child. In ClawRouter mode only the child's scoped router credential enters it; the ClawRouter admin credential and upstream provider secrets do not. Child credential delivery is scoped by the HMAC bootstrap token and occurs only during appliance installation. Admission closes unless all required signing and vault material passes local shape checks.

Inference credentials still use the fixed bootstrap path because OpenClaw itself calls the configured inference boundary. Provider-tool OAuth credentials use the governed vault and never enter the claw. The current GitHub broker and wrapper share one control-plane trust boundary; splitting the broker into a separate workload-identity service is optional hardening for additional high-risk providers.

## Removal

Removal is staged and retryable: prove ingress disabled, observe zero active runs across a quiet interval, release the exact provider identity, confirm provider absence, revoke or confirm absence of the exact control link, then mark the registry record deleted. A missing or malformed evidence step fails closed.

## Local simulator

The simulator remains a test utility for registry, reconciliation, and UI development. Production Cloudflare and AWS configurations construct the real Crabbox provider and never select the simulator.
