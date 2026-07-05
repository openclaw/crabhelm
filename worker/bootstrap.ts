import type {
  ClawRecord,
  DisableResult,
  DrainResult,
  RevokeControlResult,
} from "../src/types.js";
import { clawCredentialsGeneration } from "../src/domain.js";
import { timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BOOTSTRAP_TOKEN_TTL_MS = 20 * 60 * 1000;
type WorkerWebSocket = WebSocket & { accept(): void };
type WorkspaceTerminalState =
  | "ready"
  | "started"
  | "installing-download"
  | "installing-openclaw"
  | "installing-plugin"
  | "installing-bootstrap"
  | "install-failed-credential"
  | "install-failed-package"
  | "install-failed-plugin-duplicate"
  | "install-failed-npm"
  | "install-failed-bootstrap"
  | "install-failed-artifact"
  | "install-failed-version"
  | "install-failed-state"
  | "install-failed-requirement"
  | "install-failed-credential-source"
  | "install-failed-sudo"
  | "install-failed-node"
  | "install-failed-npm-tool"
  | "install-failed-sha256"
  | "install-failed-unknown"
  | "pending"
  | "binary-failed"
  | "runtime-failed"
  | "config-failed"
  | "restart-failed"
  | "gateway-failed"
  | "turn-failed"
  | "output-failed"
  | "output-schema-failed"
  | "output-count-failed"
  | "output-value-failed";

export class CrabboxWorkspaceBootstrap {
  readonly #brokerToken: string;
  readonly #publicUrl: string;
  readonly #releaseId: string;
  readonly #archiveId: string;
  readonly #signingSecret: string;
  readonly #coordinators?: { getByName(name: string): { runtimeStatus(): Promise<{ pending: number; running: number; awaitingDelivery: number }> } };

  constructor(options: {
    brokerToken: string;
    publicUrl: string;
    releaseId: string;
    archiveId: string;
    signingSecret: string;
    coordinators?: { getByName(name: string): { runtimeStatus(): Promise<{ pending: number; running: number; awaitingDelivery: number }> } };
  }) {
    if (!/^[0-9a-f]{64}$/u.test(options.releaseId)) {
      throw new Error("Crabbox appliance release id must be a SHA-256 digest");
    }
    if (!/^[0-9a-f]{64}$/u.test(options.archiveId)) {
      throw new Error("Crabbox appliance archive id must be a SHA-256 digest");
    }
    this.#brokerToken = options.brokerToken;
    this.#publicUrl = new URL(options.publicUrl).origin;
    this.#releaseId = options.releaseId;
    this.#archiveId = options.archiveId;
    this.#signingSecret = options.signingSecret;
    this.#coordinators = options.coordinators;
  }

  async command(claw: ClawRecord): Promise<string> {
    return this.#launchCommand(claw);
  }

  async #launchCommand(claw: ClawRecord): Promise<string> {
    const token = await bootstrapToken(
      this.#signingSecret,
      claw.id,
      this.#releaseId,
      this.#archiveId,
      Date.now() + BOOTSTRAP_TOKEN_TTL_MS,
    );
    const credentialsGeneration = clawCredentialsGeneration(claw);
    const installUrl = new URL(
      `/bootstrap/${encodeURIComponent(claw.id)}/install.sh`,
      this.#publicUrl,
    );
    installUrl.searchParams.set("model", claw.desired.inference.model);
    installUrl.searchParams.set("slack", "false");
    if (credentialsGeneration > 1) {
      installUrl.searchParams.set("credentials", String(credentialsGeneration));
    }
    return [
      `CRABHELM_BOOTSTRAP_TOKEN=${shellQuote(token)}`,
      "nohup",
      "bash",
      "-c",
      shellQuote(
        `installer=$(mktemp) && trap 'rm -f "$installer"' EXIT && curl --fail --silent --show-error --location --header "Authorization: Bearer $CRABHELM_BOOTSTRAP_TOKEN" ${shellQuote(installUrl.toString())} -o "$installer" && touch ${shellQuote(this.#retryMarker(credentialsGeneration))} && exec timeout --signal=TERM --kill-after=10s 10m bash "$installer"`,
      ),
      ">/tmp/crabhelm-install.log 2>&1 </dev/null &",
    ].join(" ");
  }

  // Epoch 1 keeps the historical marker path so claws installed before
  // credential rotation existed never relaunch on a Worker deploy.
  #retryMarker(credentialsGeneration: number): string {
    return credentialsGeneration > 1
      ? `/tmp/crabhelm-attempt-${this.#releaseId}-c${credentialsGeneration}`
      : `/tmp/crabhelm-attempt-${this.#releaseId}`;
  }

  async inspect(
    claw: ClawRecord,
    workspace: { status: string; attachUrl?: string },
  ): Promise<{ ready: boolean; message: string; gatewayVersion?: string }> {
    if (!workspace.attachUrl) {
      return { ready: false, message: "Workspace ready; terminal bootstrap route pending" };
    }
    let result: WorkspaceTerminalState;
    try {
      const probeLabel = `CRABHELM_${crypto.randomUUID().replaceAll("-", "")}`;
      const credentialsGeneration = clawCredentialsGeneration(claw);
      result = await inspectTerminal(
        workspace.attachUrl,
        this.#brokerToken,
        claw.desired.inference.model,
        credentialsGeneration,
        bootstrapStatusCommand(
          await this.#launchCommand(claw),
          probeLabel,
          this.#retryMarker(credentialsGeneration),
          this.#releaseId,
          credentialsGeneration,
        ),
        probeLabel,
      );
    } catch (error) {
      console.error(JSON.stringify({
        event: "crabbox_workspace_inspect_failed",
        error: error instanceof Error ? error.message : "unknown terminal inspection failure",
      }));
      return { ready: false, message: "Workspace ready; terminal bootstrap inspection pending" };
    }
    if (result === "ready") {
      return {
        ready: true,
        message: "OpenClaw Gateway and live inference probe are healthy",
        gatewayVersion: "2026.6.11",
      };
    }
    return {
      ready: false,
      message: result === "started"
        ? "Workspace ready; OpenClaw installation is running"
        : result === "installing-download"
        ? "Workspace ready; downloading the reviewed appliance from Cloudflare"
        : result === "installing-openclaw"
        ? "Workspace ready; installing the pinned OpenClaw appliance"
        : result === "installing-plugin"
        ? "Workspace ready; installing the pinned OpenClaw plugins"
        : result === "installing-bootstrap"
        ? "Workspace ready; configuring and starting the OpenClaw Gateway"
        : result === "install-failed-credential"
        ? "Workspace ready; appliance retry needs credential activation recovery"
        : result === "install-failed-package"
        ? "Workspace ready; appliance package installation failed"
        : result === "install-failed-plugin-duplicate"
        ? "Workspace ready; managed plugin replacement failed"
        : result === "install-failed-npm"
        ? "Workspace ready; pinned OpenClaw package installation failed"
        : result === "install-failed-bootstrap"
        ? "Workspace ready; OpenClaw Gateway bootstrap failed"
        : result === "install-failed-artifact"
        ? "Workspace ready; appliance artifact verification failed"
        : result === "install-failed-version"
        ? "Workspace ready; installed OpenClaw version verification failed"
        : result === "install-failed-state"
        ? "Workspace ready; appliance state directory validation failed"
        : result === "install-failed-requirement"
        ? "Workspace ready; appliance host requirement validation failed"
        : result === "install-failed-credential-source"
        ? "Workspace ready; child credential source validation failed"
        : result === "install-failed-sudo"
        ? "Workspace ready; appliance host lacks required privilege escalation"
        : result === "install-failed-node"
        ? "Workspace ready; appliance host lacks the required Node.js runtime"
        : result === "install-failed-npm-tool"
        ? "Workspace ready; appliance host lacks the required npm executable"
        : result === "install-failed-sha256"
        ? "Workspace ready; appliance host lacks sha256sum"
        : result === "install-failed-unknown"
        ? "Workspace ready; appliance installation failed"
        : result === "config-failed"
        ? "Workspace ready; exact model configuration failed"
        : result === "binary-failed"
        ? "Workspace ready; installed OpenClaw executable was not found"
        : result === "runtime-failed"
        ? "Workspace ready; installed Node.js runtime was not found"
        : result === "restart-failed"
        ? "Workspace ready; OpenClaw Gateway restart failed"
        : result === "gateway-failed"
        ? "Workspace ready; OpenClaw Gateway did not become ready"
        : result === "turn-failed"
        ? "Workspace ready; live inference turn failed"
        : result === "output-failed"
        ? "Workspace ready; live inference returned unexpected output"
        : result === "output-schema-failed"
        ? "Workspace ready; live inference JSON envelope was invalid"
        : result === "output-count-failed"
        ? "Workspace ready; live inference returned an unexpected payload count"
        : result === "output-value-failed"
        ? "Workspace ready; live inference returned the wrong challenge answer"
        : "Workspace ready; waiting for OpenClaw bootstrap evidence",
    };
  }

  async disable(claw: ClawRecord): Promise<DisableResult> {
    return {
      applied: true,
      health: claw.observed.health,
      message: "Cloudflare ingress rejects disabled claws",
      lifecycle: claw.observed.lifecycle,
      controlLink: claw.observed.controlLink,
      lastSeenAt: new Date().toISOString(),
      ...(claw.observed.configHash ? { configHash: claw.observed.configHash } : {}),
    };
  }

  runtimeDiagnostics = async (
    _claw: ClawRecord,
    workspace: { status: string; attachUrl?: string },
  ): Promise<{ events: Array<Record<string, unknown>>; processes: string[] }> => {
    if (workspace.status !== "ready" || !workspace.attachUrl) {
      throw new Error("runtime diagnostics require a ready workspace terminal");
    }
    const label = `CRABHELM_DIAGNOSTIC_${crypto.randomUUID().replaceAll("-", "")}`;
    const raw = await captureTerminalSection(
      workspace.attachUrl,
      this.#brokerToken,
      [
        `printf '%s_BEGIN\\n' ${shellQuote(label)}`,
        "tail -n 40 \"$HOME/.openclaw/crabhelm-runtime-bridge.log\" 2>/dev/null || true",
        "printf 'INSTALL_STAGE %s\\n' \"$(head -n 1 /tmp/crabhelm-install-failed-stage 2>/dev/null || echo missing)\"",
        "tail -n 20 /tmp/crabhelm-install.log 2>/dev/null | sed -E 's/(Bearer|CRABHELM_RUNTIME_TOKEN=)[^[:space:]]+/\\1[REDACTED]/g; s/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/[REDACTED_JWT]/g' | sed 's/^/INSTALL_LOG /' || true",
        "bridge_pid=$(tr -cd '0-9' <\"$HOME/.openclaw/crabhelm-runtime-bridge.pid\" 2>/dev/null || true)",
        "printf 'STATE release=%s install_stage=%s turn_file=%s log_bytes=%s bridge_pid=%s stdout=%s bridge_sha256=%s\\n' \"$(head -n 1 \"$HOME/.openclaw/crabhelm-ready\" 2>/dev/null || echo missing)\" \"$(head -n 1 /tmp/crabhelm-install-failed-stage 2>/dev/null || echo missing)\" \"$(test -f \"$HOME/.openclaw/crabhelm-current-turn.json\" && echo present || echo absent)\" \"$(wc -c <\"$HOME/.openclaw/crabhelm-runtime-bridge.log\" 2>/dev/null || echo missing)\" \"${bridge_pid:-missing}\" \"$(readlink \"/proc/${bridge_pid:-0}/fd/1\" 2>/dev/null || echo missing)\" \"$(sha256sum \"$HOME/.local/share/crabhelm/runtime/runtime-bridge.mjs\" 2>/dev/null | cut -d' ' -f1 || echo missing)\"",
        "ps -eo pid=,ppid=,state=,etimes=,comm= | awk -v parent=\"${bridge_pid:-0}\" '$1 == parent || $2 == parent' | tail -n 10 || true",
        `printf '%s_END\\n' ${shellQuote(label)}`,
      ].join("\n"),
      label,
    );
    const events: Array<Record<string, unknown>> = [];
    const processes: string[] = [];
    for (const line of raw) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const jsonStart = trimmed.indexOf('{"event"');
        if (jsonStart < 0) throw new Error("not a metadata event");
        const value = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>;
        if (typeof value.event !== "string") continue;
        const event = Object.fromEntries(["event", "jobId", "ok"].flatMap((key) =>
          value[key] === undefined ? [] : [[key, value[key]]],
        ));
        if (
          value.event === "runtime_server_rejected_message" &&
          typeof value.error === "string" &&
          ["unsupported message type", "job offer is not owned by this runtime", "job is not owned by this runtime", "invalid completion", "runtime refresh was already used"].includes(value.error)
        ) event.error = value.error;
        events.push(event);
      } catch {
        if (/^(?:STATE\s|INSTALL_(?:STAGE|LOG)\s|\s*\d+\s+\d+\s+[A-Z]\s+\d+\s+)/u.test(line)) {
          processes.push(trimmed.slice(0, 500));
        }
      }
    }
    return { events: events.slice(-40), processes: processes.slice(-10) };
  };

  async drain(claw: ClawRecord): Promise<DrainResult> {
    const status = await this.#coordinators?.getByName(claw.id).runtimeStatus();
    const activeRuns = status ? status.pending + status.running + status.awaitingDelivery : 0;
    return {
      drained: activeRuns === 0,
      activeRuns,
      checkedAt: new Date().toISOString(),
      message: activeRuns === 0 ? "Cloudflare runtime queue is drained" : "Cloudflare runtime queue still has active work",
    };
  }

  async revokeControl(_claw: ClawRecord): Promise<RevokeControlResult> {
    return {
      removedPairedDevice: false,
      rejectedPendingRequest: false,
      alreadyAbsent: true,
      message: "No native parent pairing exists for the Cloudflare workspace control link",
    };
  }
}

export async function bootstrapToken(
  secret: string,
  childId: string,
  releaseId: string,
  archiveId: string,
  expiresAt: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  if (!/^[0-9a-f]{64}$/u.test(releaseId) || !/^[0-9a-f]{64}$/u.test(archiveId)) throw new Error("bootstrap release identity is invalid");
  const payload = `crabhelm:${childId}:${releaseId}:${archiveId}:${expiresAt}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${releaseId}.${archiveId}.${expiresAt}.${base64Url(new Uint8Array(signature))}`;
}

export async function bootstrapTokenClaims(
  secret: string,
  childId: string,
  candidate: string,
  now = Date.now(),
): Promise<{ releaseId: string; archiveId: string; expiresAt: number } | undefined> {
  const match = candidate.match(/^([0-9a-f]{64})\.([0-9a-f]{64})\.([0-9]{13})\.([A-Za-z0-9_-]{43})$/u);
  if (!match) return undefined;
  const releaseId = match[1]!;
  const archiveId = match[2]!;
  const expiresAt = Number(match[3]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > BOOTSTRAP_TOKEN_TTL_MS) {
    return undefined;
  }
  const expected = encoder.encode(await bootstrapToken(secret, childId, releaseId, archiveId, expiresAt));
  const actual = encoder.encode(candidate);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
    ? { releaseId, archiveId, expiresAt }
    : undefined;
}

export async function validBootstrapToken(
  secret: string,
  childId: string,
  releaseId: string,
  archiveId: string,
  candidate: string,
  now = Date.now(),
): Promise<boolean> {
  const claims = await bootstrapTokenClaims(secret, childId, candidate, now);
  return claims?.releaseId === releaseId && claims.archiveId === archiveId;
}

async function inspectTerminal(
  attachUrl: string,
  brokerToken: string,
  model: string,
  credentialsGeneration: number,
  statusCommand: string,
  probeLabel: string,
): Promise<WorkspaceTerminalState> {
  const url = new URL(attachUrl);
  if (url.protocol !== "wss:") throw new Error("Crabbox terminal URL must use WSS");
  url.protocol = "https:";
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${brokerToken}`,
      upgrade: "websocket",
    },
  }) as Response & { webSocket?: WorkerWebSocket };
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) {
    throw new Error(`Crabbox terminal upgrade failed (HTTP ${response.status})`);
  }
  socket.binaryType = "arraybuffer";
  socket.accept();
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let probeSent = false;
    const finish = (result: WorkspaceTerminalState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close(1000, "bootstrap evidence observed");
      resolve(result);
    };
    const timer = setTimeout(() => finish("pending"), 210_000);
    socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
      const bytes = typeof event.data === "string"
        ? encoder.encode(event.data)
        : new Uint8Array(event.data as ArrayBuffer);
      socket.send(JSON.stringify({ type: "ack", bytes: bytes.byteLength }));
      output = `${output}${typeof event.data === "string" ? event.data : decoder.decode(bytes)}`.slice(-32_000);
      if (hasTerminalLine(output, `${probeLabel}_INFERENCE_READY`)) {
        finish("ready");
      } else if (hasTerminalLine(output, `${probeLabel}_READY`) && !probeSent) {
        probeSent = true;
        socket.send(`${inferenceProbeCommand(model, `${probeLabel}_INFERENCE`, credentialsGeneration)}\n`);
      } else if (
        hasTerminalLine(output, `${probeLabel}_STARTED`) ||
        hasTerminalLine(output, `${probeLabel}_INSTALLING`)
      ) {
        finish("started");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALLING_DOWNLOAD`)) {
        finish("installing-download");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALLING_OPENCLAW`)) {
        finish("installing-openclaw");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALLING_PLUGIN`)) {
        finish("installing-plugin");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALLING_BOOTSTRAP`)) {
        finish("installing-bootstrap");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_CREDENTIAL`)) {
        finish("install-failed-credential");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_PACKAGE`)) {
        finish("install-failed-package");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_PLUGIN_DUPLICATE`)) {
        finish("install-failed-plugin-duplicate");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_NPM`)) {
        finish("install-failed-npm");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_BOOTSTRAP`)) {
        finish("install-failed-bootstrap");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_ARTIFACT`)) {
        finish("install-failed-artifact");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_VERSION`)) {
        finish("install-failed-version");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_STATE`)) {
        finish("install-failed-state");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_REQUIREMENT`)) {
        finish("install-failed-requirement");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_CREDENTIAL_SOURCE`)) {
        finish("install-failed-credential-source");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_SUDO`)) {
        finish("install-failed-sudo");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_NODE`)) {
        finish("install-failed-node");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_NPM_TOOL`)) {
        finish("install-failed-npm-tool");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_SHA256`)) {
        finish("install-failed-sha256");
      } else if (hasTerminalLine(output, `${probeLabel}_INSTALL_FAILED_UNKNOWN`)) {
        finish("install-failed-unknown");
      } else {
        const failure = terminalInferenceFailure(output, `${probeLabel}_INFERENCE`);
        if (failure) finish(failure);
      }
    });
    socket.addEventListener("close", () => finish("pending"));
    socket.addEventListener("error", () => finish("pending"));
    socket.send(`${statusCommand}\n`);
  });
}

async function captureTerminalSection(
  attachUrl: string,
  brokerToken: string,
  command: string,
  label: string,
): Promise<string[]> {
  const url = new URL(attachUrl);
  if (url.protocol !== "wss:") throw new Error("Crabbox terminal URL must use WSS");
  url.protocol = "https:";
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${brokerToken}`, upgrade: "websocket" },
  }) as Response & { webSocket?: WorkerWebSocket };
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) throw new Error(`Crabbox terminal upgrade failed (HTTP ${response.status})`);
  socket.binaryType = "arraybuffer";
  socket.accept();
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close(1000, "diagnostics observed");
      if (error) return reject(error);
      const plain = output.replaceAll("\r", "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
      const lines = plain.split("\n").map((line) => line.trimEnd());
      let begin = -1;
      for (let index = 0; index < lines.length; index++) {
        if (lines[index]?.trim() === `${label}_BEGIN`) begin = index;
      }
      const end = lines.findIndex((line, index) => index > begin && line.trim() === `${label}_END`);
      if (begin < 0 || end < 0) return reject(new Error("runtime diagnostics markers were not observed"));
      resolve(lines.slice(begin + 1, end));
    };
    const timer = setTimeout(() => finish(new Error("runtime diagnostics timed out")), 15_000);
    socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
      const bytes = typeof event.data === "string" ? encoder.encode(event.data) : new Uint8Array(event.data);
      socket.send(JSON.stringify({ type: "ack", bytes: bytes.byteLength }));
      output = `${output}${typeof event.data === "string" ? event.data : decoder.decode(bytes)}`.slice(-64_000);
      if (hasTerminalLine(output, `${label}_END`)) finish();
    });
    socket.addEventListener("close", () => finish(new Error("runtime diagnostics terminal closed")));
    socket.addEventListener("error", () => finish(new Error("runtime diagnostics terminal failed")));
    socket.send(`${command}\n`);
  });
}

function terminalInferenceFailure(
  output: string,
  probeLabel: string,
): WorkspaceTerminalState | undefined {
  const failures = [
    [`${probeLabel}_BINARY_FAILED`, "binary-failed"],
    [`${probeLabel}_RUNTIME_FAILED`, "runtime-failed"],
    [`${probeLabel}_CONFIG_FAILED`, "config-failed"],
    [`${probeLabel}_RESTART_FAILED`, "restart-failed"],
    [`${probeLabel}_GATEWAY_FAILED`, "gateway-failed"],
    [`${probeLabel}_TURN_FAILED`, "turn-failed"],
    [`${probeLabel}_OUTPUT_FAILED`, "output-failed"],
    [`${probeLabel}_OUTPUT_SCHEMA_FAILED`, "output-schema-failed"],
    [`${probeLabel}_OUTPUT_COUNT_FAILED`, "output-count-failed"],
    [`${probeLabel}_OUTPUT_VALUE_FAILED`, "output-value-failed"],
  ] as const;
  return failures.find(([line]) => hasTerminalLine(output, line))?.[1];
}

function hasTerminalLine(output: string, expected: string): boolean {
  const plain = output
    .replaceAll("\r", "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
  return plain.split("\n").some((line) => line.trim() === expected);
}

export function bootstrapStatusCommand(
  launchCommand = "",
  statusLabel = "CRABHELM",
  retryMarker = "",
  releaseId = "",
  credentialsGeneration = 1,
): string {
  // Past epoch 1, readiness additionally requires the credential marker the
  // installer writes after re-fetching credentials.env, so a rotation drives
  // one release-keyed in-place reinstall before the claw reports ready again.
  const credentialCheck = credentialsGeneration > 1
    ? ` && grep -Fqx ${shellQuote(`c${credentialsGeneration}`)} "$HOME/.openclaw/crabhelm-credentials-generation" 2>/dev/null`
    : "";
  const readyCheck = releaseId
    ? `grep -Fqx ${shellQuote(releaseId)} "$HOME/.openclaw/crabhelm-ready" 2>/dev/null${credentialCheck}`
    : "test -f \"$HOME/.openclaw/crabhelm-ready\"";
  const command = [
    `status_label=${shellQuote(statusLabel)}`,
    `if ${readyCheck}; then`,
    "  printf '%s_READY\\n' \"$status_label\"",
  ];
  if (launchCommand && retryMarker) {
    command.push(
      `elif test ! -e ${shellQuote(retryMarker)} && { pgrep -f '[g]uest-install.sh' >/dev/null || pgrep -f '[b]ootstrap-child.sh' >/dev/null; }; then`,
      "  for stale_pid in $(pgrep -f '[g]uest-install.sh|[b]ootstrap-child.sh'); do",
      "    pkill -TERM -P \"$stale_pid\" 2>/dev/null || true",
      "    kill -TERM \"$stale_pid\" 2>/dev/null || true",
      "  done",
      "  sleep 1",
      `  ${launchCommand}`,
      "  printf '%s_STARTED\\n' \"$status_label\"",
    );
  }
  command.push(
    "elif pgrep -f '[g]uest-install.sh' >/dev/null; then",
    "  if test -f \"$HOME/.openclaw/.env\"; then",
    "    printf '%s_INSTALLING_BOOTSTRAP\\n' \"$status_label\"",
    "  elif command -v openclaw >/dev/null 2>&1; then",
    "    printf '%s_INSTALLING_PLUGIN\\n' \"$status_label\"",
    "  else",
    "    printf '%s_INSTALLING_OPENCLAW\\n' \"$status_label\"",
    "  fi",
    "elif pgrep -f '[b]ootstrap-child.sh' >/dev/null; then",
    "  printf '%s_INSTALLING_BOOTSTRAP\\n' \"$status_label\"",
    "elif pgrep -x curl >/dev/null; then",
    "  printf '%s_INSTALLING_DOWNLOAD\\n' \"$status_label\"",
    "elif test -s /tmp/crabhelm-install.log; then",
  );
  if (launchCommand && retryMarker) {
    command.push(
      `  if test ! -e ${shellQuote(retryMarker)}; then`,
      `    ${launchCommand}`,
      "    printf '%s_STARTED\\n' \"$status_label\"",
      `  elif test ! -e ${shellQuote(`${retryMarker}.retry`)}; then`,
      `    touch ${shellQuote(`${retryMarker}.retry`)}`,
      `    ${launchCommand}`,
      "    printf '%s_STARTED\\n' \"$status_label\"",
      `  elif test ! -e ${shellQuote(`${retryMarker}.retry2`)}; then`,
      `    touch ${shellQuote(`${retryMarker}.retry2`)}`,
      `    ${launchCommand}`,
      "    printf '%s_STARTED\\n' \"$status_label\"",
      "  elif grep -Fqx 'node' /tmp/crabhelm-install-failed-stage 2>/dev/null; then",
    );
  } else {
    command.push("  if grep -Fqx 'node' /tmp/crabhelm-install-failed-stage 2>/dev/null; then");
  }
  command.push(
    "    printf '%s_INSTALL_FAILED_NODE\\n' \"$status_label\"",
    "  elif grep -Fqx 'verify' /tmp/crabhelm-install-failed-stage 2>/dev/null; then",
    "    printf '%s_INSTALL_FAILED_ARTIFACT\\n' \"$status_label\"",
    "  elif grep -Fqx 'package' /tmp/crabhelm-install-failed-stage 2>/dev/null; then",
    "    printf '%s_INSTALL_FAILED_NPM\\n' \"$status_label\"",
    "  elif grep -Fqx 'plugin' /tmp/crabhelm-install-failed-stage 2>/dev/null; then",
    "    printf '%s_INSTALL_FAILED_PLUGIN_DUPLICATE\\n' \"$status_label\"",
    "  elif grep -Fqx 'credential' /tmp/crabhelm-install-failed-stage 2>/dev/null; then",
    "    printf '%s_INSTALL_FAILED_CREDENTIAL_SOURCE\\n' \"$status_label\"",
    "  elif grep -Fqx 'bootstrap' /tmp/crabhelm-install-failed-stage 2>/dev/null; then",
    "    printf '%s_INSTALL_FAILED_BOOTSTRAP\\n' \"$status_label\"",
    "  elif grep -Fq 'child credential destination must be absent' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_CREDENTIAL\\n' \"$status_label\"",
    "  elif grep -Fq 'plugin already exists:' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_PLUGIN_DUPLICATE\\n' \"$status_label\"",
    "  elif grep -Eq 'npm (error|ERR!)' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_NPM\\n' \"$status_label\"",
    "  elif grep -Eq 'bundle (manifest|artifact)' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_ARTIFACT\\n' \"$status_label\"",
    "  elif grep -Eq 'installed OpenClaw version|OpenClaw installation did not create' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_VERSION\\n' \"$status_label\"",
    "  elif grep -Eq 'child state directory|credential destination is unsafe|credential destination differs' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_STATE\\n' \"$status_label\"",
    "  elif grep -Fq 'credential source' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_CREDENTIAL_SOURCE\\n' \"$status_label\"",
    "  elif grep -Fq 'sudo is required' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_SUDO\\n' \"$status_label\"",
    "  elif grep -Eq 'node is required|requires Node' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_NODE\\n' \"$status_label\"",
    "  elif grep -Fq 'npm is required' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_NPM_TOOL\\n' \"$status_label\"",
    "  elif grep -Fq 'sha256sum is required' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_SHA256\\n' \"$status_label\"",
    "  elif grep -Eq 'is required|requires Node' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_REQUIREMENT\\n' \"$status_label\"",
    "  elif grep -Eq 'already (exists|installed)|crabhelm guest install:' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_PACKAGE\\n' \"$status_label\"",
    "  elif grep -Fq 'crabhelm child bootstrap:' /tmp/crabhelm-install.log; then",
    "    printf '%s_INSTALL_FAILED_BOOTSTRAP\\n' \"$status_label\"",
    "  else",
    "    printf '%s_INSTALL_FAILED_UNKNOWN\\n' \"$status_label\"",
    "  fi",
    "else",
  );
  if (launchCommand) {
    command.push(
      `  ${launchCommand}`,
      "  printf '%s_STARTED\\n' \"$status_label\"",
    );
  } else {
    command.push("  printf '%s_PENDING\\n' \"$status_label\"");
  }
  command.push(
    "fi",
  );
  return command.join("\n");
}

export function inferenceProbeCommand(
  model: string,
  probeLabel = "CRABHELM_INFERENCE",
  credentialsGeneration = 1,
): string {
  const marker = "$HOME/.openclaw/crabhelm-inference-ready";
  // Preserve the epoch-one marker for the existing fleet. Rotated credentials
  // use a new version with the epoch before the model, avoiding collisions with
  // legacy model identifiers that contain colons.
  const markerValue = credentialsGeneration > 1
    ? `v3:c${credentialsGeneration}:${model}`
    : `v2:${model}`;
  const output = "/tmp/crabhelm-inference-probe.json";
  const error = "/tmp/crabhelm-inference-probe.err";
  const runtimeLauncher = "$HOME/.local/share/crabhelm/runtime/start-runtime-bridge.sh";
  const validateResponse = [
    "const fs = require('node:fs');",
    "const raw = fs.readFileSync(process.argv[1], 'utf8').trim();",
    "let value;",
    "for (let start = raw.indexOf('{'); start >= 0 && !value; start = raw.indexOf('{', start + 1)) {",
    "  let depth = 0, quoted = false, escaped = false;",
    "  for (let index = start; index < raw.length; index++) {",
    "    const char = raw[index];",
    "    if (escaped) { escaped = false; continue; }",
    "    if (quoted && char === '\\\\') { escaped = true; continue; }",
    "    if (char === '\"') { quoted = !quoted; continue; }",
    "    if (quoted) continue;",
    "    if (char === '{') depth++; else if (char === '}') depth--;",
    "    if (depth === 0) { try { const candidate = JSON.parse(raw.slice(start, index + 1)); if (Array.isArray(candidate.payloads)) value = candidate; } catch {} break; }",
    "  }",
    "}",
    "if (!value || !Array.isArray(value.payloads)) process.exit(3);",
    "const texts = value.payloads.map((payload) => payload?.text).filter((text) => typeof text === 'string' && text.trim()).map((text) => text.trim());",
    "if (texts.length !== 1) process.exit(4);",
    "if (texts[0] !== '671789') process.exit(5);",
  ].join(" ");
  return [
    `probe_label=${shellQuote(probeLabel)}`,
    "probe_session=\"crabhelm-healthcheck-$(date +%s)-$$\"",
    "openclaw_cli=\"$HOME/.local/share/crabhelm/openclaw-2026.6.11/bin/openclaw\"",
    "export PATH=\"$HOME/.local/share/crabhelm/node-v22.23.1-linux-x64/bin:$HOME/.local/share/crabhelm/openclaw-2026.6.11/bin:$PATH\"",
    `if test -f ${marker} && grep -Fqx ${shellQuote(markerValue)} ${marker}; then`,
    `  if /bin/bash ${runtimeLauncher}; then probe_result=READY; else probe_result=RUNTIME_FAILED; fi`,
    "else",
    "  if test ! -x \"$openclaw_cli\"; then",
    "    probe_result=BINARY_FAILED",
    "  elif ! command -v node >/dev/null 2>&1; then",
    "    probe_result=RUNTIME_FAILED",
    `  elif ! "$openclaw_cli" config set agents.defaults.model.primary ${shellQuote(model)} >/dev/null; then`,
    "    probe_result=CONFIG_FAILED",
    "  elif ! \"$openclaw_cli\" gateway restart >/dev/null; then",
    "    probe_result=RESTART_FAILED",
    "  elif ! timeout 90 bash -c 'until curl --fail --silent --max-time 2 http://127.0.0.1:18789/readyz >/dev/null; do sleep 2; done'; then",
    "    probe_result=GATEWAY_FAILED",
    `  elif ! timeout -k 10 180 "$openclaw_cli" agent --agent main --session-id "$probe_session" --message ${shellQuote("Calculate 731 multiplied by 919. Reply with only the decimal integer, without formatting or punctuation.")} --thinking off --json >${output} 2>${error}; then`,
    "    probe_result=TURN_FAILED",
    "  else",
    "    response_status=0",
    `    node --input-type=commonjs -e ${shellQuote(validateResponse)} ${output} || response_status=$?`,
    "    case \"$response_status\" in",
    "      0)",
    `        if /bin/bash ${runtimeLauncher}; then`,
    `          printf '%s\\n' ${shellQuote(markerValue)} >${marker}`,
    `          chmod 0600 ${marker}`,
    "          probe_result=READY",
    "        else",
    "          probe_result=RUNTIME_FAILED",
    "        fi",
    "        ;;",
    "      3) probe_result=OUTPUT_SCHEMA_FAILED ;;",
    "      4) probe_result=OUTPUT_COUNT_FAILED ;;",
    "      5) probe_result=OUTPUT_VALUE_FAILED ;;",
    "      *) probe_result=OUTPUT_FAILED ;;",
    "    esac",
    "  fi",
    "fi",
    "printf '%s_%s\\n' \"$probe_label\" \"$probe_result\"",
  ].join("\n");
}

export function bootstrapInstallScript(options: {
  base: string;
  archiveId: string;
  releaseId: string;
  nodeSha256: string;
  childId: string;
  model: string;
  slack: string;
  credentialsGeneration: number;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077
: "\${CRABHELM_BOOTSTRAP_TOKEN:?missing bootstrap token}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
auth=(--header "Authorization: Bearer $CRABHELM_BOOTSTRAP_TOKEN")
curl --fail --silent --show-error --location "\${auth[@]}" ${shellQuote(`${options.base}/bundle.tgz`)} -o "$work/bundle.tgz"
actual_archive_sha256="$(sha256sum "$work/bundle.tgz")"
actual_archive_sha256="\${actual_archive_sha256%% *}"
[[ "$actual_archive_sha256" = ${shellQuote(options.archiveId)} ]] || { printf '%s\\n' 'crabhelm bootstrap: appliance archive digest mismatch' >&2; exit 1; }
tar -xzf "$work/bundle.tgz" -C "$work"
curl --fail --silent --show-error --location "\${auth[@]}" ${shellQuote(`${options.base}/credentials.env`)} -o "$work/credentials.env"
chmod 0600 "$work/credentials.env"
curl --fail --silent --show-error --location "\${auth[@]}" ${shellQuote(`${options.base}/managed-spec.json`)} -o "$work/managed-spec.json"
chmod 0600 "$work/managed-spec.json"
export CRABHELM_BUNDLE_MANIFEST_SHA256=${shellQuote(options.releaseId)}
export CRABHELM_NODE_SHA256=${shellQuote(options.nodeSha256)}
export CRABHELM_CREDENTIAL_FILE="$work/credentials.env"
export CRABHELM_CREDENTIAL_REFRESH_URL=${shellQuote(`${options.base}/credentials.env`)}
export CRABHELM_MANAGED_SPEC_FILE="$work/managed-spec.json"
export CRABBOX_ADAPTER_ROOT_SESSION_ID=${shellQuote(options.childId)}
export CRABHELM_STANDALONE=true
export CRABHELM_MODEL=${shellQuote(options.model)}
export CRABHELM_SLACK_ENABLED=${shellQuote(options.slack)}
export CRABHELM_CREDENTIALS_GENERATION=${shellQuote(String(options.credentialsGeneration))}
/bin/bash "$work/bundle/guest-install.sh"
marker_dir="$HOME/.openclaw"
install -d -m 0700 "$marker_dir"
marker_temporary="$marker_dir/crabhelm-credentials-generation.new-$$"
printf 'c%s\\n' ${shellQuote(String(options.credentialsGeneration))} >"$marker_temporary"
chmod 0600 "$marker_temporary"
mv -f "$marker_temporary" "$marker_dir/crabhelm-credentials-generation"
`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
