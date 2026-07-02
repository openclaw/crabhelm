# Architecture

## The abstraction

Crabhelm provides fleet-level multi-tenancy by composing independent OpenClaw cores:

```text
operator / Slack / web
          |
          v
  parent OpenClaw core
  + Crabhelm parent plugin
          |
          | desired state + Crabbox lifecycle
          | native node pairing (children connect outbound)
          v
  +----------------+  +----------------+  +----------------+
  | child core A   |  | child core B   |  | child core C   |
  | one Gateway    |  | one Gateway    |  | one Gateway    |
  | one state root |  | one state root |  | one state root |
  | one OS identity|  | one OS identity|  | one OS identity|
  +----------------+  +----------------+  +----------------+
          ^                  ^                    ^
          +------------------+--------------------+
                         Crabbox lifecycle
```

This is deliberately not one Gateway with many workspaces or agents. OpenClaw's multi-agent routing is useful inside one trust domain; it is not the tenant boundary.

## Parent core

The parent is an ordinary OpenClaw core with the Crabhelm plugin enabled. The current plugin owns:

- desired child specs and immutable generations;
- observed health, config hash, version, channel state, and drift;
- stable Crabbox workspace identity, response digest, and deletion evidence;
- one native OpenClaw node-control link per child;
- intended-user metadata, without pretending it is an enforced grant;
- metadata-only audit events;
- the web console, Gateway RPC surface, and `crabhelm` agent tool.

The parent does not own child conversations, memory, sessions, or human allowlists as database rows. It asks each child to mutate its own native OpenClaw state through the child's control link.

## Child core

Every child has:

- a dedicated Crabbox workspace or equivalent machine;
- a dedicated OpenClaw state directory and Gateway process;
- a dedicated OS/service identity;
- its own model auth and channel SecretRefs;
- its own pairing/device records, command owners, sessions, and memory;
- the Crabhelm plugin in child mode, connected outbound to exactly one parent.

Child mode is intentionally narrow. `crabhelm.child.status` is read-only, probes loopback `/readyz`, and reports managed config evidence. `crabhelm.child.health` invokes OpenClaw's own live Slack status probe plus model-auth status, then returns only bounded account health, timestamps, error summaries, and process/log-policy metadata; `contentCaptured: false` describes Crabhelm's parent projection, not the child's independent log sink. Child redaction mode is reported separately and redaction `off` is a warning. `crabhelm.child.drain.status` pages through local Gateway session metadata and returns only active-run count plus timestamp; no session keys, titles, messages, or content cross the boundary. `crabhelm.child.apply` changes only model/fallback, Slack enabled/DM/group policy, and child log-level fields using OpenClaw's config mutation API and a managed-field compare-and-swap hash. `crabhelm.child.ingress` snapshots configured channel enable flags, disables them, and restores them on re-enable. Native Slack pairing list/approve commands run the exact OpenClaw CLI without a shell; approve is dangerous and explicitly allowlisted. Arbitrary shell execution is not part of the contract. Raw logs, prompts, messages, and tool output never enter parent state.

Operational failures cross the node boundary as allowlisted codes, not exception bodies. The parent preserves actionable categories such as unresolved child-local Slack credentials, policy compare-and-swap conflicts, identity mismatch, missing commands, invalid health evidence, and Crabbox HTTP stage while discarding opaque causes.

## Enrollment

1. Parent creates desired state and asks Crabbox for stable workspace id `crabhelm-<slug>`. Retries reuse an idempotency key bound to the immutable child id.
2. Bootstrap installs one child Gateway, enables Crabhelm child mode with the immutable `childId`, and starts an OpenClaw node host aimed at the parent.
3. The node host uses node id `crabhelm-<childId>` and display name `crabhelm:<childId>`. Its first connection creates OpenClaw's normal pending `role: node` device request on the parent.
4. A parent operator approves that native device pairing. No Crabhelm bearer or parallel pairing store is created.
5. Parent node policy checks both deterministic node id and display name; the child command independently checks its configured child id. The parent invokes `crabhelm.child.status` and records the paired node id.
6. Child status probes the local Gateway readiness endpoint and reports the applied desired hash. A cached operational probe (maximum age five minutes) checks model auth and optional Slack connectivity. Real Crabbox children become ready only when provider existence, native node identity, desired config, child Gateway readiness, model auth, and required Slack health agree.

The child initiates the connection to the parent. Child Gateways do not need a public control endpoint.

## Desired and observed state

Each record has two halves:

- `desired`: intended user, template/version, deployment target/region/profile, inference policy, channel/ingress policy, observability, and desired generation;
- `observed`: provider identity, control-link status, Gateway health/version, managed config hash, applied generation, sanitized operational probe metadata, approved Slack subject when present, and last-seen time.

`desired.generation !== observed.generation` is drift. Create identity is stable and no-op updates do not advance generation. Managed config apply uses a child-local compare-and-swap hash; deployment placement becomes immutable after allocation. The parent config defines each target's exact controller URL, environment-only token reference, region, profile, TTL, and idle timeout. Operator surfaces accept only the target id and the server derives the rest; the provider router rejects any tuple that no longer matches administrator policy.

Versioned managed policies are immutable SQLite records. A rollout first previews field-level changes and captures each target's desired generation. Apply rejects the entire desired-state batch if any generation changed, applies one selected canary, and does not touch the remainder unless the canary reconciles to its new generation. The remaining desired mutations commit atomically, then reconcile with bounded concurrency and per-claw outcomes. Reapplying an older version is rollback. The policy boundary includes model/fallbacks, Slack enabled state, native DM/group policy, and child log level; it excludes credentials, OAuth material, pairing state, sessions, memory, and agent directories.

Removal is an evidence-driven state machine: verify child ingress disabled → observe zero active runs twice across a quiet period → release the exact provider identity → confirm provider absence → list the parent's native devices → reject any exact pending request and remove the exact paired node device → list again and require absence. Device id, exclusive `role: node` ownership, and any reported display name must match the enrolled child before a destructive whole-device pairing command runs; a mixed-role device fails closed without losing unrelated authorization. Provider absence is rechecked while draining, so an expired lease advances to pairing cleanup instead of waiting on an unreachable child. Provider absence alone never marks the child deleted. Missing, stale, malformed, or mismatched evidence remains retryable.

Only one reconciliation operation may run for a given child at a time. A monotonic record revision also fences every observed-state write against concurrent operator updates and pairing metadata changes. If an async provider or health result returns after the record changed, its stale projection is discarded and the newer record remains authoritative.

## Authentication and tenancy

Two independent boundaries remain necessary:

1. **Parent operator access.** The web console and Gateway methods use the parent core's existing operator identity/scopes. In the current slice, an authorized parent operator can read the whole registry; there is no per-intended-user fleet visibility filter.
2. **Child human access.** Slack/Discord/etc. users enter through the child's native DM pairing, allowlists, group policy, command owner, and approval rules.

Native node pairing gives the parent a control relationship without a second child authorization system. It does not remove the need to authenticate who may operate the parent, and intended-user metadata does not grant child access.

## Organization import

GitHub discovery is parent-only and read-only. A fixed HTTPS API origin and token environment variable are configured on the parent. The service pages through at most 500 organization, team, or repository-collaborator records, excludes bots, and retains GitHub numeric user IDs as stable subjects. The browser previews and selects recipients, then submits normal create requests in chunks of 50. Child access still starts empty and uses native channel pairing; GitHub membership is not treated as a Slack identity proof.

## Crabfleet and Crabbox reuse

Reuse from Crabfleet:

- private-by-default operator visibility patterns;
- async lifecycle states and attention-required UX;
- generation fencing, idempotency, and reconciliation;
- safe logs/archives and exact deletion confirmation.

Do not reuse Crabfleet's primary object (`card`/Codex session) or treat a child core as a temporary interactive session.

Reuse from Crabbox:

- workspace provisioning and provider abstraction;
- stable lifecycle identity and provider responses;
- terminal/desktop connection for explicit break-glass operations;
- defensive, confirmed resource deletion.

Crabhelm can route across multiple fixed private controllers, but it does not turn Crabbox's provider/class/server switches into tenant inputs. Each administrator-defined target remains a reviewed controller/profile boundary. A missing target token only disables that target; it does not redirect existing claws or fall through to another provider.

The existing four-hour disposable profile is not an always-on child-core contract. The UI displays the configured TTL. [`deploy/profile-contract.md`](../deploy/profile-contract.md) defines the required fixed appliance boundary, while [`deploy/crabbox-profile`](../deploy/crabbox-profile/README.md) reproducibly bundles the pinned OpenClaw and Crabhelm artifacts and verifies them on the guest. Crabhelm still needs that profile installed on a dedicated controller and an explicit persistent/renewable lease policy before production rollout.
