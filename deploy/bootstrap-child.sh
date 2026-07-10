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
system_gateway="${CRABHELM_SYSTEM_GATEWAY:-false}"
model="${CRABHELM_MODEL:-openai/gpt-5.5}"
router_base_url="${CRABHELM_ROUTER_BASE_URL:-}"
slack_enabled="${CRABHELM_SLACK_ENABLED:-false}"
openclaw_binary="${CRABHELM_OPENCLAW_BINARY:-$(command -v openclaw || true)}"
curl_binary="${CRABHELM_CURL_BINARY:-$(command -v curl || true)}"
runtime_bridge="${CRABHELM_RUNTIME_BRIDGE:-}"
runtime_bridge_sha256="${CRABHELM_RUNTIME_BRIDGE_SHA256:-}"
release_id="${CRABHELM_RELEASE_ID:-}"
policy_hash="${CRABHELM_POLICY_HASH:-}"
node_binary="$(command -v node || true)"

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
[[ "$model" =~ ^[a-z0-9][a-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._:-]*)+$ ]] || die "invalid inference model"
if [[ -n "$router_base_url" ]]; then
  [[ "$router_base_url" =~ ^https://[A-Za-z0-9._-]+(:[0-9]+)?$ ]] || die "invalid ClawRouter base URL"
  [[ "$model" = clawrouter/*/* ]] || die "ClawRouter requires a clawrouter/provider/model reference"
fi
[[ "$slack_enabled" = "true" || "$slack_enabled" = "false" ]] || die "invalid Slack desired state"
[[ "$system_gateway" = "true" || "$system_gateway" = "false" ]] || die "invalid system Gateway mode"
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
[[ "$runtime_bridge" = /* && -f "$runtime_bridge" && ! -L "$runtime_bridge" ]] || die "runtime bridge must be a regular absolute path"
[[ "$runtime_bridge_sha256" =~ ^[0-9a-f]{64}$ ]] || die "invalid runtime bridge digest"
[[ "$release_id" =~ ^[0-9a-f]{64}\.[0-9a-f]{64}\.[0-9a-f]{64}$ ]] || die "invalid appliance release identity"
if [[ "$standalone" = "true" ]]; then
  [[ "$policy_hash" =~ ^[0-9a-f]{64}$ ]] || die "invalid managed policy hash"
fi
[[ "$node_binary" = /* && -x "$node_binary" ]] || die "fixed profile must install Node.js before bootstrap"
command -v sha256sum >/dev/null || die "sha256sum is required"

# The child Gateway uses loopback auth=none and the node authenticates through
# private ingress plus native pairing. Never let an ambient parent/shared
# Gateway credential influence plugin installation or either service unit.
unset OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD

actual_sha256="$(sha256sum "$plugin_tarball" | awk '{print $1}')"
[[ "$actual_sha256" = "$plugin_sha256" ]] || die "plugin tarball digest mismatch"
actual_slack_sha256="$(sha256sum "$slack_plugin_tarball" | awk '{print $1}')"
[[ "$actual_slack_sha256" = "$slack_plugin_sha256" ]] || die "Slack plugin tarball digest mismatch"
actual_runtime_bridge_sha256="$(sha256sum "$runtime_bridge" | awk '{print $1}')"
[[ "$actual_runtime_bridge_sha256" = "$runtime_bridge_sha256" ]] || die "runtime bridge digest mismatch"

log_level=info
otel_state=disabled
managed_manifest="${OPENCLAW_STATE_DIR:-${HOME:-/tmp}/.openclaw}/managed/manifest.json"
if [[ -f "$managed_manifest" && ! -L "$managed_manifest" ]]; then
  observability_state="$("$node_binary" - "$managed_manifest" <<'NODE'
const { readFile } = await import("node:fs/promises");
const spec = JSON.parse(await readFile(process.argv[2], "utf8"));
const logLevel = spec?.observability?.logLevel;
if (!["error", "warn", "info", "debug"].includes(logLevel)) process.exit(2);
const otel = spec?.observability?.otel;
if (!otel?.enabled) {
  process.stdout.write(`${logLevel}\tdisabled`);
  process.exit(0);
}
const endpoint = new URL(otel.endpoint);
if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) process.exit(2);
const endpointBase = endpoint.toString().replace(/\/+$/, "");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(otel.serviceName)) process.exit(2);
if (![otel.traces, otel.metrics].every((value) => typeof value === "boolean") || otel.logs !== false) process.exit(2);
if (!otel.traces && !otel.metrics) process.exit(2);
if (typeof otel.sampleRate !== "number" || otel.sampleRate < 0 || otel.sampleRate > 1) process.exit(2);
if (!Number.isInteger(otel.flushIntervalMs) || otel.flushIntervalMs < 1000 || otel.flushIntervalMs > 300000) process.exit(2);
process.stdout.write(`${logLevel}\t${JSON.stringify({
  enabled: true,
  endpoint: endpointBase,
  tracesEndpoint: `${endpointBase}/v1/traces`,
  metricsEndpoint: `${endpointBase}/v1/metrics`,
  protocol: "http/protobuf",
  serviceName: otel.serviceName,
  traces: otel.traces,
  metrics: otel.metrics,
  logs: false,
  captureContent: {
    enabled: false,
    inputMessages: false,
    outputMessages: false,
    toolInputs: false,
    toolOutputs: false,
    systemPrompt: false,
    toolDefinitions: false,
  },
  sampleRate: otel.sampleRate,
  flushIntervalMs: otel.flushIntervalMs,
})}`);
NODE
)" || die "managed OpenTelemetry policy is invalid"
  IFS=$'\t' read -r log_level otel_state <<<"$observability_state"
fi

plugin_allow='["crabhelm","slack"]'
if [[ -n "$router_base_url" ]]; then
  plugin_allow='["crabhelm","slack","clawrouter"]'
fi
if [[ "$otel_state" != disabled ]]; then
  if [[ -n "$router_base_url" ]]; then
    plugin_allow='["crabhelm","slack","clawrouter","diagnostics-otel"]'
  else
    plugin_allow='["crabhelm","slack","diagnostics-otel"]'
  fi
fi
"$openclaw_binary" config set plugins.allow "$plugin_allow" --strict-json --replace
"$openclaw_binary" config set plugins.entries.crabhelm.enabled true --strict-json
"$openclaw_binary" config set plugins.entries.crabhelm.config.mode child
"$openclaw_binary" config set plugins.entries.crabhelm.config.childId "$child_id"
"$openclaw_binary" config set plugins.entries.crabhelm.hooks.allowPromptInjection true --strict-json
"$openclaw_binary" config set logging.level "$log_level"
if [[ "$otel_state" = disabled ]]; then
  "$openclaw_binary" config set plugins.entries.diagnostics-otel.enabled false --strict-json
  "$openclaw_binary" config set diagnostics.enabled false --strict-json
  "$openclaw_binary" config set diagnostics.otel.enabled false --strict-json
else
  "$openclaw_binary" config set plugins.entries.diagnostics-otel.enabled true --strict-json
  "$openclaw_binary" config set diagnostics.enabled true --strict-json
  "$openclaw_binary" config set diagnostics.otel "$otel_state" --strict-json --replace
fi
"$openclaw_binary" config set agents.defaults.model.primary "$model"
# ClawRouter owns upstream provider secrets and routing. The child receives only
# its scoped ClawRouter credential and this managed provider origin.
if [[ -n "$router_base_url" ]]; then
  "$openclaw_binary" config set plugins.entries.clawrouter.enabled true --strict-json
  "$openclaw_binary" config set models.providers.clawrouter.baseUrl "$router_base_url"
else
  "$openclaw_binary" config set plugins.entries.clawrouter.enabled false --strict-json
  if "$openclaw_binary" config get models.providers.clawrouter.baseUrl >/dev/null 2>&1; then
    "$openclaw_binary" config unset models.providers.clawrouter.baseUrl
  fi
fi
# Remove the retired Crabhelm-owned OpenAI proxy override from managed guests.
if "$openclaw_binary" config get models.providers.openai.baseUrl >/dev/null 2>&1; then
  "$openclaw_binary" config unset models.providers.openai.baseUrl
fi
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
if [[ "$system_gateway" != "true" ]]; then
  "$openclaw_binary" gateway install --force
  "$openclaw_binary" gateway start
fi

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

prepare_runtime_bridge() {
  local state_dir bridge_home bridge_file launcher_file launcher_temporary pid_file log_file runtime_env runtime_token_file old_pid node_binary
  state_dir="${OPENCLAW_STATE_DIR:-${HOME:-/tmp}/.openclaw}"
  bridge_home="$HOME/.local/share/crabhelm/runtime"
  bridge_file="$bridge_home/runtime-bridge.mjs"
  launcher_file="$bridge_home/start-runtime-bridge.sh"
  launcher_temporary="$launcher_file.new-$$"
  pid_file="$state_dir/crabhelm-runtime-bridge.pid"
  log_file="$state_dir/crabhelm-runtime-bridge.log"
  runtime_env="$state_dir/crabhelm-runtime.env"
  runtime_token_file="$state_dir/crabhelm-runtime-token"
  node_binary="$(command -v node)"
  [[ "$node_binary" = /* && -x "$node_binary" ]] || die "runtime Node.js binary is unavailable"
  [[ -f "$runtime_env" && ! -L "$runtime_env" && -O "$runtime_env" ]] || die "runtime environment is unavailable"
  [[ -f "$runtime_token_file" && ! -L "$runtime_token_file" && -O "$runtime_token_file" ]] || die "runtime credential is unavailable"
  install -d -m 0700 "$bridge_home" "$state_dir"
  install -m 0500 "$runtime_bridge" "$bridge_file"
  if [[ -f "$pid_file" && ! -L "$pid_file" ]]; then
    old_pid="$(tr -cd '0-9' <"$pid_file")"
    if [[ "$old_pid" =~ ^[0-9]+$ && -r "/proc/$old_pid/cmdline" ]] && tr '\0' '\n' <"/proc/$old_pid/cmdline" | grep -Fxq "$bridge_file"; then
      kill "$old_pid" 2>/dev/null || true
      for _ in {1..20}; do kill -0 "$old_pid" 2>/dev/null || break; sleep 0.1; done
    fi
  fi
  : >"$log_file"
  chmod 0600 "$log_file"
  if ! (set -o noclobber; : >"$launcher_temporary") 2>/dev/null; then
    die "runtime launcher staging path is unsafe"
  fi
  {
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'umask 077'
    printf 'state_dir=%q\nbridge_file=%q\npid_file=%q\nlog_file=%q\nruntime_env=%q\nruntime_token_file=%q\nnode_binary=%q\nopenclaw_binary=%q\n' \
      "$state_dir" "$bridge_file" "$pid_file" "$log_file" "$runtime_env" "$runtime_token_file" "$node_binary" "$openclaw_binary"
    printf '%s\n' \
      'if [[ -f "$pid_file" && ! -L "$pid_file" ]]; then' \
      '  old_pid="$(tr -cd '\''0-9'\'' <"$pid_file")"' \
      '  if [[ "$old_pid" =~ ^[0-9]+$ && -r "/proc/$old_pid/cmdline" ]] && tr '\''\0'\'' '\''\n'\'' <"/proc/$old_pid/cmdline" | grep -Fxq "$bridge_file"; then exit 0; fi' \
      'fi' \
      '[[ -f "$runtime_token_file" && ! -L "$runtime_token_file" && -O "$runtime_token_file" ]] || exit 1' \
      'exec 3<"$runtime_token_file"' \
      'OPENCLAW_STATE_DIR="$state_dir" CRABHELM_OPENCLAW_BINARY="$openclaw_binary" CRABHELM_RUNTIME_TOKEN_FILE="$runtime_token_file" CRABHELM_RUNTIME_TOKEN_FD=3 nohup "$node_binary" --env-file="$runtime_env" "$bridge_file" 3<&3 >>"$log_file" 2>&1 &' \
      'bridge_pid=$!' \
      'exec 3<&-' \
      'sleep 2' \
      'kill -0 "$bridge_pid" 2>/dev/null || exit 1' \
      'temporary_pid="$pid_file.new-$$"' \
      'printf '\''%s\n'\'' "$bridge_pid" >"$temporary_pid"' \
      'chmod 0600 "$temporary_pid"' \
      'mv -f "$temporary_pid" "$pid_file"'
  } >"$launcher_temporary"
  chmod 0500 "$launcher_temporary"
  mv -f "$launcher_temporary" "$launcher_file"
}

if [[ "$system_gateway" = "true" ]]; then
  [[ "$standalone" = "true" ]] || die "system Gateway mode requires standalone operation"
  prepare_runtime_bridge
  exit 0
fi

for _ in {1..60}; do
  if "$curl_binary" --fail --silent --show-error --max-time 2 http://127.0.0.1:18789/readyz >/dev/null; then
    if [[ "$standalone" = "true" ]]; then
      install -d -m 0700 "$HOME/.openclaw"
      prepare_runtime_bridge
      printf '%s:%s\n' "$release_id" "$policy_hash" >"$HOME/.openclaw/crabhelm-ready"
      chmod 0600 "$HOME/.openclaw/crabhelm-ready"
    fi
    exit 0
  fi
  sleep 1
done

die "child Gateway did not become ready"
