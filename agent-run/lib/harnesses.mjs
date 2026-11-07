import { readFileSync } from "node:fs";
import { quote } from "./shell.mjs";

// Per-harness adapters. Each adapter knows how to run one non-interactive
// turn locally (today's behaviour) and how to configure the box so the
// harness talks to ClawRouter through the forwarded port with the per-run
// key from $CLAWROUTER_API_KEY. Adapters never see or embed the key.

const pi = {
  name: "pi",
  bin: "pi",
  localArgv({ model, thinking, prompt, sessionDir }) {
    return [
      "pi", "-p", "--session-dir", sessionDir,
      ...(model ? ["--model", model] : []),
      ...(thinking ? ["--thinking", thinking] : []),
      "--", prompt,
    ];
  },
  // Files written into the run's config dir on the box.
  remoteConfig({ config, remoteBaseUrl }) {
    const models = JSON.parse(readFileSync(config.piModelsFile, "utf8"));
    const source = models?.providers?.[config.piProvider];
    if (!source) throw new Error("Pi models file has no " + config.piProvider + " provider");
    const { apiKey: _drop, ...provider } = source;
    const localOrigin = provider.baseUrl ? new URL(provider.baseUrl).origin : null;
    provider.baseUrl = remoteBaseUrl;
    // Models may carry their own baseUrl (e.g. "<origin>/v1" for openai-responses); move them to the tunnel, keep the path.
    provider.models = (provider.models ?? []).map((model) => {
      if (!model.baseUrl) return model;
      const url = new URL(model.baseUrl);
      if (url.origin !== localOrigin) throw new Error("Pi model " + model.id + " has a baseUrl outside the " + config.piProvider + " provider");
      return { ...model, baseUrl: new URL(remoteBaseUrl).origin + url.pathname.replace(/\/$/, "") };
    });
    provider.apiKey = "$CLAWROUTER_API_KEY";
    if (provider.headers) {
      for (const [name, value] of Object.entries(provider.headers)) {
        if (typeof value === "string" && (value.startsWith("!") || /key|token|secret|auth/i.test(name))) delete provider.headers[name];
      }
    }
    const settings = { quietStartup: true };
    return {
      "pi/models.json": JSON.stringify({ providers: { [config.piProvider]: provider } }, null, 2) + "\n",
      "pi/settings.json": JSON.stringify(settings, null, 2) + "\n",
    };
  },
  remoteEnv({ configDir }) {
    return {
      PI_CODING_AGENT_DIR: configDir + "/pi",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
  },
  remoteArgv({ config, model, thinking, sessionDir }) {
    const qualified = model && !model.includes("/") ? config.piProvider + "/" + model : model;
    return [
      "pi", "-p", "--session-dir", sessionDir, "--no-extensions", "--no-mcp",
      ...(qualified ? ["--model", qualified] : []),
      ...(thinking ? ["--thinking", thinking] : []),
    ];
  },
  // Pi reads the prompt as its final message argument.
  promptAsArgument: true,
};

// Pi thinking levels mapped to Codex model_reasoning_effort values.
const CODEX_EFFORT = { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" };

function codexModel(model) {
  return model?.startsWith("clawrouter/") ? model.slice("clawrouter/".length) : model;
}

function codexArgs({ model, thinking, lastMessage }) {
  if (thinking && !CODEX_EFFORT[thinking]) throw new Error("codex: unknown thinking level " + thinking);
  return [
    "exec", "--skip-git-repo-check", "--color", "never", "-o", lastMessage,
    ...(model ? ["--model", codexModel(model)] : []),
    ...(thinking ? ["-c", "model_reasoning_effort=" + JSON.stringify(CODEX_EFFORT[thinking])] : []),
  ];
}

const codex = {
  name: "codex",
  bin: "codex",
  localArgv({ model, thinking, prompt, sessionDir }) {
    return ["codex", ...codexArgs({ model, thinking, lastMessage: sessionDir + "/last-message.md" }), "--", prompt];
  },
  // A fresh CODEX_HOME holding only a ClawRouter provider that reads the per-run key from the environment.
  remoteConfig({ remoteBaseUrl }) {
    const toml = [
      "model_provider = \"clawrouter\"",
      "",
      "[model_providers.clawrouter]",
      "name = \"clawrouter\"",
      "base_url = " + JSON.stringify(new URL(remoteBaseUrl).origin + "/v1"),
      "env_key = \"CLAWROUTER_API_KEY\"",
      "wire_api = \"responses\"",
      "",
    ].join("\n");
    return { "codex/config.toml": toml };
  },
  remoteEnv({ configDir }) {
    return { CODEX_HOME: configDir + "/codex" };
  },
  remoteArgv({ model, thinking, sessionDir }) {
    // The lease is a disposable container holding only inputs and a per-run key, so Codex's own sandbox is
    // bypassed; Landlock and seccomp are not reliably available inside the broker's rootless containers.
    return ["codex", ...codexArgs({ model, thinking, lastMessage: sessionDir + "/last-message.md" }), "--dangerously-bypass-approvals-and-sandbox"];
  },
  // Codex writes its rollout under $CODEX_HOME/sessions; copy it next to the last message.
  remoteCollect({ sessionDir }) {
    return ["if [ -d \"$CODEX_HOME/sessions\" ]; then cp -R \"$CODEX_HOME/sessions\" " + quote(sessionDir + "/codex-sessions") + "; fi"];
  },
  promptAsArgument: true,
};

export const HARNESSES = { pi, codex };
export const PLANNED = ["claude", "grok", "prime", "rusty", "openclaw"];

export function harness(name) {
  const adapter = HARNESSES[name];
  if (adapter) return adapter;
  if (PLANNED.includes(name)) throw new Error("harness " + name + " is planned but not implemented yet");
  throw new Error("unknown harness " + name);
}
