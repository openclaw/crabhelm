#!/usr/bin/env bash
set -euo pipefail
umask 077

die() {
  printf '%s\n' "crabhelm guest install: $*" >&2
  exit 1
}

install_stage=initial
: > /tmp/crabhelm-install-failed-stage
trap 'printf "%s\n" "$install_stage" > /tmp/crabhelm-install-failed-stage' ERR

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
manifest="$script_dir/manifest.json"
expected_manifest_sha256="${CRABHELM_BUNDLE_MANIFEST_SHA256:-}"
expected_node_sha256="${CRABHELM_NODE_SHA256:-}"
pinned_node_version=22.23.1
node_artifact="$script_dir/artifacts/node-linux-x64.tar.xz"

# Parent/shared Gateway credentials never belong in the child and must not
# reach package lifecycle scripts, version probes, or service installation.
unset OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD

[[ "$expected_manifest_sha256" =~ ^[0-9a-f]{64}$ ]] || die "fixed controller must supply the reviewed manifest digest"
[[ "$expected_node_sha256" =~ ^[0-9a-f]{64}$ ]] || die "fixed controller must supply the reviewed Node.js digest"
[[ -f "$manifest" && ! -L "$manifest" ]] || die "bundle manifest is missing or unsafe"
sha256sum_binary="$(command -v sha256sum || true)"
[[ "$sha256sum_binary" = /* && -x "$sha256sum_binary" ]] || die "sha256sum is required"
curl_binary="$(command -v curl || true)"
[[ "$curl_binary" = /* && -x "$curl_binary" ]] || die "curl is required"

actual_manifest_sha256="$(sha256sum "$manifest")"
install_stage=verify
actual_manifest_sha256="${actual_manifest_sha256%% *}"
[[ "$actual_manifest_sha256" = "$expected_manifest_sha256" ]] || die "bundle manifest digest mismatch"
[[ -f "$node_artifact" && ! -L "$node_artifact" ]] || die "pinned Node.js artifact is missing or unsafe"
actual_node_sha256="$(sha256sum "$node_artifact")"
actual_node_sha256="${actual_node_sha256%% *}"
[[ "$actual_node_sha256" = "$expected_node_sha256" ]] || die "pinned Node.js artifact digest mismatch"

runtime_root="$HOME/.local/share/crabhelm/node-v$pinned_node_version-linux-x64"
install_stage=node
current_node="$(command -v node || true)"
current_node_major=""
if [[ "$current_node" = /* && -x "$current_node" ]]; then
  current_node_major="$($current_node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
fi
if [[ "$current_node_major" =~ ^[0-9]+$ ]] && (( current_node_major >= 22 )); then
  node_binary="$current_node"
else
  [[ "$(uname -s)" = Linux && "$(uname -m)" = x86_64 ]] || die "pinned Node.js fallback requires Linux x64"
  node_binary="$runtime_root/bin/node"
  if [[ ! -x "$node_binary" ]]; then
    install -d -m 0700 "$runtime_root"
    tar -xJf "$node_artifact" -C "$runtime_root" --strip-components=1
  fi
  [[ -f "$node_binary" && ! -L "$node_binary" && -x "$node_binary" ]] || die "pinned Node.js runtime is unsafe"
  [[ "$($node_binary --version)" = "v$pinned_node_version" ]] || die "pinned Node.js runtime version mismatch"
fi
runtime_bin="$(dirname -- "$node_binary")"
npm_binary="$(command -v npm || true)"
if [[ ! -x "$npm_binary" ]]; then
  npm_binary="$runtime_bin/npm"
fi
[[ "$npm_binary" = /* && -x "$npm_binary" ]] || die "npm is required at an absolute executable path"
runtime_path="$runtime_bin:$(dirname -- "$npm_binary"):$(dirname -- "$sha256sum_binary"):/usr/local/bin:/usr/bin:/bin"

manifest_values="$("$node_binary" - "$manifest" <<'NODE'
const manifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(process.argv[2], "utf8")));
const sha = /^[0-9a-f]{64}$/;
const expected = {
  schemaVersion: 1,
  profile: "openclaw-core",
  nodeFile: "artifacts/node-linux-x64.tar.xz",
  openclawFile: "artifacts/openclaw.tgz",
  slackFile: "artifacts/slack.tgz",
  crabhelmFile: "artifacts/crabhelm.tgz",
  bootstrapFile: "bootstrap-child.sh",
  guestInstallFile: "guest-install.sh",
};
if (
  manifest.schemaVersion !== expected.schemaVersion || manifest.profile !== expected.profile ||
  manifest.node?.file !== expected.nodeFile || manifest.node?.version !== "22.23.1" ||
  manifest.node?.platform !== "linux" || manifest.node?.arch !== "x64" ||
  manifest.openclaw?.file !== expected.openclawFile || manifest.slack?.file !== expected.slackFile ||
  manifest.crabhelm?.file !== expected.crabhelmFile ||
  manifest.bootstrap?.file !== expected.bootstrapFile || manifest.guestInstall?.file !== expected.guestInstallFile ||
  manifest.openclaw?.version !== "2026.6.11" || manifest.slack?.version !== "2026.6.11" ||
  typeof manifest.crabhelm?.version !== "string" || !manifest.crabhelm.version ||
  !sha.test(manifest.node?.sha256) || !sha.test(manifest.openclaw?.sha256) || !sha.test(manifest.slack?.sha256) ||
  !sha.test(manifest.crabhelm?.sha256) ||
  !sha.test(manifest.bootstrap?.sha256) || !sha.test(manifest.guestInstall?.sha256)
) process.exit(2);
for (const value of [
  manifest.node.version,
  manifest.node.sha256,
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
[[ "${#values[@]}" = 10 ]] || die "bundle manifest contract is incomplete"
node_version="${values[0]}"
node_sha256="${values[1]}"
openclaw_version="${values[2]}"
openclaw_sha256="${values[3]}"
slack_plugin_version="${values[4]}"
slack_sha256="${values[5]}"
crabhelm_version="${values[6]}"
crabhelm_sha256="${values[7]}"
bootstrap_sha256="${values[8]}"
guest_install_sha256="${values[9]}"

verify_artifact() {
  local relative="$1" expected="$2" file actual
  file="$script_dir/$relative"
  [[ -f "$file" && ! -L "$file" ]] || die "bundle artifact is missing or unsafe: $relative"
  actual="$(sha256sum "$file")"
  actual="${actual%% *}"
  [[ "$actual" = "$expected" ]] || die "bundle artifact digest mismatch: $relative"
}

verify_artifact artifacts/node-linux-x64.tar.xz "$node_sha256"
verify_artifact artifacts/openclaw.tgz "$openclaw_sha256"
verify_artifact artifacts/slack.tgz "$slack_sha256"
verify_artifact artifacts/crabhelm.tgz "$crabhelm_sha256"
verify_artifact bootstrap-child.sh "$bootstrap_sha256"
verify_artifact guest-install.sh "$guest_install_sha256"

state_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
install_stage=credential
credential_source="${CRABHELM_CREDENTIAL_FILE:-}"
[[ "$credential_source" = /* ]] || die "fixed controller must supply an absolute child credential file path"
"$node_binary" - "$credential_source" <<'NODE' || die "child credential source must be owner-only and contain the fixed profile inputs"
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
for (const required of ["OPENAI_API_KEY", "CRABHELM_CONTROL_URL", "CRABHELM_RUNTIME_TOKEN"]) {
  if (!keys.has(required)) process.exit(2);
}
if (keys.has("SLACK_BOT_TOKEN") !== keys.has("SLACK_APP_TOKEN")) process.exit(2);
NODE

previous_umask="$(umask)"
install_stage=package
umask 022
openclaw_prefix="$HOME/.local/share/crabhelm/openclaw-$openclaw_version"
install -d -m 0700 "$openclaw_prefix"
/usr/bin/env -i \
  HOME="$HOME" \
  PATH="$runtime_path" \
  npm_config_prefix="$openclaw_prefix" \
  "$npm_binary" install --global --no-audit --no-fund "$script_dir/artifacts/openclaw.tgz"
umask "$previous_umask"
if [[ -x "$openclaw_prefix/bin/openclaw" ]]; then
  openclaw_binary="$openclaw_prefix/bin/openclaw"
else
  openclaw_binary="$(command -v openclaw || true)"
fi
[[ "$openclaw_binary" = /* && -x "$openclaw_binary" ]] || die "OpenClaw installation did not create an executable"
version_output="$(/usr/bin/env -i HOME="$HOME" PATH="$runtime_path" "$openclaw_binary" --version)"
[[ "$version_output" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]] || die "installed OpenClaw version output is invalid"
installed_version="${BASH_REMATCH[1]}"
[[ "$installed_version" = "$openclaw_version" ]] || die "installed OpenClaw version does not match the bundle (got $installed_version)"
runtime_path="$openclaw_prefix/bin:$runtime_path"

plugin_env=(
  /usr/bin/env -i
  HOME="$HOME"
  USER="$(id -un)"
  PATH="$runtime_path"
  npm_config_offline=true
)
install_stage=plugin
for plugin_id in crabhelm slack; do
  "${plugin_env[@]}" "$openclaw_binary" plugins uninstall "$plugin_id" --force >/dev/null 2>&1 || true
done
"${plugin_env[@]}" "$openclaw_binary" plugins install "$script_dir/artifacts/crabhelm.tgz"
"${plugin_env[@]}" "$openclaw_binary" plugins install "$script_dir/artifacts/slack.tgz"

if [[ -e "$state_dir" || -L "$state_dir" ]]; then
  [[ -d "$state_dir" && ! -L "$state_dir" && -O "$state_dir" ]] || die "child state directory is unsafe"
else
  install -d -m 0700 "$state_dir"
fi
credential_file="$state_dir/.env"
install_stage=credential
if [[ -e "$credential_file" || -L "$credential_file" ]]; then
  "$node_binary" - "$credential_file" "$credential_source" <<'NODE' || die "child credential destination is unsafe or differs from the fixed profile"
const { lstat, readFile } = await import("node:fs/promises");
const [destination, source] = process.argv.slice(2);
const info = await lstat(destination);
if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) process.exit(2);
const withoutRuntimeToken = (body) => body.split(/\r?\n/).filter((line) => !line.startsWith("CRABHELM_RUNTIME_TOKEN=")).join("\n");
if (withoutRuntimeToken(await readFile(destination, "utf8")) !== withoutRuntimeToken(await readFile(source, "utf8"))) process.exit(2);
NODE
  install -m 0600 "$credential_source" "$credential_file"
else
  install -m 0600 "$credential_source" "$credential_file"
fi

managed_spec_source="${CRABHELM_MANAGED_SPEC_FILE:-}"
[[ "$managed_spec_source" = /* ]] || die "fixed controller must supply an absolute managed spec path"
install_stage=managed-spec
"$node_binary" - "$managed_spec_source" "$state_dir" "${CRABBOX_ADAPTER_ROOT_SESSION_ID:-}" <<'NODE' || die "managed identity and skill spec is invalid"
const { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } = await import("node:fs/promises");
const { dirname, join } = await import("node:path");
const [source, stateDir, childId] = process.argv.slice(2);
const info = await lstat(source);
if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) process.exit(2);
const raw = await readFile(source, "utf8");
if (Buffer.byteLength(raw, "utf8") > 384 * 1024) process.exit(2);
const spec = JSON.parse(raw);
if (spec.schemaVersion !== 1 || spec.readOnly !== true || spec.clawId !== childId || !spec.persona?.id || !spec.persona?.name) process.exit(2);
if (!Array.isArray(spec.capabilityIds) || !Array.isArray(spec.skills) || spec.skills.length > 100) process.exit(2);
const safePath = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const root = join(stateDir, "managed");
const staging = `${root}.new-${process.pid}`;
async function thaw(path) {
  try {
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink()) return;
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await thaw(join(path, entry.name));
    }
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
await thaw(staging);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true, mode: 0o700 });
const writes = [
  ["IDENTITY.md", spec.instructions?.identity ?? ""],
  ["SOUL.md", spec.instructions?.soul ?? ""],
  ["AGENTS.md", spec.instructions?.agents ?? ""],
  ["manifest.json", JSON.stringify(spec, null, 2) + "\n"],
];
const directories = new Set([staging]);
for (const skill of spec.skills) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(skill.slug) || !Array.isArray(skill.files) || skill.files.length > 50) process.exit(2);
  for (const file of skill.files) {
    if (!safePath.test(file.path) || file.path.startsWith(".") || file.path.includes("..") || typeof file.content !== "string") process.exit(2);
    writes.push([join("skills", skill.slug, file.path), file.content]);
  }
}
for (const [relative, content] of writes) {
  const destination = join(staging, relative);
  if (!destination.startsWith(`${staging}/`)) process.exit(2);
  let directory = dirname(destination);
  while (directory.startsWith(staging)) {
    directories.add(directory);
    if (directory === staging) break;
    directory = dirname(directory);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, content, { mode: 0o444, flag: "wx" });
  await chmod(destination, 0o444);
}
for (const directory of [...directories].sort((a, b) => b.length - a.length)) await chmod(directory, 0o555);
const previous = `${root}.previous`;
await thaw(previous);
await rm(previous, { recursive: true, force: true });
try { await rename(root, previous); } catch (error) { if (error?.code !== "ENOENT") throw error; }
await rename(staging, root);
await thaw(previous);
await rm(previous, { recursive: true, force: true });
NODE
install -d -m 0700 "$state_dir/workspace"

export CRABHELM_PLUGIN_TARBALL="$script_dir/artifacts/crabhelm.tgz"
export CRABHELM_PLUGIN_SHA256="$crabhelm_sha256"
export CRABHELM_SLACK_PLUGIN_TARBALL="$script_dir/artifacts/slack.tgz"
export CRABHELM_SLACK_PLUGIN_SHA256="$slack_sha256"
export CRABHELM_EXPECTED_SLACK_PLUGIN_VERSION="$slack_plugin_version"
export CRABHELM_EXPECTED_VERSION="$crabhelm_version"
export CRABHELM_OPENCLAW_BINARY="$openclaw_binary"
export CRABHELM_CURL_BINARY="$curl_binary"
export PATH="$runtime_path"
install_stage=bootstrap
exec /bin/bash "$script_dir/bootstrap-child.sh"
