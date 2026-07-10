# Changelog

## Unreleased

- Add a locked disposable FakeCo AWS foundation with exact GitHub OIDC deploy/teardown identities, external digest-pinned ECR, bounded workload and CloudFormation roles, capped retention/cost settings, offline render/verify/teardown planning, and manual standard-only workflows that never read secret values.
- Add AWS as an alternative per-installation control-plane backend with a singleton ECS/Fargate service, ALB OIDC and WebSockets, PostgreSQL RDS, private S3 stores, and SQS audit delivery; Cloudflare remains the reference backend, and active-active shared-fleet operation is unsupported.
- Separate public example configuration from private deployment values, use documented public model identifiers, and keep live validation identifiers out of source.
- Harden the public Worker boundary with exact HTTPS console/runtime origin isolation, cross-site mutation rejection, minimum-strength bootstrap HMAC admission, and non-cacheable OAuth redirects.
- Isolate the OpenClaw runtime under a dedicated unprivileged service account and lock agent-workspace egress to loopback, DNS, NTP, DHCP, and TCP 443 with instance-metadata endpoints denied before credentials land. Root-owned boot policy and live-rule readiness checks fail closed by default; `CRABHELM_EGRESS_LOCKDOWN=off` is the explicit escape hatch.
- Add managed, metadata-only OpenTelemetry trace and metric export through the pinned offline `diagnostics-otel` plugin plus an optional bearer-authenticated Prometheus-compatible aggregate fleet endpoint.
- Add first-class ClawRouter inference: explicit full-model-to-canonical-provider mapping, per-fleet routing policy and per-claw model/provider/budget state, stable project attribution, hash-only epoch-scoped child credential registration and rotation, exact-router live inference readiness proof, desired/observed health and bounded usage visibility, AWS parameters/secrets, and removal of the duplicate Crabhelm-owned edge model proxy.
- Add per-claw appliance manifest, archive, and bootstrap-Node digest overrides so one allocated claw can canary a reviewed release before the fleet default changes.
- Add per-claw credential rotation: bumping the credential epoch (console button, `POST /api/claws/<id>/rotate-credentials`, or admin RPC) drives one release-pinned in-place reinstall that re-fetches rotated Worker secrets before the claw reports ready again.
- Allow OpenClaw GitHub organization members through Cloudflare Access and recognize configured administrator identities.
- Add Cloudflare Access identity, signed central Slack ingress, encrypted per-claw HTTPS runtime dispatch, GitHub OAuth with governed tools, confirmation controls, runtime replacement, and live integration status; remove operator-token and raw-credential setup from the console.
