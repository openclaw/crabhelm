# Validation ledger

Live evidence is kept separate from unit and simulator evidence.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Cloudflare control plane | Worker version `43004616-ddbd-4310-ba33-f70acd68ded5`; custom domain `crabhelm.openclaw.ai`; OpenClaw account; organization and per-claw Durable Objects; alarm reconciliation | Live |
| Durable state | Real create persisted across Worker deployments and operator-token rotation | Live |
| Private appliance | Remote R2 object `crabhelm-appliances/openclaw-core/bundle.tgz`; archive digest `27ddf69937714de62898f17ecdbcce07eb184db7b63b6c7e549efa1c40bfb071`; top-level `bundle/`; manifest digest `26c69e5cf4e74d009c642df975ed9a3aa047c5671008b6c161997b391ac1d3e9` | Live |
| Real placement | Claw `b3eba8b9-7b06-462b-97f8-55bd1b8653d9`; Crabbox workspace `crabhelm-managed-identity-proof-20260702-1212`; provider resource `cbx_709b24ab37f7`; AWS US East target | Live |
| OpenClaw child | Gateway `2026.6.11`, loopback readiness, exact desired model `openai/gpt-5.5`, managed persona and read-only instruction delivery | Live |
| Actual inference | Bounded `openclaw agent` turn returned exact expected marker; `authReady: true`; `liveInferenceProbe: true` | Live |
| Browser workflow | Existing Chrome profile opened the custom domain and verified Fleet, Personas, Skills, Access, and metadata-only Activity views; the live proof claw rendered policy-converged | Live |
| No tunnel | Worker calls Crabbox and child terminal outbound; no Cloudflare Tunnel or permanent controller VM | Verified |
| Identity and delegation | Requester, actor, and persona records; explicit `actAs`; signed sessions and one-use invocation grants; confirmation binding; unconnected invocation failed closed | Live + automated |
| Secret isolation | OAuth envelope vault in private R2; runtime state exposes no vault keys; browser reports zero active runtime secrets | Live + automated |
| Audit archive | Queue producer/consumer `crabhelm-audit` and private R2 archive deployed; message handling covered by Worker tests | Deployed |
| Registry/reconciliation | Domain, governance, policy, routing, concurrency, deletion, bootstrap, and persistence suites | 89 automated tests |
| Static and Worker build | Node TypeScript, Worker TypeScript, browser JavaScript syntax, Wrangler dry-run, esbuild | Passing |
| Slack | Optional credentials supported; no production credentials configured in this deployment | Not exercised |
| GitHub tools | Bounded repository/issue wrappers and encrypted connection path deployed; no production OAuth connection configured | Fail-closed verified |

## Repeatable checks

```bash
pnpm check
wrangler deploy --dry-run
curl https://crabhelm.openclaw.ai/healthz
```

Authenticated state should report the live claw as `ready`, Gateway `2026.6.11`, configured/resolved model `openai/gpt-5.5`, `authReady: true`, and `liveInferenceProbe: true`.

Production readiness is not inferred from Crabbox allocation or terminal source text. The inspector accepts exact sentinel lines only; model readiness requires the persisted successful inference marker for the current desired model.
