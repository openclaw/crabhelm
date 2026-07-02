# `openclaw-core` Crabbox profile contract

Crabhelm does not send lifecycle commands, provider selection, credentials, class, or server-type overrides in workspace requests. A reviewed Crabbox controller profile owns all executable setup.

The fixed profile must:

- accept only `profile=openclaw-core` with a policy-fixed TTL and idle timeout;
- create one OS identity and durable state root per workspace;
- install one pinned OpenClaw release before running `bootstrap-child.sh`;
- stage a pinned Crabhelm package tarball locally and pass its absolute path plus SHA-256 through `CRABHELM_PLUGIN_TARBALL` and `CRABHELM_PLUGIN_SHA256`;
- pass the immutable child id as `CRABBOX_ADAPTER_ROOT_SESSION_ID`;
- provide a fixed parent Gateway host, port, TLS policy, and certificate fingerprint;
- route that host through an identity-bearing private ingress such as Tailscale Serve with the parent Gateway's native Tailscale authentication enabled; never distribute the parent's shared Gateway token to child boxes;
- run `bootstrap-child.sh` as the child service user;
- expose no public child Gateway port;
- preserve the adapter's stable provider identity and terminal `stopped` absence evidence.
- install Slack credentials as environment-backed SecretRefs for the first live profile; file/exec refs require the pinned OpenClaw release to ship `plugin-sdk/secret-input-runtime` and must be proven before use.
- install the exact pinned Slack plugin artifact from the appliance manifest;
- stage `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN` in a child-user-owned mode-`0600` source outside `$OPENCLAW_STATE_DIR`, never in adapter metadata or the installer environment. The guest installer activates it as `$OPENCLAW_STATE_DIR/.env` only after all package/plugin lifecycle work completes;
- use one Slack Socket Mode app credential pair per child for the evaluation profile. A shared relay is a separate future profile and must pin a Slack plugin release that implements the relay schema.

The bootstrap starts two independent processes in the same child box: the child Gateway on loopback and an OpenClaw node host connected outbound to the parent. First connection creates OpenClaw's normal pending `role: node` device request. A parent operator approves it using existing device pairing.

Parent config must explicitly allow the dangerous plugin commands before automatic reconciliation/removal:

```json5
{
  gateway: {
    nodes: {
      allowCommands: [
        "crabhelm.child.apply",
        "crabhelm.child.ingress",
        "crabhelm.child.pairing.approve"
      ]
    }
  }
}
```

The child Gateway is loopback-only and uses auth mode `none`; it is not the remote parent endpoint. Before any privileged package lifecycle or OpenClaw command, the guest installer and bootstrap remove `OPENCLAW_GATEWAY_TOKEN` and `OPENCLAW_GATEWAY_PASSWORD`; privileged npm runs through an empty environment. An ambient parent/shared token therefore cannot influence installation and cannot be sent back to the parent. The outbound node connection must succeed through the parent's identity-bearing private ingress, an exact required TLS fingerprint, and then native node pairing. The clean child allowlist contains only the Crabhelm and pinned Slack plugins.

`crabhelm.child.status`, `crabhelm.child.health`, `crabhelm.child.drain.status`, and `crabhelm.child.pairing.list` are read-only and default-allowlisted for desktop/server platforms. `health` runs OpenClaw's bounded Slack live probe and model-auth status, returning sanitized metadata only. `drain.status` pages through local Gateway session metadata and returns only the active-run count and check time. `apply` mutates only the default model, fallback models, Slack DM/group policies, and child log level using OpenClaw's config mutation API; Slack enable requires the required child-local credential inputs to resolve without returning their values. `ingress` snapshots and disables configured channel enable flags, then restores them on re-enable. `pairing.approve` invokes OpenClaw's exact native Slack pairing CLI without a shell and records the approved subject. After provider absence, the parent invokes exact native `devices reject/remove` CLI arguments only when the enrolled device has the exact child id, optional expected display name, and exclusively the node role; it then verifies absence from a fresh device list. None of these commands accepts shell input or secret values.
