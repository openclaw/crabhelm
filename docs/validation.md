# Validation ledger

This ledger distinguishes implemented behavior from environment-dependent proof. Simulator or unit evidence is never treated as proof that a private Crabbox controller and child appliance are live.

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Standalone parent control plane | Packaged OpenClaw plugin, web console, agent tool, Gateway methods, and reconciler under one independent project folder | Implemented |
| Atomic fleet state | Private mode-`0700` state directory, mode-`0600` SQLite database, WAL journal, `FULL` synchronous writes, transactional claw/policy/audit mutations, integrity tests | Verified locally |
| Create, change, disable, enable, remove | HTTP workflow exercised create → managed update → disable → enable → staged delete; deletion ended only after drain, provider absence, and control revocation | Verified with deterministic provider |
| Deployment placement | Administrator-defined target derives immutable controller/profile/region tuple; EU target workflow exercised without accepting provider overrides | Verified with deterministic provider |
| Crabbox lifecycle | Fixed `openclaw-core` request contract, HTTPS/loopback boundary, idempotency, exact returned identity, active create-state validation, inspection, and confirmed deletion | Contract verified; live profile pending |
| Independent OpenClaw child | Digest-pinned appliance builder/installer plus child bootstrap configure one state root, Gateway, service identity, and outbound node host | Bundle verified; live profile pending |
| Native parent ownership | Deterministic child node identity, native OpenClaw device pairing, identity-bound command policy, exact child-only device cleanup | Unit/integration verified; live ingress pending |
| Inference and configuration governance | Immutable policy versions, field preview, desired-generation CAS, managed-field CAS, canary gate, bounded rollout, prior-version rollback | Verified locally |
| Visibility and permissions | Managed native DM/group policy; child Slack pairing list/approve; no parallel child ACL | Verified at command boundary; live Slack pending |
| Logging and diagnosis | Child log-level policy plus metadata-only health/process projection; prompts, messages, tool output, credentials, and opaque causes excluded | Verified locally |
| Organization rollout | GitHub organization/team/repository preview, stable numeric identities, server-side revalidation, bounded creation, duplicate fencing | Verified with deterministic member source; live GitHub token pending |
| Convenient web UI | Fleet, policies, deployments, activity, create/import/rollout/detail/removal surfaces; static and API routes load and complete workflows | Functional proof complete; rendered Chrome QA pending |
| Product validation | Independent product-science review after deletion/concurrency hardening | GO; no P0/P1 at reviewed revision |

## Repeatable checks

```bash
pnpm check
npm pack --pack-destination /tmp
openclaw plugins inspect crabhelm --runtime --json
```

Expected package inspection: `status: loaded`, two HTTP routes, no diagnostics, no runtime dependencies, and the documented Gateway methods.

## Required environment proof before production

1. Install the digest-pinned `openclaw-core` profile on a registered private Crabbox controller with persistent/renewable lease policy.
2. Prove the parent Gateway's identity-bearing private ingress and one child's outbound native node pairing.
3. Exercise create → ready → policy apply → native Slack user pairing → drain → provider absence → native device cleanup against that controller.
4. Render the authenticated console in the user's existing Chrome profile and verify responsive layout, dialogs, focus, error states, and the full primary workflow.

Until all four pass, Crabhelm is a validated implementation slice, not a production-proven fleet deployment.
