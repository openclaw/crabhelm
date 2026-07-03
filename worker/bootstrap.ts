import type {
  ClawRecord,
  DisableResult,
  DrainResult,
  RevokeControlResult,
} from "../src/types.js";
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
  readonly #signingSecret: string;

  constructor(options: {
    brokerToken: string;
    publicUrl: string;
    releaseId: string;
    signingSecret: string;
  }) {
    if (!/^[0-9a-f]{64}$/u.test(options.releaseId)) {
      throw new Error("Crabbox appliance release id must be a SHA-256 digest");
    }
    this.#brokerToken = options.brokerToken;
    this.#publicUrl = new URL(options.publicUrl).origin;
    this.#releaseId = options.releaseId;
    this.#signingSecret = options.signingSecret;
  }

  async command(claw: ClawRecord): Promise<string> {
    return this.#launchCommand(claw);
  }

  async #launchCommand(claw: ClawRecord): Promise<string> {
    const token = await bootstrapToken(
      this.#signingSecret,
      claw.id,
      this.#releaseId,
      Date.now() + BOOTSTRAP_TOKEN_TTL_MS,
    );
    const installUrl = new URL(
      `/bootstrap/${encodeURIComponent(claw.id)}/install.sh`,
      this.#publicUrl,
    );
    installUrl.searchParams.set("model", claw.desired.inference.model);
    installUrl.searchParams.set("slack", String(claw.desired.channels.slack.enabled));
    return [
      `CRABHELM_BOOTSTRAP_TOKEN=${shellQuote(token)}`,
      "nohup",
      "bash",
      "-c",
      shellQuote(
        `installer=$(mktemp) && trap 'rm -f "$installer"' EXIT && curl --fail --silent --show-error --location --header "Authorization: Bearer $CRABHELM_BOOTSTRAP_TOKEN" ${shellQuote(installUrl.toString())} -o "$installer" && touch ${shellQuote(this.#retryMarker())} && exec bash "$installer"`,
      ),
      ">/tmp/crabhelm-install.log 2>&1 </dev/null &",
    ].join(" ");
  }

  #retryMarker(): string {
    return `/tmp/crabhelm-attempt-${this.#releaseId}`;
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
      result = await inspectTerminal(
        workspace.attachUrl,
        this.#brokerToken,
        claw.desired.inference.model,
        bootstrapStatusCommand(
          await this.#launchCommand(claw),
          probeLabel,
          this.#retryMarker(),
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
    if (claw.desired.channels.slack.enabled) {
      return {
        applied: false,
        health: claw.observed.health,
        message: "Disable refused: Slack ingress needs live child-control evidence",
        lifecycle: claw.observed.lifecycle,
        controlLink: claw.observed.controlLink,
      };
    }
    return {
      applied: true,
      health: claw.observed.health,
      message: "No external channel ingress is configured for this workspace",
      lifecycle: claw.observed.lifecycle,
      controlLink: claw.observed.controlLink,
      lastSeenAt: new Date().toISOString(),
      ...(claw.observed.configHash ? { configHash: claw.observed.configHash } : {}),
    };
  }

  async drain(claw: ClawRecord): Promise<DrainResult> {
    if (claw.desired.channels.slack.enabled) {
      throw new Error("Active-run drain needs live child-control evidence when Slack is enabled");
    }
    return {
      drained: true,
      activeRuns: 0,
      checkedAt: new Date().toISOString(),
      message: "No external channel ingress exists; active run count is zero",
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
  expiresAt: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `crabhelm:${childId}:${releaseId}:${expiresAt}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${expiresAt}.${base64Url(new Uint8Array(signature))}`;
}

export async function validBootstrapToken(
  secret: string,
  childId: string,
  releaseId: string,
  candidate: string,
  now = Date.now(),
): Promise<boolean> {
  const match = candidate.match(/^([0-9]{13})\.([A-Za-z0-9_-]{43})$/u);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > BOOTSTRAP_TOKEN_TTL_MS) {
    return false;
  }
  const expected = encoder.encode(await bootstrapToken(secret, childId, releaseId, expiresAt));
  const actual = encoder.encode(candidate);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

async function inspectTerminal(
  attachUrl: string,
  brokerToken: string,
  model: string,
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
        socket.send(`${inferenceProbeCommand(model, `${probeLabel}_INFERENCE`)}\n`);
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
): string {
  const command = [
    `status_label=${shellQuote(statusLabel)}`,
    "if test -f \"$HOME/.openclaw/crabhelm-ready\"; then",
    "  printf '%s_READY\\n' \"$status_label\"",
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
  ];
  if (launchCommand && retryMarker) {
    command.push(
      `  if test ! -e ${shellQuote(retryMarker)}; then`,
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
): string {
  const marker = "$HOME/.openclaw/crabhelm-inference-ready";
  const markerValue = `v2:${model}`;
  const output = "/tmp/crabhelm-inference-probe.json";
  const error = "/tmp/crabhelm-inference-probe.err";
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
    "  probe_result=READY",
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
    `        printf '%s\\n' ${shellQuote(markerValue)} >${marker}`,
    `        chmod 0600 ${marker}`,
    "        probe_result=READY",
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

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
