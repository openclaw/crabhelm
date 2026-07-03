#!/usr/bin/env bash
set -euo pipefail

die() {
  printf '%s\n' "crabhelm child bootstrap: $*" >&2
  exit 1
}

child_id="${CRABBOX_ADAPTER_ROOT_SESSION_ID:-}"
parent_host="${CRABHELM_PARENT_HOST:-}"
parent_port="${CRABHELM_PARENT_PORT:-18789}"
plugin_tarball="${CRABHELM_PLUGIN_TARBALL:-}"
plugin_sha256="${CRABHELM_PLUGIN_SHA256:-}"
slack_plugin_tarball="${CRABHELM_SLACK_PLUGIN_TARBALL:-}"
slack_plugin_sha256="${CRABHELM_SLACK_PLUGIN_SHA256:-}"
parent_tls="${CRABHELM_PARENT_TLS:-true}"
parent_tls_fingerprint="${CRABHELM_PARENT_TLS_FINGERPRINT:-}"
standalone="${CRABHELM_STANDALONE:-false}"
model="${CRABHELM_MODEL:-openai/gpt-5.5}"
slack_enabled="${CRABHELM_SLACK_ENABLED:-false}"
openclaw_binary="${CRABHELM_OPENCLAW_BINARY:-$(command -v openclaw || true)}"
curl_binary="${CRABHELM_CURL_BINARY:-$(command -v curl || true)}"

[[ "$child_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "invalid child identity"
if [[ "$standalone" != "true" ]]; then
  [[ "$parent_host" =~ ^[A-Za-z0-9._:-]{1,253}$ ]] || die "invalid parent host"
  if [[ ! "$parent_port" =~ ^[0-9]{1,5}$ ]] || (( parent_port < 1 || parent_port > 65535 )); then
    die "invalid parent port"
  fi
fi
[[ "$plugin_tarball" = /* && -f "$plugin_tarball" && ! -L "$plugin_tarball" ]] || die "plugin tarball must be a regular absolute path"
[[ "$plugin_sha256" =~ ^[0-9a-f]{64}$ ]] || die "invalid plugin digest"
[[ "$slack_plugin_tarball" = /* && -f "$slack_plugin_tarball" && ! -L "$slack_plugin_tarball" ]] || die "Slack plugin tarball must be a regular absolute path"
[[ "$slack_plugin_sha256" =~ ^[0-9a-f]{64}$ ]] || die "invalid Slack plugin digest"
[[ "$model" =~ ^[a-z0-9][a-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || die "invalid inference model"
[[ "$slack_enabled" = "true" || "$slack_enabled" = "false" ]] || die "invalid Slack desired state"
if [[ "$standalone" = "true" ]]; then
  :
elif [[ "$parent_tls" = "true" ]]; then
  if [[ -n "$parent_tls_fingerprint" ]]; then
    [[ "$parent_tls_fingerprint" =~ ^[0-9a-fA-F]{64}$ ]] || die "invalid parent TLS fingerprint"
  fi
elif [[ "$parent_tls" != "false" || "${CRABHELM_ALLOW_PLAINTEXT_PARENT:-false}" != "true" ]]; then
  die "plaintext parent connection requires explicit fixed-profile opt-in"
fi
[[ "$openclaw_binary" = /* && -x "$openclaw_binary" ]] || die "fixed profile must install OpenClaw before bootstrap"
[[ "$curl_binary" = /* && -x "$curl_binary" ]] || die "curl is required"
command -v sha256sum >/dev/null || die "sha256sum is required"

# The child Gateway uses loopback auth=none and the node authenticates through
# private ingress plus native pairing. Never let an ambient parent/shared
# Gateway credential influence plugin installation or either service unit.
unset OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD

actual_sha256="$(sha256sum "$plugin_tarball" | awk '{print $1}')"
[[ "$actual_sha256" = "$plugin_sha256" ]] || die "plugin tarball digest mismatch"
actual_slack_sha256="$(sha256sum "$slack_plugin_tarball" | awk '{print $1}')"
[[ "$actual_slack_sha256" = "$slack_plugin_sha256" ]] || die "Slack plugin tarball digest mismatch"

"$openclaw_binary" config set plugins.allow '["crabhelm","slack"]' --strict-json --replace
"$openclaw_binary" config set plugins.entries.crabhelm.enabled true --strict-json
"$openclaw_binary" config set plugins.entries.crabhelm.config.mode child
"$openclaw_binary" config set plugins.entries.crabhelm.config.childId "$child_id"
"$openclaw_binary" config set plugins.entries.crabhelm.hooks.allowPromptInjection true --strict-json
"$openclaw_binary" config set agents.defaults.model.primary "$model"
"$openclaw_binary" config set agents.defaults.workspace "${OPENCLAW_STATE_DIR:-${HOME:-/tmp}/.openclaw}/workspace"
"$openclaw_binary" config set channels.slack.enabled "$slack_enabled" --strict-json
"$openclaw_binary" config set channels.slack.mode socket
"$openclaw_binary" config set channels.slack.botToken --ref-provider default --ref-source env --ref-id SLACK_BOT_TOKEN
"$openclaw_binary" config set channels.slack.appToken --ref-provider default --ref-source env --ref-id SLACK_APP_TOKEN
"$openclaw_binary" config set channels.slack.dmPolicy pairing
"$openclaw_binary" config set channels.slack.groupPolicy allowlist
"$openclaw_binary" config set gateway.mode local
"$openclaw_binary" config set gateway.bind loopback
"$openclaw_binary" config set gateway.auth.mode none
"$openclaw_binary" gateway install --force
"$openclaw_binary" gateway start

node_args=(
  --host "$parent_host"
  --port "$parent_port"
  --node-id "crabhelm-$child_id"
  --display-name "crabhelm:$child_id"
  --force
)
if [[ "$parent_tls" = "true" ]]; then
  node_args+=(--tls)
  if [[ -n "$parent_tls_fingerprint" ]]; then
    node_args+=(--tls-fingerprint "$parent_tls_fingerprint")
  fi
fi

if [[ "$standalone" != "true" ]]; then
  "$openclaw_binary" node install "${node_args[@]}"
  "$openclaw_binary" node start
fi

for _ in {1..60}; do
  if "$curl_binary" --fail --silent --show-error --max-time 2 http://127.0.0.1:18789/readyz >/dev/null; then
    if [[ "$standalone" = "true" ]]; then
      install -d -m 0700 "$HOME/.openclaw"
      printf '%s\n' "ready" >"$HOME/.openclaw/crabhelm-ready"
      chmod 0600 "$HOME/.openclaw/crabhelm-ready"
    fi
    exit 0
  fi
  sleep 1
done

die "child Gateway did not become ready"
