# Changelog

## Unreleased

- Add AWS as an alternative per-installation control-plane backend with a singleton ECS/Fargate service, ALB OIDC and WebSockets, PostgreSQL RDS, private S3 stores, and SQS audit delivery; Cloudflare remains the reference backend, and active-active shared-fleet operation is unsupported.
- Separate public example configuration from private deployment values, use documented public model identifiers, and keep live validation identifiers out of source.
- Harden the public Worker boundary with exact HTTPS console/runtime origin isolation, cross-site mutation rejection, minimum-strength bootstrap HMAC admission, and non-cacheable OAuth redirects.
- Isolate the OpenClaw runtime under a dedicated unprivileged service account and lock agent-workspace egress to loopback, DNS, NTP, DHCP, and TCP 443 with instance-metadata endpoints denied before credentials land. Root-owned boot policy and live-rule readiness checks fail closed by default; `CRABHELM_EGRESS_LOCKDOWN=off` is the explicit escape hatch.
- Add managed, metadata-only OpenTelemetry trace and metric export through the pinned offline `diagnostics-otel` plugin.
- Add an experimental edge model proxy (`CRABHELM_MODEL_PROXY`, default `off`): when enabled, a child receives a per-claw, audience-bound model token and an edge base URL instead of the raw `OPENAI_API_KEY`, and its OpenClaw OpenAI provider is rerouted through the Worker, which injects the real key. The raw provider key never reaches the agent VM. Requires the `MODEL_SIGNING_SECRET` Worker secret and an appliance rebuild; validate on staging before enabling.
- Add per-claw appliance manifest, archive, and bootstrap-Node digest overrides so one allocated claw can canary a reviewed release before the fleet default changes.
- Add per-claw credential rotation: bumping the credential epoch (console button, `POST /api/claws/<id>/rotate-credentials`, or admin RPC) drives one release-pinned in-place reinstall that re-fetches rotated Worker secrets before the claw reports ready again.
- Allow OpenClaw GitHub organization members through Cloudflare Access and recognize configured administrator identities.
- Add Cloudflare Access identity, signed central Slack ingress, encrypted per-claw HTTPS runtime dispatch, GitHub OAuth with governed tools, confirmation controls, runtime replacement, and live integration status; remove operator-token and raw-credential setup from the console.
