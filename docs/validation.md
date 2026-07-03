# Validation ledger

Live evidence is separate from unit and simulator evidence. Last full production pass: 2026-07-03.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Cloudflare control plane | `crabhelm.openclaw.ai` and `crabhelm-runtime.openclaw.ai`; organization and per-claw Durable Objects; alarm reconciliation | Live |
| Identity-aware console | Cloudflare Access JWT issuer, audience, signature, and expiry verified before principal resolution; no operator-token prompt | Live |
| Private appliance | Digest-pinned archive under top-level `bundle/` in private R2; archive and manifest digests enforced before bootstrap | Live |
| Real placement | Crabbox-created AWS US East workspace with provider resource evidence; no simulator selected in production | Live |
| OpenClaw child | Gateway `2026.6.11`, loopback readiness, exact model `openai/gpt-5.5`, managed persona, read-only instructions and skills | Live |
| Actual inference | Bounded `openclaw agent` challenge returned the exact expected marker; `authReady: true`; `liveInferenceProbe: true` | Live |
| Slack end to end | Production DM route completed and Slack delivered exact probe replies through the remote OpenClaw runtime, including after forced reconnect | Live |
| Runtime reliability | Single-process appliance lock, authenticated outbound WebSocket dispatch and credential rotation, bounded process-group execution, delivery retry, reset-generation cancellation, and release-pinned in-place appliance rollout | Live + automated |
| Runtime authentication | Owner-only ten-minute workload credential, one-use refresh rotation, one-use connection tickets, and no credential inheritance by turn processes | Live + automated |
| GitHub delegation | OAuth grant encrypted in private R2; bounded governed read executed as the connected requester; writes require argument-bound confirmation | Live + automated |
| Audit archive | Identity-complete metadata through Cloudflare Queue to private R2; prompt and tool content excluded | Deployed + automated |
| Browser workflow | Existing Chrome profile verified Fleet, Personas, Skills, Access, metadata-only Activity, and runtime status; Slack delivery is separately verified by exact job/delivery metadata because the Chrome automation connector was unavailable for the final reply | Partial live |
| No tunnel | Worker calls Crabbox outbound; child connects outbound over HTTPS/WSS; no Cloudflare Tunnel or permanent controller VM | Verified |
| Automated proof | 104 tests covering domain, governance, security, policy, routing, concurrency, deletion, bootstrap, appliance, persistence, static, and Worker checks | Full suite passing |

## Repeatable checks

```bash
pnpm check
pnpm exec wrangler deploy --dry-run
curl --fail https://crabhelm-runtime.openclaw.ai/healthz
```

Authenticated state must show the proof claw as `ready`, Gateway `2026.6.11`, configured and resolved model `openai/gpt-5.5`, `authReady: true`, `liveInferenceProbe: true`, and one connected runtime bridge. Production readiness is never inferred from provider allocation, echoed shell source, or process existence.

## 2026-07-03 production proof

- Worker version: `9b5795a6-56af-420e-8119-301d6a071234`.
- Appliance archive: `543da38f97d6847a092da8ca20dc5b24986952ec0595d661174da2a3d05e4d2c`; manifest: `886e1d118dbfef7474ad7462f0a31cc88237ec7a16d3ad996a4fb0fa0362069e`; runtime bridge: `be1bd7b13ff38e51205117fd25610a258df96b5fa3c4aa361cc584ef72c0395b`.
- Claw `c461f5eb-ad04-4255-a4e2-bd7bd0ed6e37` reached `ready` with the reviewed release, live inference, and one authenticated outbound runtime connection.
- Slack jobs `4d570ed2-2a90-4e10-96b3-c59cf3b2393c` (`CRABHELM-PRODUCTION-PROBE-4D570ED2`) and `aa83a063-dbbc-4ab0-b8df-373c2d1d93ee` (`CRABHELM-PRODUCTION-PROBE-AA83A063`) completed and delivered without a protocol rejection; the intervening forced reconnect disconnected exactly one runtime.
- The same bridge emitted `runtime_token_refreshed` after its five-minute rotation interval and remained connected.
