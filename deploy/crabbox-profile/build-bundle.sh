#!/usr/bin/env bash
set -euo pipefail
umask 077

die() {
  printf '%s\n' "crabhelm appliance bundle: $*" >&2
  exit 1
}

usage() {
  printf '%s\n' "Usage: build-bundle.sh --node-tarball <absolute-path> --openclaw-tarball <absolute-path> --slack-tarball <absolute-path> --output <absolute-empty-directory>"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
# shellcheck disable=SC1091
source "$script_dir/profile.conf"
profile="${profile:?profile.conf must set profile}"
openclaw_version="${openclaw_version:?profile.conf must set openclaw_version}"
slack_plugin_version="${slack_plugin_version:?profile.conf must set slack_plugin_version}"
node_version="${node_version:?profile.conf must set node_version}"

node_source=
openclaw_source=
slack_source=
output=
while (( $# > 0 )); do
  case "$1" in
    --node-tarball)
      (( $# >= 2 )) || die "--node-tarball requires a value"
      node_source="$2"
      shift 2
      ;;
    --openclaw-tarball)
      (( $# >= 2 )) || die "--openclaw-tarball requires a value"
      openclaw_source="$2"
      shift 2
      ;;
    --slack-tarball)
      (( $# >= 2 )) || die "--slack-tarball requires a value"
      slack_source="$2"
      shift 2
      ;;
    --output)
      (( $# >= 2 )) || die "--output requires a value"
      output="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$node_source" = /* ]] || die "Node.js tarball path must be absolute"
[[ "$openclaw_source" = /* ]] || die "OpenClaw tarball path must be absolute"
[[ "$slack_source" = /* ]] || die "Slack plugin tarball path must be absolute"
[[ "$output" = /* ]] || die "output path must be absolute"
[[ -f "$node_source" && ! -L "$node_source" ]] || die "Node.js tarball must be a regular non-symlink file"
[[ -f "$openclaw_source" && ! -L "$openclaw_source" ]] || die "OpenClaw tarball must be a regular non-symlink file"
[[ -f "$slack_source" && ! -L "$slack_source" ]] || die "Slack plugin tarball must be a regular non-symlink file"
command -v node >/dev/null || die "node is required"
command -v npm >/dev/null || die "npm is required"
command -v sha256sum >/dev/null || die "sha256sum is required"
command -v tar >/dev/null || die "tar is required"

if [[ -e "$output" || -L "$output" ]]; then
  [[ -d "$output" && ! -L "$output" ]] || die "output must be a normal directory"
  [[ -z "$(find "$output" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die "output directory must be empty"
else
  install -d -m 0700 "$output"
fi
artifacts="$output/artifacts"
install -d -m 0700 "$artifacts"

node_root="node-v${node_version}-linux-x64"
tar -tJf "$node_source" | node -e '
const root = process.argv[1];
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const entries = Buffer.concat(chunks).toString("utf8").split(/\r?\n/).filter(Boolean);
  if (!entries.includes(`${root}/bin/node`) || entries.length > 20_000) process.exit(2);
  for (const entry of entries) {
    const parts = entry.split("/");
    if (!entry.startsWith(`${root}/`) || entry.startsWith("/") || parts.includes("..")) process.exit(2);
  }
});
' "$node_root" || die "Node.js tarball paths are unsafe"
install -m 0400 "$node_source" "$artifacts/node-linux-x64.tar.xz"

package_json="$(tar -xOf "$openclaw_source" package/package.json 2>/dev/null)" || die "OpenClaw tarball has no package/package.json"
reported_version="$(node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value.name !== "openclaw" || typeof value.version !== "string") process.exit(2);
  process.stdout.write(value.version);
});
' <<<"$package_json")" || die "OpenClaw package metadata is invalid"
[[ "$reported_version" = "$openclaw_version" ]] || die "OpenClaw tarball must contain version $openclaw_version"

slack_package_json="$(tar -xOf "$slack_source" package/package.json 2>/dev/null)" || die "Slack plugin tarball has no package/package.json"
reported_slack_version="$(node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value.name !== "@openclaw/slack" || typeof value.version !== "string") process.exit(2);
  process.stdout.write(value.version);
});
' <<<"$slack_package_json")" || die "Slack plugin package metadata is invalid"
[[ "$reported_slack_version" = "$slack_plugin_version" ]] || die "Slack plugin tarball must contain version $slack_plugin_version"

install -m 0400 "$openclaw_source" "$artifacts/openclaw.tgz"
slack_source_sha256="$(sha256sum "$slack_source")"
slack_source_sha256="${slack_source_sha256%% *}"
tar -tzf "$slack_source" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const entries = Buffer.concat(chunks).toString("utf8").split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.length > 20_000) process.exit(2);
  for (const entry of entries) {
    const parts = entry.split("/");
    if (!entry.startsWith("package/") || entry.startsWith("/") || parts.includes("..")) process.exit(2);
  }
});
' || die "Slack plugin tarball paths are unsafe"
slack_repack="$output/.slack-repack"
install -d -m 0700 "$slack_repack"
cleanup_slack_repack() {
  [[ "$slack_repack" = "$output/.slack-repack" ]] || return
  rm -rf -- "$slack_repack"
}
trap cleanup_slack_repack EXIT
tar -xzf "$slack_source" -C "$slack_repack" --no-same-owner
[[ -z "$(find "$slack_repack/package" -type l -print -quit)" ]] || die "Slack plugin tarball must not contain symlinks"
node - "$slack_repack/package/package.json" "$slack_source_sha256" <<'NODE'
const { access, readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const file = process.argv[2];
const sourceSha256 = process.argv[3];
const value = JSON.parse(await readFile(file, "utf8"));
if (value.name !== "@openclaw/slack" || value.version !== "2026.6.11") process.exit(2);
for (const dependency of Object.keys(value.dependencies ?? {})) {
  await access(path.join(path.dirname(file), "node_modules", ...dependency.split("/"), "package.json"));
}
for (const key of ["dependencies", "devDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies", "scripts"]) delete value[key];
value.crabhelmAppliance = { dependenciesEmbedded: true, sourceSha256 };
await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400 });
NODE
tar -czf "$artifacts/slack.tgz" -C "$slack_repack" package
chmod 0400 "$artifacts/slack.tgz"
cleanup_slack_repack
trap - EXIT
pack_output="$(cd -- "$repo_root" && npm pack --pack-destination "$artifacts")" || die "Crabhelm npm pack failed"
crabhelm_filename="$(printf '%s\n' "$pack_output" | tail -n 1)"
[[ "$crabhelm_filename" != */* && "$crabhelm_filename" = *.tgz ]] || die "Crabhelm pack filename is unsafe"
mv -- "$artifacts/$crabhelm_filename" "$artifacts/crabhelm.tgz"
chmod 0400 "$artifacts/crabhelm.tgz"

install -m 0500 "$repo_root/deploy/bootstrap-child.sh" "$output/bootstrap-child.sh"
install -m 0500 "$script_dir/guest-install.sh" "$output/guest-install.sh"

openclaw_sha256="$(sha256sum "$artifacts/openclaw.tgz")"
openclaw_sha256="${openclaw_sha256%% *}"
node_sha256="$(sha256sum "$artifacts/node-linux-x64.tar.xz")"
node_sha256="${node_sha256%% *}"
slack_sha256="$(sha256sum "$artifacts/slack.tgz")"
slack_sha256="${slack_sha256%% *}"
crabhelm_sha256="$(sha256sum "$artifacts/crabhelm.tgz")"
crabhelm_sha256="${crabhelm_sha256%% *}"
bootstrap_sha256="$(sha256sum "$output/bootstrap-child.sh")"
bootstrap_sha256="${bootstrap_sha256%% *}"
guest_install_sha256="$(sha256sum "$output/guest-install.sh")"
guest_install_sha256="${guest_install_sha256%% *}"

crabhelm_version="$(node -p 'require(process.argv[1]).version' "$repo_root/package.json")"
node - "$output/manifest.json" "$node_version" "$node_sha256" "$openclaw_version" "$openclaw_sha256" "$slack_plugin_version" "$slack_sha256" "$crabhelm_version" "$crabhelm_sha256" "$bootstrap_sha256" "$guest_install_sha256" <<'NODE'
const [file, nodeVersion, nodeSha256, openclawVersion, openclawSha256, slackVersion, slackSha256, crabhelmVersion, crabhelmSha256, bootstrapSha256, guestInstallSha256] = process.argv.slice(2);
const manifest = {
  schemaVersion: 1,
  profile: "openclaw-core",
  node: { file: "artifacts/node-linux-x64.tar.xz", version: nodeVersion, platform: "linux", arch: "x64", sha256: nodeSha256 },
  openclaw: { file: "artifacts/openclaw.tgz", version: openclawVersion, sha256: openclawSha256 },
  slack: { file: "artifacts/slack.tgz", version: slackVersion, sha256: slackSha256 },
  crabhelm: { file: "artifacts/crabhelm.tgz", version: crabhelmVersion, sha256: crabhelmSha256 },
  bootstrap: { file: "bootstrap-child.sh", sha256: bootstrapSha256 },
  guestInstall: { file: "guest-install.sh", sha256: guestInstallSha256 },
};
await import("node:fs/promises").then(({ writeFile }) => writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 }));
NODE
chmod 0400 "$output/manifest.json"
manifest_sha256="$(sha256sum "$output/manifest.json")"
manifest_sha256="${manifest_sha256%% *}"
printf '%s\n' "bundle=$output"
printf '%s\n' "profile=$profile"
printf '%s\n' "node_version=$node_version"
printf '%s\n' "openclaw_version=$openclaw_version"
printf '%s\n' "slack_plugin_version=$slack_plugin_version"
printf '%s\n' "manifest_sha256=$manifest_sha256"
