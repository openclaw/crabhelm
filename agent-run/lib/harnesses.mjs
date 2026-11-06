import { readFileSync } from "node:fs";

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

export const HARNESSES = { pi };
export const PLANNED = ["codex", "claude", "grok", "prime", "rusty", "openclaw"];

export function harness(name) {
  const adapter = HARNESSES[name];
  if (adapter) return adapter;
  if (PLANNED.includes(name)) throw new Error("harness " + name + " is planned but not implemented yet");
  throw new Error("unknown harness " + name);
}
