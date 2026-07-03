# Product contract

Crabhelm is the Cloudflare control plane for identity-aware OpenClaw teammates. It governs who requested work, which persona handled it, whose authority may be used, which capabilities are available, where the runtime executes, and what evidence is retained.

A **Claw** is one independently deployed OpenClaw core. A **persona** is the managed agent identity presented to people. A **requester** is the human who initiated work. An **actor** is the identity whose authority a governed tool call uses. These identities may coincide, but Crabhelm must never infer that they do.

The production build implements fleet placement, bootstrap, policy rollout, readiness, evidence-driven removal, principal sessions, personas, actor policy, approved skills, encrypted OAuth connections, signed one-time invocation grants, confirmation-bound writes, a controlled GitHub wrapper, and identity-complete audit export.

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

Long-lived OAuth grants remain in a dedicated encrypted vault. Agent runtimes, Durable Object state, bootstrap bundles, logs, and read-only agent artifacts must not contain them.

Identity, baseline instructions, approved skills, tool policy, and Gateway configuration are versioned control-plane artifacts mounted or materialized read-only. Runtime-created memory and sessions remain writable but cannot alter those guardrails.

## Confirmation

Policy classifies governed capabilities by risk. External messages, production writes, access changes, destructive operations, and other configured actions require confirmation bound to requester, persona, actor, capability, target, arguments digest, and expiry. Replaying a confirmation for another action must fail.

## Audit

Each meaningful decision records timestamp, requester, persona, selected actor, actor mode, capability, target, policy version, confirmation state, outcome, runtime identity, and correlation id. Content, prompts, model replies, credential values, and unrestricted provider responses are excluded by default.

## Operator flow

Authenticate to Crabhelm → choose a fixed placement target → choose intended user metadata and inference policy → create → watch provider, Gateway, model-auth, and optional-channel evidence converge.

The intended user is materialized as a principal and personal persona. Operator-authenticated APIs may mint a short-lived principal session; channel access remains native to the child OpenClaw instance and never becomes an OAuth grant.

## Readiness

The console separates provider allocation, control link, Gateway version, policy generation, model authentication, and Slack state. Production readiness requires:

- exact provider identity exists;
- child Gateway readiness marker exists;
- desired model is written into child config;
- a live `openclaw agent` turn returns the expected answer through that model;
- desired and observed policy generations agree;
- any enabled channel has live evidence from an adapter capable of supplying it.

Synthetic or echoed evidence must never render as ready.

## Placement

Targets are administrator policy. Each pins adapter, region, appliance profile, TTL, and idle timeout. The create API accepts a target id, not free-form infrastructure controls. Adding another provider means implementing the provider contract and registering another fixed target; Crabhelm itself remains on Cloudflare.

Current production target: AWS US East through Crabbox. The data model and provider router are not Crabbox-specific.

## Policies

Policies are immutable versions of managed fields: primary/fallback inference models, Slack enabled state, native DM/group policy, and child log level. Preview is generation-fenced. Multi-claw rollout requires an explicit canary; an unconverged canary stops the remainder. Applying an older version is rollback.

Credentials, OAuth state, pairing, sessions, memory, and agent directories are outside managed policy.

## Removal

Typed-name confirmation starts a staged removal. Crabhelm disables ingress, verifies zero active work twice across a quiet period, releases the exact provider workspace, confirms absence, revokes the exact control link, and retains redacted audit evidence.

## Current production scope

- Cloudflare Worker, Durable Object state, private R2 appliance, custom domain.
- Real Crabbox allocation and deletion.
- Pinned OpenClaw `2026.6.11` install with exact-model live inference proof.
- Optional Slack credential delivery; Slack-enabled lifecycle remains closed unless the adapter can return live ingress, drain, and channel evidence.
- GitHub organization import remains disabled in the Cloudflare runtime.
- Operator and principal-session authentication; managed OIDC/Cloudflare Access ingress is not yet configured.
- GitHub repository/issue reads and confirmed issue comments through the controlled wrapper.
- AES-GCM OAuth vault, per-claw one-use grant coordination, Queue-backed audit archive, and read-only managed runtime specification.

## Remaining production expansion

1. Configure managed OIDC or Cloudflare Access and Slack request signing so requester sessions originate from approved identity providers.
2. Bind Slack/web ingress to personas and add channel-administrator workflows.
3. Add more provider wrappers and, where providers support it, exchange durable grants for provider-native short-lived tokens.
4. Move lifecycle reconciliation into per-claw Durable Objects for larger fleets.
5. Add SIEM delivery and substrate-native runtime attestation before enabling direct runtime ingress.

The local simulator is test-only and visibly labeled.
