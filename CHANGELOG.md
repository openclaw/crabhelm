# Changelog

## Unreleased

- Add an experimental edge model proxy (`CRABHELM_MODEL_PROXY`, default `off`): when enabled, a child receives a per-claw, audience-bound model token and an edge base URL instead of the raw `OPENAI_API_KEY`, and its OpenClaw OpenAI provider is rerouted through the Worker, which injects the real key. The raw provider key never reaches the agent VM. Requires the `MODEL_SIGNING_SECRET` Worker secret and an appliance rebuild; validate on staging before enabling.
- Allow OpenClaw GitHub organization members through Cloudflare Access and recognize the `steipete` GitHub email identities as Crabhelm administrators.
- Add Cloudflare Access identity, signed central Slack ingress, encrypted per-claw HTTPS runtime dispatch, GitHub OAuth with governed tools, confirmation controls, runtime replacement, and live integration status; remove operator-token and raw-credential setup from the console.
