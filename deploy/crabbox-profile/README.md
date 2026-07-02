# `openclaw-core` appliance bundle

This directory is the provider-neutral guest overlay for Crabhelm's fixed Crabbox profile. It intentionally does not copy or reimplement a private provider lifecycle. The dedicated Linux controller continues to own acquire, resolve, attest, and release through a reviewed public Crabbox `external` adapter configuration.

The shipped contract requires exactly four hours for both TTL and idle timeout. It is an evaluation/pilot profile and will expire; it is not an always-on production appliance. Persistent or renewable operation needs a separately reviewed controller profile and matching Crabhelm target values.

## Build

Supply a reviewed npm tarball containing the exact OpenClaw version named in `profile.conf`:

```bash
deploy/crabbox-profile/build-bundle.sh \
  --openclaw-tarball /absolute/path/to/openclaw-2026.6.11-beta.1.tgz \
  --slack-tarball /absolute/path/to/openclaw-slack-2026.6.10.tgz \
  --output /absolute/empty/openclaw-core-bundle
```

The builder packages the current Crabhelm checkout, verifies every declared Slack dependency is embedded in the reviewed Slack tarball, repacks Slack with dependency resolution disabled, and emits a mode-private bundle plus `manifest_sha256`. The compiled Crabhelm artifact has no runtime npm dependencies. Pin the manifest digest in the private controller release. Do not fetch `latest` on a controller or child.

## Controller integration

The fixed controller must:

1. expose only `profile=openclaw-core` with `--forbid-class-override` and `--forbid-server-type-override`;
2. require the TTL, idle timeout, and headless capabilities from `profile.conf`;
3. acquire and durably record the provider identity before guest configuration;
4. stage a child-user-owned, non-symlink mode-`0600` credential source outside `$HOME/.openclaw` containing `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN`; obtain those values through the controller host's approved secret delivery, never a workspace request;
5. stage this exact bundle into the new guest without following symlinks;
6. run `guest-install.sh` as the child service user with `CRABHELM_BUNDLE_MANIFEST_SHA256` set to the pinned release digest and `CRABHELM_CREDENTIAL_FILE` set to the staged credential source;
7. pass the adapter-provided `CRABBOX_ADAPTER_ROOT_SESSION_ID` unchanged plus fixed parent host/port/TLS/fingerprint values;
8. report ready only after `guest-install.sh` succeeds; retain normal external-provider rollback on failure.

The controller request may carry metadata but never a command, provider, class, server type, credential, parent token, or artifact URL. Slack and inference credentials remain box-owned profile inputs and are not part of this bundle, installer environment, or the Crabhelm create request. The evaluation profile deliberately supports one concrete credential contract: environment-backed OpenAI inference plus one Slack Socket Mode bot/app token pair per child. `guest-install.sh` validates only the source file's metadata and required key names, installs OpenClaw and both plugins through empty/offline environments, then atomically activates the credentials at `$HOME/.openclaw/.env` before configuration and service installation.

`guest-install.sh` verifies the pinned manifest and every artifact, validates the owner-only credential source by key name without printing values, installs the exact OpenClaw tarball through an empty privileged environment, and installs the self-contained Crabhelm and Slack plugin artifacts with npm offline mode forced. The pinned OpenClaw package may fetch its own shrinkwrap-integrity-locked dependencies before credentials are activated; plugin installation itself performs no registry resolution. Only then does the installer activate the credential file and delegate to `bootstrap-child.sh`. Bootstrap configures Socket Mode SecretRefs, starts a loopback-only child Gateway, and starts the outbound node host using OpenClaw's native pairing.
