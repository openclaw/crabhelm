# Changelog

## Unreleased

- Add per-claw appliance manifest, archive, and bootstrap-Node digest overrides so one allocated claw can canary a reviewed release before the fleet default changes.
- Allow OpenClaw GitHub organization members through Cloudflare Access and recognize the `steipete` GitHub email identities as Crabhelm administrators.
- Add Cloudflare Access identity, signed central Slack ingress, encrypted per-claw HTTPS runtime dispatch, GitHub OAuth with governed tools, confirmation controls, runtime replacement, and live integration status; remove operator-token and raw-credential setup from the console.
