# Product contract

Crabhelm is the control plane for identity-aware OpenClaw teammates. It governs who requested work, which persona handled it, whose authority may be used, which capabilities are available, where the runtime executes, and what evidence is retained.

A **Claw** is one independently deployed OpenClaw core. A **persona** is the managed agent identity presented to people. A **requester** is the human who initiated work. An **actor** is the identity whose authority a governed tool call uses. These identities may coincide, but Crabhelm must never infer that they do.

The production build implements fleet placement, bootstrap, policy rollout, readiness, evidence-driven removal, principal sessions, personas, actor policy, approved skills, encrypted OAuth connections, signed one-time invocation grants, confirmation-bound writes, a controlled GitHub wrapper, and identity-complete audit export.

## Control-plane backend

An installation selects either the reference Cloudflare backend or the AWS backend. Cloudflare uses Workers, Durable Objects, R2, Queues, and Cloudflare Access. AWS uses a singleton ECS/Fargate service, an Application Load Balancer with OIDC and WebSockets, PostgreSQL RDS, private S3 buckets, and SQS.

The backends are separate fleet boundaries. They do not form an active-active pair, replicate state, share runtime sockets, or reuse signing material. The AWS desired task count remains one until distributed coordinator ownership and cross-task socket routing are implemented.

The disposable AWS FakeCo contract is a locked, manually invoked deployment profile. It requires protected `main`, separate deploy/teardown GitHub Environments and exact OIDC subjects, external digest-pinned ECR, bounded workload and CloudFormation roles, deterministic tags, and standard stack deletion with a retained-resource manifest. It never treats `ProvisionService=false` as a repository bootstrap and never accepts secret values as foundation inputs.

## Interaction models

- **Personal agent:** one user's persona; requester authority by default.
- **Shared persona:** administrator-created team, channel, or workflow identity; explicit actor policy required.
- **Profile assistant:** owner-published work context; external access always uses the requester's authority, never the profile owner's private authority.

Every invocation carries an immutable requester/persona/actor tuple. The runtime may request an actor permitted by policy; it may not choose or substitute authority from prompt text.

## Actor policy

Crabhelm supports three explicit modes:

- `invoker`: use requester authority only;
- `service`: use one administrator-managed service identity only;
- `invoker-with-service-fallback`: try requester authority, then a named service identity only when policy permits the exact capability and records the fallback.

Only administrators may create shared personas, bind them to shared ingress, or enable service authority. Profile assistants are fixed to `invoker` for external access.

## Governed capabilities

Agents do not receive unrestricted provider CLIs or durable provider credentials. A tool call crosses a controlled wrapper that validates arguments, evaluates requester/persona/actor policy, checks confirmation requirements, requests an audience- and action-scoped short-lived credential, redacts output, and emits an audit event.

Long-lived OAuth grants remain in a dedicated encrypted vault. Agent runtimes, control-plane metadata state, bootstrap bundles, logs, and read-only agent artifacts must not contain them.

Identity, baseline instructions, approved skills, tool policy, and Gateway configuration are versioned control-plane artifacts mounted or materialized read-only. Runtime-created memory and sessions remain writable but cannot alter those guardrails.

## Confirmation

Policy classifies governed capabilities by risk. External messages, production writes, access changes, destructive operations, and other configured actions require confirmation bound to requester, persona, actor, capability, target, arguments digest, and expiry. Replaying a confirmation for another action must fail.

## Audit

Each meaningful decision records timestamp, requester, persona, selected actor, actor mode, capability, target, policy version, confirmation state, outcome, runtime identity, and correlation id. Content, prompts, model replies, credential values, and unrestricted provider responses are excluded by default.

## Operator flow

Authenticate through the configured operator identity layer (Cloudflare Access or ALB OIDC) → choose a fixed placement target → choose intended user metadata and inference policy → create → watch provider, Gateway, desired/observed router and model, model-auth, and outbound runtime evidence converge → bind an approved Slack conversation to its persona.

The intended user is materialized as a principal and personal persona. Slack requester identities merge with console identities by canonical email. The organization Slack token remains in the control plane and never becomes a child credential or OAuth grant.

For ClawRouter fleets, the drawer shows the desired origin, tenant-scoped policy and credential ids, allowed providers, model, and credential epoch beside observed router health, credential scope, catalog readiness, exact-model route proof, budget, and aggregate request/token/cost counters. Operators may fetch a bounded runtime diagnostic summary through the authenticated API; it is redacted before persistence and never includes prompts, completions, messages, tool output, or credentials.

## Readiness

The console separates provider allocation, control link, Gateway version, policy generation, model authentication, and Slack state. Production readiness requires:

- exact provider identity exists;
- child Gateway readiness marker exists;
- desired model is written into child config;
- a live `openclaw agent` turn returns the expected answer through that model;
- when ClawRouter is configured, the child reports the exact desired ClawRouter base URL, env-backed `CLAWROUTER_API_KEY` reference, and `clawrouter/<catalog-model-id>` identity; ClawRouter reports matching explicit provider scope/catalog health; `models status --probe --probe-provider clawrouter --probe-max-tokens 8 --json` succeeds; and the exact-model canary returns `CLAWROUTER_CANARY_OK` through that route;
- desired and observed policy generations agree;
- any enabled channel has live evidence from an adapter capable of supplying it.

Synthetic or echoed evidence must never render as ready.

## Placement

Targets are administrator policy. Each pins adapter, region, appliance profile, TTL, and idle timeout. The create API accepts a target id, not free-form infrastructure controls. Adding another child-compute provider means implementing the provider contract and registering another fixed target; it does not change the installation's selected Cloudflare or AWS control-plane backend.

The production target is deployment-specific and configured outside public source. The data model and provider router are not Crabbox-specific.

Each claw may override the fleet appliance with explicit manifest, archive, and bootstrap-Node SHA-256 values. Changing them keeps the allocated workspace, advances desired generation, and reinstalls until the complete release identity plus live inference converge. Canary one claw and verify readiness before changing the fleet default or applying the release elsewhere; set the override to `null` afterward to resume following fleet defaults.

## Policies

Policies are immutable versions of managed fields: primary/fallback inference models, Slack enabled state, native DM/group policy, and child log level. Preview is generation-fenced. Multi-claw rollout requires an explicit canary; an unconverged canary stops the remainder. Applying an older version is rollback.

Credentials, OAuth state, pairing, sessions, memory, and agent directories are outside managed policy.

In a ClawRouter fleet every claw has first-class desired router state derived from the fleet origin, tenant, and provider allowlist plus the claw's models and optional budget. Crabhelm owns the per-claw policy/credential lifecycle and credential epoch; the separate ClawRouter installation owns upstream provider secrets and inference. Rotating an epoch derives a replacement scoped child credential, registers only its hash, and requires a fresh routed-inference proof.

Per-claw observability may export traces and metrics to one administrator-managed HTTPS OTLP base endpoint through the pinned `diagnostics-otel` plugin; Crabhelm appends the standard `/v1/traces` and `/v1/metrics` signal paths. Endpoint, service name, signals, sample rate, and flush interval are versioned desired state. OTLP log export remains disabled under the metadata-only contract.

An installation may also expose authenticated Prometheus-compatible fleet metrics on the runtime host. Those metrics are aggregate and metadata-only: lifecycle phase counts, Gateway readiness, routed-inference proof count, and ClawRouter request/token/cost counters, without per-claw labels or content.

## Removal

Typed-name confirmation starts a staged removal. Crabhelm disables ingress, verifies zero active work twice across a quiet period, releases the exact provider workspace, confirms absence, revokes the exact control link, and retains redacted audit evidence.

## Current implementation scope

- Alternative control-plane deployments: the reference Cloudflare Worker, Durable Object, R2, Queue, and Access stack; or a separate singleton ECS/Fargate, ALB, PostgreSQL RDS, S3, SQS, and ALB OIDC stack on AWS.
- Real Crabbox allocation and deletion.
- Pinned OpenClaw `2026.6.11` direct-reference install with exact-model live inference proof; routed FakeCo requires a separately digest-pinned appliance from the landed ClawRouter provider-overlay commit.
- Optional first-class ClawRouter policies, epoch-scoped child credentials, desired/observed route health, bounded usage metadata, and exact-route live inference proof; deployment-specific live proof is still required.
- Signed central Slack ingress with DM/app-mention events, persona bindings, threaded delivery, and one-click confirmations.
- GitHub organization import remains disabled in the Cloudflare runtime.
- Backend-native operator authentication through verified Cloudflare Access JWTs or signed ALB OIDC assertions, with signed principal sessions retained for operations.
- GitHub OAuth authorization-code connection, repository/issue reads, and confirmed issue comments through the controlled wrapper.
- Per-claw encrypted turn queues, short-lived credential rotation, health, and reconnect over one authenticated outbound WebSocket; no tunnel or inbound child service.
- AES-GCM OAuth vault, per-claw one-use grant coordination, backend-queue audit archive, and read-only managed runtime specification.
- Metadata-only OTLP trace/metric configuration and an optional authenticated Prometheus-compatible fleet endpoint.

## Remaining production expansion

1. Add more deployment adapters and durable runtime volumes for substrates whose instances expire.
2. Add more provider wrappers and, where providers support it, exchange durable grants for provider-native short-lived tokens.
3. Move Cloudflare lifecycle reconciliation into per-claw Durable Objects for larger fleets; distribute coordinator ownership and socket routing before scaling AWS beyond one task.
4. Add SIEM delivery, step-up confirmation, and substrate-native workload attestation.

The local simulator is test-only and visibly labeled.
