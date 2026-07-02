#!/usr/bin/env bash
set -euo pipefail
umask 077

die() {
  printf '%s\n' "crabhelm guest install: $*" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
manifest="$script_dir/manifest.json"
expected_manifest_sha256="${CRABHELM_BUNDLE_MANIFEST_SHA256:-}"

# Parent/shared Gateway credentials never belong in the child and must not
# reach package lifecycle scripts, version probes, or service installation.
unset OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD

[[ "$expected_manifest_sha256" =~ ^[0-9a-f]{64}$ ]] || die "fixed controller must supply the reviewed manifest digest"
[[ -f "$manifest" && ! -L "$manifest" ]] || die "bundle manifest is missing or unsafe"
command -v node >/dev/null || die "node is required"
npm_binary="$(command -v npm || true)"
[[ "$npm_binary" = /* && -x "$npm_binary" ]] || die "npm is required at an absolute executable path"
command -v sha256sum >/dev/null || die "sha256sum is required"
command -v sudo >/dev/null || die "sudo is required for the fixed OpenClaw installation"

actual_manifest_sha256="$(sha256sum "$manifest")"
actual_manifest_sha256="${actual_manifest_sha256%% *}"
[[ "$actual_manifest_sha256" = "$expected_manifest_sha256" ]] || die "bundle manifest digest mismatch"

manifest_values="$(node - "$manifest" <<'NODE'
const manifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(process.argv[2], "utf8")));
const sha = /^[0-9a-f]{64}$/;
const expected = {
  schemaVersion: 1,
  profile: "openclaw-core",
  openclawFile: "artifacts/openclaw.tgz",
  slackFile: "artifacts/slack.tgz",
  crabhelmFile: "artifacts/crabhelm.tgz",
  bootstrapFile: "bootstrap-child.sh",
  guestInstallFile: "guest-install.sh",
};
if (
  manifest.schemaVersion !== expected.schemaVersion || manifest.profile !== expected.profile ||
  manifest.openclaw?.file !== expected.openclawFile || manifest.slack?.file !== expected.slackFile ||
  manifest.crabhelm?.file !== expected.crabhelmFile ||
  manifest.bootstrap?.file !== expected.bootstrapFile || manifest.guestInstall?.file !== expected.guestInstallFile ||
  manifest.openclaw?.version !== "2026.6.11-beta.1" || manifest.slack?.version !== "2026.6.10" ||
  typeof manifest.crabhelm?.version !== "string" || !manifest.crabhelm.version ||
  !sha.test(manifest.openclaw?.sha256) || !sha.test(manifest.slack?.sha256) ||
  !sha.test(manifest.crabhelm?.sha256) ||
  !sha.test(manifest.bootstrap?.sha256) || !sha.test(manifest.guestInstall?.sha256)
) process.exit(2);
for (const value of [
  manifest.openclaw.version,
  manifest.openclaw.sha256,
  manifest.slack.version,
  manifest.slack.sha256,
  manifest.crabhelm.version,
  manifest.crabhelm.sha256,
  manifest.bootstrap.sha256,
  manifest.guestInstall.sha256,
]) process.stdout.write(`${value}\n`);
NODE
)" || die "bundle manifest contract is invalid"
values=()
while IFS= read -r value; do
  values+=("$value")
done <<<"$manifest_values"
[[ "${#values[@]}" = 8 ]] || die "bundle manifest contract is incomplete"
openclaw_version="${values[0]}"
openclaw_sha256="${values[1]}"
slack_plugin_version="${values[2]}"
slack_sha256="${values[3]}"
crabhelm_version="${values[4]}"
crabhelm_sha256="${values[5]}"
bootstrap_sha256="${values[6]}"
guest_install_sha256="${values[7]}"

verify_artifact() {
  local relative="$1" expected="$2" file actual
  file="$script_dir/$relative"
  [[ -f "$file" && ! -L "$file" ]] || die "bundle artifact is missing or unsafe: $relative"
  actual="$(sha256sum "$file")"
  actual="${actual%% *}"
  [[ "$actual" = "$expected" ]] || die "bundle artifact digest mismatch: $relative"
}

verify_artifact artifacts/openclaw.tgz "$openclaw_sha256"
verify_artifact artifacts/slack.tgz "$slack_sha256"
verify_artifact artifacts/crabhelm.tgz "$crabhelm_sha256"
verify_artifact bootstrap-child.sh "$bootstrap_sha256"
verify_artifact guest-install.sh "$guest_install_sha256"

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
  die "OpenClaw appliance requires Node.js 22 or newer"
fi

state_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
credential_source="${CRABHELM_CREDENTIAL_FILE:-}"
[[ "$credential_source" = /* ]] || die "fixed controller must supply an absolute child credential file path"
node - "$credential_source" <<'NODE' || die "child credential source must be owner-only and contain the fixed profile inputs"
const { lstat, readFile } = await import("node:fs/promises");
const file = process.argv[2];
const info = await lstat(file);
if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) process.exit(2);
const body = await readFile(file, "utf8");
if (Buffer.byteLength(body, "utf8") > 64 * 1024) process.exit(2);
const keys = new Set();
for (const rawLine of body.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
  if (match) keys.add(match[1]);
}
for (const required of ["OPENAI_API_KEY", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) {
  if (!keys.has(required)) process.exit(2);
}
NODE

sudo -n /usr/bin/env -i \
  HOME=/root \
  PATH=/usr/local/bin:/usr/bin:/bin \
  "$npm_binary" install --global --no-audit --no-fund "$script_dir/artifacts/openclaw.tgz"
openclaw_binary="$(command -v openclaw || true)"
[[ "$openclaw_binary" = /* && -x "$openclaw_binary" ]] || die "OpenClaw installation did not create an executable"
installed_version="$(/usr/bin/env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin "$openclaw_binary" --version | awk '{print $2}')"
[[ "$installed_version" = "$openclaw_version" ]] || die "installed OpenClaw version does not match the bundle"

plugin_env=(
  /usr/bin/env -i
  HOME="$HOME"
  USER="$(id -un)"
  PATH=/usr/local/bin:/usr/bin:/bin
  npm_config_offline=true
)
"${plugin_env[@]}" "$openclaw_binary" plugins install "$script_dir/artifacts/crabhelm.tgz"
"${plugin_env[@]}" "$openclaw_binary" plugins install "$script_dir/artifacts/slack.tgz"

if [[ -e "$state_dir" || -L "$state_dir" ]]; then
  [[ -d "$state_dir" && ! -L "$state_dir" && -O "$state_dir" ]] || die "child state directory is unsafe"
else
  install -d -m 0700 "$state_dir"
fi
credential_file="$state_dir/.env"
[[ ! -e "$credential_file" && ! -L "$credential_file" ]] || die "child credential destination must be absent before activation"
install -m 0600 "$credential_source" "$credential_file"

export CRABHELM_PLUGIN_TARBALL="$script_dir/artifacts/crabhelm.tgz"
export CRABHELM_PLUGIN_SHA256="$crabhelm_sha256"
export CRABHELM_SLACK_PLUGIN_TARBALL="$script_dir/artifacts/slack.tgz"
export CRABHELM_SLACK_PLUGIN_SHA256="$slack_sha256"
export CRABHELM_EXPECTED_SLACK_PLUGIN_VERSION="$slack_plugin_version"
export CRABHELM_EXPECTED_VERSION="$crabhelm_version"
exec /bin/bash "$script_dir/bootstrap-child.sh"
