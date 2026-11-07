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

// Pi thinking levels mapped to Claude Code --effort values (Claude has no "off").
const CLAUDE_EFFORT = { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

function claudeArgs({ model, thinking }) {
  if (thinking && !CLAUDE_EFFORT[thinking]) throw new Error("claude: unknown thinking level " + thinking);
  return [
    "claude", "-p", "--output-format", "text",
    ...(model ? ["--model", model.startsWith("clawrouter/") ? model.slice("clawrouter/".length) : model] : []),
    ...(thinking ? ["--effort", CLAUDE_EFFORT[thinking]] : []),
  ];
}

const claude = {
  name: "claude",
  bin: "claude",
  localArgv({ model, thinking }) {
    return claudeArgs({ model, thinking });
  },
  // --bare reads no settings, hooks or keychain; this file only gives CLAUDE_CONFIG_DIR a home.
  remoteConfig() {
    return { "claude/settings.json": "{}\n" };
  },
  remoteEnv({ configDir, remoteBaseUrl }) {
    return {
      CLAUDE_CONFIG_DIR: configDir + "/claude",
      ANTHROPIC_BASE_URL: new URL(remoteBaseUrl).origin,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
  },
  // In --bare mode Claude Code authenticates only with ANTHROPIC_API_KEY, sent as x-api-key, which ClawRouter accepts.
  keyEnv: ["ANTHROPIC_API_KEY"],
  remoteArgv({ model, thinking }) {
    // The lease is a disposable container holding only inputs and a per-run key.
    return [...claudeArgs({ model, thinking }), "--bare", "--dangerously-skip-permissions"];
  },
  remoteCollect({ sessionDir }) {
    return ["if [ -d \"$CLAUDE_CONFIG_DIR/projects\" ]; then cp -R \"$CLAUDE_CONFIG_DIR/projects\" " + quote(sessionDir + "/claude-projects") + "; fi"];
  },
  promptOnStdin: true,
};

function openclawModel(model) {
  const qualified = model || "openai/gpt-6-sol";
  const parts = qualified.split("/");
  if (parts.length > 2) throw new Error("openclaw: model must be a provider/model pair");
  const [prefix, id] = parts.length === 2 ? parts : [undefined, parts[0]];
  if (!id) throw new Error("openclaw: model id is required");
  if (/^(?:grok|xai)(?:-|$)/i.test(id)) throw new Error("openclaw: XAI models are not allowed");
  let provider = prefix;
  if (provider === "clawrouter") provider = undefined;
  if (provider && !["openai", "anthropic"].includes(provider)) {
    throw new Error("openclaw: only OpenAI and Anthropic models are allowed");
  }
  if (!provider) {
    if (/^claude-/i.test(id)) provider = "anthropic";
    else if (/^(?:gpt-|codex-|o[1-9](?:-|$))/i.test(id)) provider = "openai";
    else throw new Error("openclaw: model must identify an OpenAI or Anthropic model");
  }
  return { provider, id, qualified: provider + "/" + id, keyEnv: provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY" };
}

const openclaw = {
  name: "openclaw",
  bin: "openclaw",
  workspaceFiles: {
    "BOOTSTRAP.md": "This workspace is initialized for one task. Do not run onboarding or identity setup. Follow the task prompt and attached files.\n",
    "IDENTITY.md": "# Identity\nThis is a disposable task-scoped software agent, not a human.\n",
    "USER.md": "# User context\nUse only the supplied task prompt and attached files. No persistent user profile is provided.\n",
    "SOUL.md": "# Operating principles\nFollow the task scope. Protect credentials and private data. Do not claim human identity.\n",
    "memory/.keep": "",
  },
  localArgv({ model, thinking, prompt, runId }) {
    return [
      "openclaw", "agent", "--local", "--agent", "main", "--session-id", runId,
      "--message", prompt,
      ...(model ? ["--model", openclawModel(model).qualified] : []),
      ...(thinking ? ["--thinking", thinking] : []),
      "--timeout", "840", "--json",
    ];
  },
  remoteConfig({ remoteBaseUrl, model, workdir }) {
    const selected = openclawModel(model);
    const url = new URL(remoteBaseUrl);
    const baseUrl = selected.provider === "openai" ? new URL("/v1", url).origin + "/v1" : url.origin;
    const api = selected.provider === "openai" ? "openai-responses" : "anthropic-messages";
    return {
      "openclaw/openclaw.json": JSON.stringify({
        gateway: { mode: "local" },
        agents: { defaults: {
          model: { primary: selected.qualified },
          models: { [selected.qualified]: {} },
          workspace: workdir + "/inputs",
        } },
        models: { providers: {
          [selected.provider]: {
            baseUrl,
            apiKey: { source: "env", provider: "default", id: selected.keyEnv },
            api,
            models: [{
              id: selected.id, name: selected.id, reasoning: true, input: ["text"],
              contextWindow: 200000, maxTokens: 8192,
            }],
          },
        } },
      }, null, 2) + "\n",
    };
  },
  remoteEnv({ configDir }) {
    const stateDir = configDir + "/openclaw/state";
    return {
      OPENCLAW_CONFIG_PATH: configDir + "/openclaw/openclaw.json",
      OPENCLAW_STATE_DIR: stateDir,
    };
  },
  keyEnv({ model }) {
    return [openclawModel(model).keyEnv];
  },
  remoteArgv({ model, thinking, runId, promptFile }) {
    return [
      "openclaw", "agent", "--local", "--agent", "main", "--session-id", runId,
      "--message-file", promptFile,
      "--model", openclawModel(model).qualified,
      ...(thinking ? ["--thinking", thinking] : []),
      "--timeout", "840", "--json",
    ];
  },
  remoteCollect({ configDir, sessionDir }) {
    return ["if [ -d " + quote(configDir + "/openclaw/state/agents/main/sessions") + " ]; then cp -R " + quote(configDir + "/openclaw/state/agents/main/sessions") + " " + quote(sessionDir + "/openclaw-sessions") + "; fi"];
  },
};

export const HARNESSES = { pi, codex, claude, openclaw };
export const PLANNED = ["rusty", "prime", "grok"];

export function harness(name) {
  const adapter = HARNESSES[name];
  if (adapter) return adapter;
  if (PLANNED.includes(name)) throw new Error("harness " + name + " is planned but not implemented yet");
  throw new Error("unknown harness " + name);
}
