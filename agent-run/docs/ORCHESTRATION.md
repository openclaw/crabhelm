# Dispatching agent runs

Run one agent turn from a control host. The harness runs on a disposable Linux
Crabbox lease; the control host uploads inputs, forwards ClawRouter traffic,
streams output, downloads results, revokes the key and stops the lease.

## Prepare the control host

Use Node 22.19+ with npm, tar, SSH, kubectl and an authenticated Crabbox CLI.
The host must reach the broker and ClawRouter over the tailnet. Its kube context
must permit the in-pod per-run key operations described in
[credentials](../../docs/agent-run/credentials.md). Do not copy a laptop API key
to a lease. Pi also needs a models file with the selected ClawRouter model.

Defaults and environment overrides live in [config.mjs](../lib/config.mjs).
Set `AGENT_RUN_PI_MODELS` when the Pi models file is elsewhere.
Set `AGENT_RUN_OPENAI_GRANT=<token ref>` (for example `openai_work`) to limit
the per-run key to that one OpenAI grant: the mint body gains
`grantRouting: {eligibleGrants: {openai: [<ref>]}}`. The ref follows ClawRouter's
rule (1-256 characters, no `/` or control characters); a set but empty value
is refused. If that grant is unusable the run fails; it never falls
back to another OpenAI grant. Unset leaves the mint body unchanged.
Automatic placement requires Harbor's capacity helper; use
`AGENT_RUN_PLACEMENT` to select it. Explicit `--placement remote` does not
require Harbor on the control host.

## Dispatch

Check current capacity with `crabbox serve machines`. The only approved donor
is `lue-dl360-worker-01-donor` (the asus and worker-01 donors are retired).
`rp-kube-01` is banned: it is a client production host (Luke, 2026-11-16).
`loadConfig` rejects `AGENT_RUN_CRABBOX_MACHINE=rp-kube-01`, Harbor placement
never reports it, and the crabbox user config pins unpinned serve leases with
`serve.machine: lue-dl360-worker-01-donor`. This proof does not use the M2 Max.

```sh
export AGENT_RUN_CRABBOX_MACHINE=lue-dl360-worker-01-donor
export AGENT_RUN_CRABBOX_TYPE=cpu2  # cpu4 is also supported
node agent-run/bin/agent-run.mjs \
  --harness pi --model clawrouter/gpt-6-astra-200k --thinking low \
  --prompt-file task.md --placement remote --out ./results/pi
```

Replace `--harness pi` with `--harness codex` for Codex. Each run needs its
own output directory. The runner requests an explicit type and standard
class. `AGENT_RUN_CRABBOX_MACHINE` pins serve placement; without it, crabbox uses
`serve.machine` from its user config. Without either, the broker chooses by
free CPUs and can pick `rp-kube-01`, so keep the user-config pin.

Pi maps `openai-codex-responses` models to `openai-responses` at the
forwarded `/v1` endpoint. Per-run API keys are not ChatGPT OAuth JWTs.

## Avoiding a slow broker relay

On this fleet, the broker relay transferred a 218 MB appliance at about
250 KB/s (roughly 14 minutes).

agent-run keeps each uploaded appliance in the lease's tool cache at
`~/.cache/crabbox-tools/agent-run/<sha256>.tgz`. A later run on the same
machine copies that file into its work directory, checks the SHA-256 of the
copy, and skips the upload. The store step runs only where the cache directory
already exists; Crabbox serve machines mount it as a per-machine volume, and
other providers keep uploading. Every lease on a machine can write this cache,
so agent-run never unpacks a file whose digest it has not checked. The copy
takes a regular file only, reads at most the appliance's own size and stops
after 120 seconds. A missing, changed or unreadable entry is a cache miss, not
an error, and a store that cannot work does not fail the run. Files unused for 30 days are
removed at the next store. Set `AGENT_RUN_REMOTE_TOOL_CACHE=off` to always
upload, or to another path relative to the remote home.

If the control host can SSH to an approved donor, set
`AGENT_RUN_SERVE_PROXY_COMMAND` to a trusted byte-stream command that reaches
that donor's SSH frontdoor. For example, use `ssh -o BatchMode=yes -W
<donor-pod-IP>:2222 <approved-donor-host>`. Discover the current donor address
first; do not reuse an old pod IP. This replaces only the broker relay hop.
Both the donor and lease SSH connections retain Crabbox's pinned host-key checks
and per-lease key. The control host's SSH credential is never copied to a lease.
The override fails closed if Crabbox emits an unrecognized SSH command.

Set `AGENT_RUN_COMMAND_TIMEOUT_MS` to bound each child command during remote
dispatch; the default is 75 minutes, matching the existing lease idle budget.
Local harnesses retain their foreground process group and normal Ctrl-C behavior;
this timeout does not apply to them. A timed-out child
process group is killed, reports exit 124, and the run still attempts cleanup.
Appliance uploads report byte progress every 30 seconds and a verified digest
after remote extraction. A byte count measures bytes sent, not remote verification.

Do not run the dispatcher inside a monitor-owned process group that a session
shutdown will kill. Detach the job, persist its log and completion marker, and
monitor the marker. Killing the dispatcher itself can interrupt cleanup.

## Status and results

Keep the dispatch process alive. Stdout streams to the terminal and
`--out/stdout.txt`; stderr reports lease details, key revocation and cleanup.
Redirect stderr to a durable log when needed. The final `receipt.json` records
placement, lease ID, requested donor, appliance digest, exit code,
`resultsDownloaded`, revocation proof and cleanup. Match the machine UUID in
the Crabbox `leased ... server=<machine UUID>/<lease>` line to
`crabbox serve machines` to identify the actual donor. A requested donor alone
is not proof of execution.

The remote working directory contains `prompt.md`, `attach/` and `out/`.
Tell the agent to write reports and patches to `out/` (also available through
`$AGENT_RUN_OUT_DIR`). The runner downloads:

- `--out/out/`: reports, patches and other files written to remote `out/`.
- `--out/session/`: harness session files; Codex includes `last-message.md`
  and `codex-sessions/`. Pi stores its transcript here and its text answer in
  `stdout.txt`; it does not produce a separate last-message file.

Result download or extraction failure makes an otherwise successful run exit
3. Cleanup still runs. A nonzero harness result retains its own exit code.
Exit 75 means no broker capacity; 4 means key revocation is not proven.
Success requires exit 0, downloaded results, key revocation and lease cleanup.

## Returning code changes without GitHub credentials

The runner accepts file attachments, not a checkout or directory. Package a
clean source snapshot yourself, attach it, and instruct the agent to unpack it
inside the lease. Do not attach secrets, credential files or dependency caches.
For example, run `git archive --format=tar.gz HEAD > source.tar.gz`
and pass `--attach source.tar.gz`.

In the prompt, ask the agent to run `git init` and `git add .` in the unpacked
repository before editing. This stages the original files as a baseline without
a commit. After editing and testing, run these commands in that repository:

```sh
git add -N .
git diff --binary > "$AGENT_RUN_OUT_DIR/changes.patch"
git status --short > "$AGENT_RUN_OUT_DIR/status.txt"
```

The baseline must exist before editing. `git add -N` includes new files in
the diff. Review the downloaded patch, then use `git apply --check` locally
before applying it. No commit, push or GitHub credential on the lease is needed.

## Limits

- The host's SSH connection is required throughout; this is not detached job
  scheduling, a shared workspace, or a persistent agent pane.
- Only supplied inputs reach the lease. Edits outside remote `out/` are not
  returned automatically. Remote leases are discarded after collection.
- Linux x64 appliances are pinned. Cold builds download dependencies. The
  first run on each machine uploads the appliance; network throughput can
  dominate that run.
- Cache locking coordinates processes on one host, not a shared network cache.
- Automatic key sweeping only revokes dead or finished runs with a local ownership record.
  Failed mint/revoke attempts retain that record for the next sweep.
  Keys with missing records may belong to another host and require operator
  investigation, not blanket revocation. Keep the state directory host-local.
- Leases default to a 75-minute idle budget and 90-minute TTL. SIGINT/SIGTERM
  trigger cleanup; a killed host may leave a lease until expiry and a key until
  a later local sweep. Never treat a missing receipt as proof of cleanup.
