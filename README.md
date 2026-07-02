# Crabhelm

**Control your OpenClaw fleet.**

Crabhelm turns one OpenClaw core into the parent of many independently deployed child cores. Every child remains a complete OpenClaw installation with its own Gateway, OS identity, config, credentials, pairing store, sessions, and memory. The parent owns lifecycle and administrative reconciliation; it does not multiplex tenants through one Gateway.

Crabhelm is an OpenClaw plugin, not a second agent runtime. The parent core gets:

- an operator-facing web console;
- a `crabhelm` agent tool with OpenClaw approval gates for mutations;
- Gateway RPC methods for typed fleet operations;
- a background desired-state reconciler;
- Crabbox-backed child lifecycle with stable workspace identity and confirmed deletion;
- administrator-defined deployment targets that pin one Crabbox controller, token environment variable, region, and fixed appliance profile;
- a parent/child control link built on OpenClaw's native node pairing and command policy.

The web console and parent `crabhelm` tool can list and approve a child's native Slack pairing requests. Approval records the approved Slack subject; it does not claim that a GitHub maintainer identity and Slack identity are the same person. The web console can also discover organization members, team members, or repository maintainers through a read-only GitHub token, preview them, skip existing stable numeric identities, and create selected children in bounded chunks.

## Current slice

The current slice defines the parent/child domain, persists every fleet mutation, immutable policy version, and audit event in one transaction in a private WAL-mode SQLite database under the parent OpenClaw state root, and rotates the oldest audit metadata after 50,000 events. It provides CRUD/reconciliation, stages deletion safely, and includes both a deterministic simulator and the real Crabbox adapter boundary. Reconciliation is serialized per child and every observed-state write uses a monotonic record-revision compare-and-swap, so delayed probes cannot overwrite a newer operator action. Removal verifies ingress disable, a bounded content-free active-run drain, provider absence, and exact native parent-device pairing absence before marking a child deleted. The policy library provides field-level previews, generation compare-and-swap, an explicit converged-canary gate, bounded rollout results, and rollback by applying an earlier immutable version. Managed policy covers inference model/fallbacks, Slack enabled state, native DM/group access, and child log level; it never carries credentials or identity state. Child mode exposes native node commands for status, bounded model/access/log-level config apply, reversible channel-ingress disable, active-run drain status, Slack pairing list/approval, and sanitized operational probes. The parent accepts them only from the paired node with the deterministic id and display name for the exact child; mutation commands also require an explicit parent node allowlist. Convergence requires the child-local Gateway, exact managed policy, model-auth status, and—when enabled—a live Slack probe. The parent console and registry retain only allowlisted or bounded health/lifecycle metadata; raw prompts, messages, tool output, credential values, and opaque upstream error bodies are excluded. A digest-pinned `openclaw-core` appliance bundle builder and guest installer are included; installing that profile into a real dedicated controller remains environment work.

GitHub import uses the configured `CRABHELM_GITHUB_TOKEN` environment variable by default. Give it read-only organization Members access; the token remains in the parent process and is never persisted in Crabhelm state or sent to children.

## Run the product UI locally

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:4177`. The development server uses the same domain and reconciliation code as the plugin, with simulated child cores.

## Install into OpenClaw during development

```bash
pnpm check
npm pack --pack-destination /tmp
openclaw plugins install --force /tmp/openclaw-crabhelm-0.0.0.tgz
openclaw config set plugins.allow '["crabhelm"]' --strict-json --replace
openclaw gateway restart
```

The archive path is deliberate: installed OpenClaw plugins require compiled JavaScript, and packaging excludes development-only `node_modules` symlinks from the safety scan. `openclaw plugins inspect crabhelm --runtime --json` should report `status: "loaded"`, two HTTP routes, and no diagnostics.

The static console is served at `/plugins/crabhelm/ui/`; authenticated mutations use the parent Gateway's existing operator identity. Every authorized parent operator currently sees the full fleet. The “intended user” field is metadata; Slack approval records the approved Slack subject without claiming a verified GitHub-to-Slack identity link. No child-user access layer is introduced.

Creation is refused when the selected target fails local admission checks. Simulation is explicit and permanently labeled; simulated readiness is never presented as live infrastructure.

## Configure deployment targets

Targets are parent-administrator policy, not free-form create parameters. Operators choose a target id; Crabhelm derives and verifies its region and appliance profile before the claw and audit event enter SQLite. Provider/class/server overrides are never accepted from the web UI, API, or agent tool.

```json
{
  "plugins": {
    "entries": {
      "crabhelm": {
        "config": {
          "deployment": {
            "defaultTarget": "us-west",
            "targets": [
              {
                "id": "us-west",
                "label": "US West",
                "region": "us-west",
                "crabboxUrl": "https://crabbox-west.example.net",
                "tokenEnv": "CRABHELM_CRABBOX_WEST_TOKEN",
                "profile": "openclaw-core",
                "ttlSeconds": 14400,
                "idleTimeoutSeconds": 14400
              }
            ]
          }
        }
      }
    }
  }
}
```

Tokens stay in the parent process environment and are never written to the SQLite registry, audit rows, browser runtime description, or child configuration. A target without its URL or token remains visible with admission closed; other configured targets continue operating. Admission-open means local URL/token/profile validation passed, not that a controller health probe succeeded.

The child appliance is built from reviewed local artifacts, never `latest`:

```bash
deploy/crabbox-profile/build-bundle.sh \
  --openclaw-tarball /absolute/path/to/openclaw-2026.6.11-beta.1.tgz \
  --slack-tarball /absolute/path/to/openclaw-slack-2026.6.10.tgz \
  --output /absolute/empty/openclaw-core-bundle
```

Pin the emitted manifest digest in the private controller release. The shipped profile is a four-hour evaluation appliance, not an always-on production lease; a persistent/renewable profile requires a separate reviewed controller policy. See [the appliance profile](deploy/crabbox-profile/README.md).

## Non-negotiable invariants

- One child core equals one Gateway and one isolated OpenClaw state root.
- Fleet multi-tenancy never means multiple tenants inside one Gateway.
- Parent control uses native node pairing; child users still use native channel pairing and permission logic.
- No copying agent directories, OAuth state, pairing stores, sessions, or memory between children.
- Desired-state replication excludes secrets and runtime identity.
- Deletes are not complete until child ingress is disabled, active runs are drained, the exact provider resource is absent, and the exact native parent pairing is absent.
- Ambiguous creates/deletes remain visible and retryable; never silently adopted or forgotten.
- Target, region, and appliance profile must match administrator policy and become immutable after workspace allocation.
- Logs are metadata-only by default; no prompt, message, or tool content in parent state.

See [architecture](docs/architecture.md), [product contract](docs/product.md), and the [validation ledger](docs/validation.md).
