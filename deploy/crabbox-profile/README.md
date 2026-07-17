# Crabbox `openclaw-core` appliance

Provider-neutral guest overlay used by Crabhelm's Crabbox deployment adapter. Crabbox owns workspace acquisition, authenticated terminal transport, and release. The selected Crabhelm backend owns desired state, appliance delivery, and reconciliation.

## Build

```bash
deploy/crabbox-profile/build-bundle.sh \
  --node-tarball /absolute/node-v22.23.1-linux-x64.tar.xz \
  --openclaw-tarball /absolute/openclaw.tgz \
  --slack-tarball /absolute/slack.tgz \
  --otel-tarball /absolute/diagnostics-otel-with-dependencies.tgz \
  --output /absolute/empty/output
```

The builder pins the Linux x64 Node.js `22.23.1` runtime plus OpenClaw, Slack, and `diagnostics-otel` `2026.7.1`, packs the current Crabhelm source, verifies all artifacts, and emits `manifest.json`. The reviewed OpenClaw artifact is built from stable commit `2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4` with upstream managed-ClawRouter backport `6db586a388c639796e312811b4d9801ca6ce1806` and SQLite plugin-metadata migration backport `ef110e9a0f42e5c99d56f0126e7e42c4284865aa`; the registry artifact alone lacks those release-branch fixes. The profile pins the exact reviewed tarball SHA-256 before the builder reads its embedded source metadata. Pin exact manifest, archive, and Node digests only after a disposable routed canary passes. The installer always runs the reviewed Node artifact from a digest-specific path. Plugin inputs must contain their production dependencies under `package/node_modules`; lifecycle scripts and dependency declarations are removed from the reviewed appliance copy. Archive the output under a top-level `bundle/` directory because the Cloudflare installer executes `bundle/guest-install.sh`:

```bash
tar -C /path/to/parent -s '|^output|bundle|' -czf /tmp/crabhelm-bundle.tgz output
```

Upload the archive to `releases/<archive-sha256>.tgz` in the private R2 appliance bucket configured for the deployment, verify the remote bytes, set the archive and manifest digests in Wrangler configuration, then deploy the Worker.

## Guest sequence

1. Crabhelm generates a child-specific HMAC bootstrap URL containing the exact desired model and optional ClawRouter origin.
2. Guest downloads the private archive and credential file.
3. `guest-install.sh` verifies manifest/artifacts, installs pinned packages and the offline OTel exporter in sanitized environments, keeps the model credential in `$HOME/.openclaw/.env`, and installs the runtime workload credential owner-only for the bridge launcher. The bridge reads it through a private file descriptor and rotates it before expiry.
4. `bootstrap-child.sh` writes exact child, inference, and metadata-only OTel config, starts the loopback Gateway, and installs a private idempotent runtime-bridge launcher.
5. Crabhelm attaches through Crabbox and requires a real model turn through the desired model/router configuration before readiness, then launches the bridge. The bridge obtains short-lived one-use connection tickets and connects outbound to the per-claw coordinator.

Child credentials are exactly one of `OPENAI_API_KEY` or an epoch-scoped `CLAWROUTER_API_KEY`, plus the audience-bound Crabhelm runtime token and child id. In ClawRouter mode, upstream provider credentials remain in the separate ClawRouter installation. Slack and provider OAuth credentials stay in the selected Crabhelm backend. Secret values never appear in workspace requests, registry records, audit rows, or terminal evidence.
