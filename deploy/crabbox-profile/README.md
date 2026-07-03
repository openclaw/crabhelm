# Crabbox `openclaw-core` appliance

Provider-neutral guest overlay used by Crabhelm's Crabbox deployment adapter. Crabbox owns workspace acquisition, authenticated terminal transport, and release. Cloudflare owns desired state, appliance delivery, and reconciliation.

## Build

```bash
deploy/crabbox-profile/build-bundle.sh \
  --node-tarball /absolute/node-v22.23.1-linux-x64.tar.xz \
  --openclaw-tarball /absolute/openclaw.tgz \
  --slack-tarball /absolute/slack.tgz \
  --output /absolute/empty/output
```

The builder pins a Linux x64 Node.js `22.23.1` fallback plus OpenClaw and Slack `2026.6.11`, packs the current Crabhelm source, verifies all artifacts, and emits `manifest.json`. Archive the output under a top-level `bundle/` directory because the Cloudflare installer executes `bundle/guest-install.sh`:

```bash
tar -C /path/to/parent -s '|^output|bundle|' -czf /tmp/crabhelm-bundle.tgz output
```

Upload the archive to `crabhelm-appliances/openclaw-core/bundle.tgz` in remote R2, then set `APPLIANCE_MANIFEST_SHA256` to the manifest digest and deploy the Worker.

## Guest sequence

1. Cloudflare generates a child-specific HMAC bootstrap URL containing the exact desired model and Slack state.
2. Guest downloads the private archive and credential file.
3. `guest-install.sh` verifies manifest/artifacts, installs pinned packages in sanitized environments, and activates credentials at `$HOME/.openclaw/.env`.
4. `bootstrap-child.sh` writes exact child config and starts the loopback Gateway.
5. Crabhelm attaches through Crabbox and requires a real model turn before readiness.

Required credential: `OPENAI_API_KEY`. Slack tokens are an all-or-none optional pair. Secret values never appear in workspace requests, registry records, audit rows, or terminal evidence.
