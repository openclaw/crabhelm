# agent-run: run any harness agent off the laptop on Crabbox

Status: design for HLM-1 (lane t-20261106-8b12), 2026-11-06. Brief: `~/Projects/personal/agent-manager/docs/design/2026-11-06-crabhelm-harness-agents-brief.md`.
Credential scheme: [credentials.md](credentials.md) (Luke's standing approval, decision `d-20261106-4eaa`).

## Result

`agent-run --harness <h> --prompt-file F [--model M] [--thinking T] [--attach P..] [--out DIR]` runs one non-interactive harness turn.
It asks Harbor capacity placement first. On `local` it runs the harness on the laptop. On `remote` or `queue` it runs the harness on a Crabbox broker lease without asking anyone.
It returns the harness exit code, streams stdout and stderr, and writes the session files plus `receipt.json` into `--out`.

## Where it lives

`agent-run/` in the valkyriweb/crabhelm fork: one dependency-free Node 22+ CLI (`agent-run/bin/agent-run.mjs`) plus `node:test` tests.
Crabhelm already owns the same pattern for OpenClaw claws: a Crabbox workspace, a digest-pinned appliance and a scoped ClawRouter child credential.
agent-run is the one-shot version of that pattern. Fleet-specific values (placement helper path, kube context, ClawRouter tailnet origin) are defaults that environment variables override, so the code stays generic.
Skills and the Pi Agent tool call the `agent-run` binary; they do not import the code.

## Flow

```
agent-run ──placement──▶ harbor-capacity-placement.mjs --kind agent
   │ local ─────────────▶ exec harness on the laptop (today's behaviour)
   │ remote/queue
   ├─ mint per-run key ──▶ kubectl exec deploy/clawrouter (admin token stays in the pod env)
   ├─ crabbox warmup --provider serve --type cpu2 (coordinator admits the lease)
   ├─ ssh: upload appliance tgz + inputs (sha256 checked on the box)
   ├─ ssh -R 127.0.0.1:18789 → clawrouter-lue.tail59faed.ts.net:8789 ; run harness, stream output
   ├─ ssh: tar the session dir back into --out
   └─ finally: revoke key (in-pod) ▸ prove revoked ▸ crabbox stop ▸ write receipt.json
```

## Target choice

| Placement | Target | Why |
|---|---|---|
| `local` | laptop | Load ≤ 16 and memory fine; same as today. |
| `remote` with a reservation | the named reservation (broker only in v1) | Fleet already chose it. |
| `queue` | broker, `--provider serve --type cpu2` | Default fleet path; the coordinator admits leases. Agents are I/O bound, so cpu2 is enough. |

The broker CLI already waits up to 10 minutes for capacity. If it still fails, agent-run exits 75 and leaves the placement queue receipt. After a successful dispatch agent-run removes its own queue receipt, as `docs/capacity-placement.md` requires of the owner.
`lue-kube-pool` is explicit-only (a Fleet port-forward), and the CrabboxJob queue returns only an exit code, so v1 uses neither.

## Model access from the box

Observed 2026-11-06 on broker leases: the box resolves but cannot reach the tailnet ClawRouter (100.76.128.14:443 closed), and `clawrouter.myhorizon.co.za` sits behind Cloudflare Access.
agent-run therefore opens an SSH remote forward from the laptop: the box calls `http://127.0.0.1:18789`, and the laptop's SSH client carries it to the cluster ClawRouter on the tailnet. A probe through this forward returned `/v1/health` 200 from a broker lease.
No infrastructure change, no Access token and no tailnet key reach the box. The cost is that the run depends on the laptop's SSH session, which is light.

## Harness appliances

Each harness has one pinned, content-addressed tarball: Node linux-x64 (SHASUMS-verified) plus the harness package at an exact version with its lockfile.
`agent-run appliance build <h>` builds it on a Crabbox lease (heavy work stays off the laptop; the first Pi build took about 20 minutes on cpu2 and produced an 84 MB tarball) and stores it under `~/.cache/agent-run/appliances/<h>-<version>-<sha12>.tgz`. `agent-run/appliances.json` pins the expected sha256.
Each run streams the cached tarball over SSH; the box checks the sha256 before it unpacks it. Nothing is downloaded or installed on the box per run.

| Harness | Box config written per run (key only from env) |
|---|---|
| pi | `models.json` provider `clawrouter`, `baseUrl http://127.0.0.1:18789`, `api anthropic-messages`, `apiKey CLAWROUTER_API_KEY`; `pi -p` |
| codex | `config.toml` model provider with the forward as base URL, Responses API; `codex exec` |
| claude | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`; `claude -p` |
| grok, prime-agent, rusty, openclaw | per-slice: each slice records the exact base-URL and key settings it needs |

Open item: Grok models route as provider `xai`, which the default device policy (`openai,anthropic`) refuses. The grok slice uses Grok-family models only through providers the default policy allows, or it reports the gap.

## Receipts and exit codes

`receipt.json`: placement JSON, target, lease id, slug, crabbox run id, harness, appliance sha256, model, exit code, key name, revoke proof, `lease cleanup stopped=true`. It holds no key material.
Exit codes: the harness's own code; 75 queued without capacity; 3 agent-run infrastructure failure (cleanup still ran).

## Cleanup

All remote work runs inside one `try/finally` with SIGINT and SIGTERM handlers: revoke the key, check that it is revoked, then `crabbox stop`.
Each lease has `--idle-timeout 75m --ttl 90m`, so a lease left by a killed agent-run ends within 75 minutes.
The idle timeout is the run budget, not a short keepalive window: on serve leases a raw SSH session closes at the lease's idle timeout even while `crabbox heartbeat` refreshes the lease (observed 2026-11-06 with a 3-minute timeout).
Keys have no expiry in ClawRouter, so every agent-run first runs a sweep: it revokes any enabled `agentrun_*` device whose local run lock is gone.

## Pi Agent tool and Workflow hook

The Pi subagent extension calls placement before it spawns a child Pi process. On `queue` it spawns `agent-run --harness pi` with the same prompt, model and thinking level and reads the same stdout and session file.
That change lands in the subagent extension's own repository after the Pi slice works. Workflow children use the same spawn path.

## Slices

1. Pi (this PR): placement, key mint and revoke, broker lease, appliance, reverse forward, receipts, sweep.
2. codex, 3. claude, 4. grok, 5. prime-agent, 6. rusty, 7. openclaw: one appliance and one config writer each.
8. Pi Agent/Workflow hook; then the reflect acceptance for session 01a1acec.
