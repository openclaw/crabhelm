# Validation ledger

Live evidence is separate from unit and simulator evidence. Detailed production records are retained outside the public repository.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Cloudflare control plane | Configured console and runtime hosts; organization and per-claw Durable Objects; alarm reconciliation | Live |
| Identity-aware console | Cloudflare Access JWT issuer, audience, signature, and expiry verified before principal resolution; OpenClaw GitHub organization members admitted; no operator-token prompt | Live |
| Private appliance | Digest-pinned archive under top-level `bundle/` in private R2; archive and manifest digests enforced before bootstrap | Live |
| Real placement | Crabbox-created workspace with provider resource evidence; no simulator selected in production | Live |
| OpenClaw child | Gateway `2026.6.11`, loopback readiness, exact model `openai/gpt-5.5`, managed persona, read-only instructions and skills | Live |
| Actual inference | Bounded `openclaw agent` challenge returned the exact expected marker; `authReady: true`; `liveInferenceProbe: true` | Live |
| Slack end to end | Production DM route completed and Slack delivered exact probe replies through the remote OpenClaw runtime, including after forced reconnect | Live |
| Runtime reliability | Single-process appliance lock, authenticated outbound WebSocket dispatch and credential rotation, bounded process-group execution, delivery retry, reset-generation cancellation, and release-pinned in-place appliance rollout | Live + automated |
| Runtime authentication | Owner-only ten-minute workload credential, one-use refresh rotation, one-use connection tickets, and no credential inheritance by turn processes | Live + automated |
| GitHub delegation | OAuth grant encrypted in private R2; bounded governed read executed as the connected requester; writes require argument-bound confirmation | Live + automated |
| Audit archive | Identity-complete metadata through Cloudflare Queue to private R2; prompt and tool content excluded | Deployed + automated |
| Browser workflow | Existing Chrome profile verified GitHub Access login, administrator role resolution, Fleet, Personas, Skills, Access, metadata-only Activity, and runtime status; Slack delivery is separately verified by exact job/delivery metadata | Live |
| No tunnel | Worker calls Crabbox outbound; child connects outbound over HTTPS/WSS; no Cloudflare Tunnel or permanent controller VM | Verified |
| Automated proof | 162 tests covering domain, governance, security, policy, routing, concurrency, deletion, bootstrap, appliance, persistence, static, and Worker checks | Full suite passing |

## Repeatable checks

```bash
pnpm check
pnpm exec wrangler deploy --dry-run --config wrangler.production.jsonc
curl --fail "${CRABHELM_RUNTIME_URL:?set the production runtime URL}/healthz"
```

Authenticated state must show the proof claw as `ready`, Gateway `2026.6.11`, configured and resolved model `openai/gpt-5.5`, `authReady: true`, `liveInferenceProbe: true`, and one connected runtime bridge. Production readiness is never inferred from provider allocation, echoed shell source, or process existence.

## Production proof publication policy

The live validation record confirms a reviewed Worker deployment, digest-pinned appliance, ready claw, authenticated runtime reconnect, exact Slack probe delivery, credential refresh, and administrator access. Public documentation intentionally omits deployment IDs, resource IDs, job IDs, exact artifact digests, and administrator identities.
