# Crabbox `openclaw-core` appliance

Provider-neutral guest overlay used by Crabhelm's Crabbox deployment adapter. Crabbox owns workspace acquisition, authenticated terminal transport, and release. Cloudflare owns desired state, appliance delivery, and reconciliation.

## Build

```bash
deploy/crabbox-profile/build-bundle.sh \
  --node-tarball /absolute/node-v22.23.1-linux-x64.tar.xz \
  --openclaw-tarball /absolute/openclaw.tgz \
  --slack-tarball /absolute/slack.tgz \
  --otel-tarball /absolute/diagnostics-otel-with-dependencies.tgz \
  --output /absolute/empty/output
```

The builder pins the Linux x64 Node.js `22.23.1` runtime plus OpenClaw, Slack, and `diagnostics-otel` `2026.6.11`, packs the current Crabhelm source, verifies all artifacts, and emits `manifest.json`. The installer always runs the reviewed Node artifact from a digest-specific path. Plugin inputs must contain their production dependencies under `package/node_modules`; lifecycle scripts and dependency declarations are removed from the reviewed appliance copy. Archive the output under a top-level `bundle/` directory because the Cloudflare installer executes `bundle/guest-install.sh`:

```bash
tar -C /path/to/parent -s '|^output|bundle|' -czf /tmp/crabhelm-bundle.tgz output
```

Upload the archive to content-addressed remote R2 key `crabhelm-appliances/releases/<archive-sha256>.tgz`, verify the remote bytes, set the archive and manifest digests in Wrangler configuration, then deploy the Worker.

## Guest sequence

1. Cloudflare generates a child-specific HMAC bootstrap URL containing the exact desired model.
2. Guest downloads the private archive and credential file.
3. `guest-install.sh` verifies manifest/artifacts, installs pinned packages and the offline OTel exporter in sanitized environments, keeps the model credential in `$HOME/.openclaw/.env`, and installs the runtime workload credential owner-only for the bridge launcher. The bridge reads it through a private file descriptor and rotates it before expiry.
4. `bootstrap-child.sh` writes exact child and metadata-only OTel config, starts the loopback Gateway, and installs a private idempotent runtime-bridge launcher.
5. Crabhelm attaches through Crabbox and requires a real model turn before readiness, then launches the bridge. The bridge obtains short-lived one-use connection tickets and connects outbound to the per-claw Durable Object.

Child credentials are `OPENAI_API_KEY`, the audience-bound Crabhelm runtime token, and child id. Slack and provider OAuth credentials stay on Cloudflare. Secret values never appear in workspace requests, registry records, audit rows, or terminal evidence.
