# agent-run per-run ClawRouter keys

Status: standing scheme, approved by Luke (decision `d-20261106-4eaa`, 2026-11-06T22:11Z, agent-manager session 01a1acec; made permanent the same night: "I don't want to have to do this everytime").
Per-run keys need no further approval. They have no budget and no extra scope; they use the default device policy, and agent-run revokes each key when its run ends.

## How a key is made

1. agent-run names the key `agentrun_<UTC yyyymmddHHMMSS>_<6 random hex>`. ClawRouter allows only `[A-Za-z0-9_]`.
2. agent-run makes 24 random bytes on the laptop, in memory only. It sends only their SHA-256 to ClawRouter.
3. agent-run runs a fixed Node script inside the ClawRouter pod: `kubectl --context lue-kube -n clawrouter exec deploy/clawrouter -c clawrouter -- node --input-type=module -e <script> <name> <sha256>`.
   The script calls `PUT http://127.0.0.1:8789/v1/admin/keys/<name>` with the body `clawctl device add` uses: providers `openai,anthropic`, tenant `default`, token role `service`, `retainRequestContent: false`, no budget and no request limit.
4. The full key `clawrouter-live-<name>-<secret>` exists only in agent-run's memory and in the harness process environment on the lease. agent-run sends it to the box on the SSH session's stdin, never on a command line, and never writes it to a file, receipt or log.

## Admin token

The ClawRouter admin token stays in the ClawRouter pod's own environment; the in-pod script reads `process.env.CLAWROUTER_ADMIN_TOKEN`.
agent-run never reads, copies or prints it, and it removes `CLAWROUTER_ADMIN_TOKEN` from every child environment it starts. The token never reaches the laptop process or the box.

## How a key is revoked

agent-run revokes in a `finally` block, and on SIGINT or SIGTERM, whether the harness passed or failed:
`POST /v1/admin/credentials/<name>/revoke` through the same in-pod script. This is `clawctl device revoke`; it takes effect at once, with no restart.
Keys do not expire by themselves. To cover a killed agent-run, each new agent-run first sweeps: it revokes every enabled `agentrun_*` credential that has no live local run lock.

## How revocation is proved

After the revoke, agent-run records two checks in `receipt.json`:

1. The device list (`GET /v1/admin/credentials`, in-pod) shows the key with `enabled: false`.
2. A request with the old key to `/v1/key/inspect` on the cluster ClawRouter is refused (401 or 403).

If either check fails, agent-run exits non-zero and prints the key name (never the key), so an operator can run `clawctl device revoke <name> --host lue-kube`.

## Boundaries

- No laptop key goes to any box. The box gets only the per-run key, and only for one run.
- The box reaches ClawRouter only through the laptop's SSH remote forward to the tailnet service; it gets no tailnet or Cloudflare Access credential.
- Grok (`xai`) and other non-default providers are outside the default device policy. Adding a provider is a scope change, so it goes back to Luke.
