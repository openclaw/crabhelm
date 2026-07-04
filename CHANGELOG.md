# Changelog

## Unreleased

- Add per-claw credential rotation: bumping the credential epoch (console button, `POST /api/claws/<id>/rotate-credentials`, or admin RPC) drives one release-pinned in-place reinstall that re-fetches rotated Worker secrets before the claw reports ready again.
- Allow OpenClaw GitHub organization members through Cloudflare Access and recognize the `steipete` GitHub email identities as Crabhelm administrators.
- Add Cloudflare Access identity, signed central Slack ingress, encrypted per-claw HTTPS runtime dispatch, GitHub OAuth with governed tools, confirmation controls, runtime replacement, and live integration status; remove operator-token and raw-credential setup from the console.
