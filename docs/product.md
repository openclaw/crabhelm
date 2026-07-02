# Product contract

## Primary object

A **Claw** is one independently deployed child OpenClaw core. UI vocabulary stays at Claw, Intended user, Policy, Deployment, Access, Inference, and Activity. Intended user is desired metadata, not an access grant. Gateway/node/provider evidence remains visible in details.

## First workflows

### Create one Claw

Intended user → choose an admission-open administrator-defined deployment target → inference → optional channels → provision → pair child node to parent → verify child Gateway → pair or allowlist the intended user inside the child.

### Give maintainers a Claw

Current: paste up to 50 unverified maintainer labels as manual identities, or authenticate a read-only GitHub organization source → preview organization/team/repository-maintainer membership → skip existing numeric identities → select up to 500 recipients → revalidate each selected numeric ID server-side → create in chunks of 50 with concurrency three → report each member's result → retry failed members only. Each child drawer reads and approves that child's native Slack pairing queue. Planned: capacity estimate and canary selection.

### Apply policy

Preview field-level diff → choose children → canary → reconcile safe desired fields → preserve secrets/auth/pairing/sessions/memory → show applied, drifted, and failed outcomes.

The policy library stores immutable versions in the parent SQLite database. Preview captures field changes and expected desired generations. Multi-claw apply requires an explicit canary and stops before changing the remainder if that claw does not converge; remaining desired mutations commit atomically and reconcile with bounded concurrency. Applying an earlier version is rollback. Policies manage model/fallbacks, Slack enabled state, native DM/group visibility, and child log level. “Mirror” remains avoided because it implies copying identity or memory.

### Disable or remove

Disable channel ingress first and verify it → observe zero active child runs twice across a quiet period → release the exact Crabbox workspace → accept only terminal provider-absence evidence → reject/remove the exclusively child-owned native parent device pairing → list again and require pairing absence → mark the control link revoked → retain redacted audit evidence. Disable is reversible; remove is approval-gated and requires typed-name confirmation. Drain evidence is metadata-only and bounded; it does not copy child session data into the parent. Reconciliation is serialized per child and revision-fenced against concurrent operator writes.

## MVP success

- Create five child cores from one template; each has unique Gateway/state/OS identity.
- Parent controls the child through native node pairing; recipients cannot chat before native channel pairing and can after approval.
- Apply inference policy with config compare-and-swap and observed hash verification.
- Parent UI requires the parent Gateway operator identity; every authorized parent operator currently sees the governed fleet.
- Diagnose box, Slack probe, model-auth, and sanitized process/log-policy failures from fleet state without SSH.
- Apply versioned policy to a subset or all with generation fencing and a canary, without changing credentials, pairing, sessions, or memory.
- No secrets or conversation/tool content in parent state or default exports.
- Timeout/retry during create/delete never duplicates or loses provider ownership.

## Open questions to validate

- The evaluation appliance uses one Slack Socket Mode bot/app token pair per child. Decide whether production keeps per-child apps or introduces a separately reviewed router-owned relay profile.
- Existing ChatGPT OAuth must stay box-owned and is not clonable. Decide whether unattended organization children use centrally governed API SecretRefs, per-child device auth, or both.
- Define the durable always-on Crabbox profile and renewal/backup semantics.
- Decide whether target capacity should become a hard admission-control limit or remain controller-reported health.
- Choose the first outer operator identity: parent Gateway operators only, or a Crabfleet/AppGarden-style organization edge from day one.

## Current integration gaps

- The `openclaw-core` profile contract, digest-pinned appliance bundle, guest installer, and bootstrap exist, but no live Crabbox controller profile has been installed or exercised end to end. The available private controller inspected during development is a Codex-only `linux-desktop` profile and is intentionally not treated as an OpenClaw appliance.
- Parent enrollment assumes identity-bearing private ingress (for example Tailscale Serve); that exact environment still needs a live proof.
- Slack enable consumes credentials already installed in each child profile. Crabhelm does not provision or copy Slack secrets.
- The first live profile is constrained to environment-backed Slack SecretRefs. File/exec SecretRef resolution needs compatibility proof against the pinned OpenClaw artifact.
- The web console exposes readiness facets, model-auth and Slack probes, sanitized process/log-policy metadata, deletion drain stages, and parent audit. Raw log aggregation remains future work.
