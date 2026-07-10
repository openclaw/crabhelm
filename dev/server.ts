import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCrabhelmApiHandler } from "../src/http.js";
import { SimulatorChildCoreProvider } from "../src/providers.js";
import { CrabhelmReconciler } from "../src/reconciler.js";
import { CrabhelmRegistry } from "../src/registry.js";
import { createMemoryStateStore } from "../src/state.js";
import type { AuditEvent, ClawRecord, PolicyTemplate } from "../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = new CrabhelmRegistry(
  createMemoryStateStore<ClawRecord>(),
  createMemoryStateStore<AuditEvent>(),
  {
    deploymentTargets: {
      default: { profile: "openclaw-core", region: "us-west" },
      europe: { profile: "openclaw-core", region: "eu-central" },
    },
    defaultDeployment: { target: "default", profile: "openclaw-core", region: "us-west" },
    policies: createMemoryStateStore<PolicyTemplate>(),
  },
);
const reconciler = new CrabhelmReconciler(registry, new SimulatorChildCoreProvider());
const api = createCrabhelmApiHandler({
  registry,
  reconciler,
  githubSource: {
    async preview(source) {
      return {
        source,
        truncated: false,
        members: [
          { id: 101, login: "ada", role: source.scope === "repository" ? "admin" : undefined },
          { id: 202, login: "marco", role: source.scope === "repository" ? "maintain" : undefined },
          { id: 303, login: "lena", role: source.scope === "team" ? "maintainer" : undefined },
        ].map((member) => Object.fromEntries(Object.entries(member).filter(([, value]) => value !== undefined))) as Array<{ id: number; login: string; role?: string }>,
      };
    },
  },
  runtime: {
    mode: "simulator",
    defaultTarget: "default",
    targets: [
      { id: "default", label: "US West", region: "us-west", profile: "openclaw-core", ttlSeconds: 14_400, idleTimeoutSeconds: 14_400, admissionOpen: true },
      { id: "europe", label: "EU Central", region: "eu-central", profile: "openclaw-core", ttlSeconds: 14_400, idleTimeoutSeconds: 14_400, admissionOpen: true },
    ],
    githubImport: true,
    inference: { kind: "direct", defaultModel: "openai/gpt-5.5", metadataOnly: true },
  },
});

await seed();

const server = createServer(async (req, res) => {
  const original = req.url ?? "/";
  if (original.startsWith("/api")) {
    req.url = `/plugins/crabhelm${original}`;
    await api(req, res);
    return;
  }
  await serveAsset(req, res, original);
});

server.listen(4177, "127.0.0.1", () => {
  console.log("Crabhelm development console: http://127.0.0.1:4177");
});

async function serveAsset(req: IncomingMessage, res: ServerResponse, rawUrl: string) {
  const pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!new Set(["index.html", "app.js", "styles.css"]).has(name)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const body = await readFile(path.join(root, "web", name));
  res.setHeader(
    "content-type",
    name.endsWith(".html")
      ? "text/html; charset=utf-8"
      : name.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8",
  );
  res.setHeader("cache-control", "no-store");
  res.end(req.method === "HEAD" ? undefined : body);
}

async function seed() {
  await registry.createPolicy(
    {
      name: "Maintainer core",
      description: "Paired DMs, allowlisted groups, governed inference, and metadata-safe logs.",
      spec: {
        inference: { model: "openai/gpt-5.5", fallbackModels: ["openai/gpt-5.4-mini"] },
        slackEnabled: true,
        access: { dmPolicy: "pairing", groupPolicy: "allowlist" },
        observability: { logLevel: "info" },
      },
    },
    "demo-admin",
  );
  const specs = [
    ["Ada", "github:ada", "@ada", "openai/gpt-5.5", "ready"],
    ["Release captain", "github:marco", "@marco", "openai/gpt-5.4-mini", "ready"],
    ["Docs steward", "github:lena", "@lena", "anthropic/claude-sonnet-4.6", "disabled"],
    ["Triage claw", "github:omar", "@omar", "openai/gpt-5.5", "attention"],
    ["Mobile maintainer", "github:daria", "@daria", "openai/gpt-5.5", "enrolling"],
  ] as const;
  for (const [name, subject, label, model, phase] of specs) {
    const claw = await registry.create(
      {
        name,
        owner: { subject, label, source: "github" },
        inference: { model },
      },
      "demo-admin",
    );
    const ready = await reconciler.reconcileOne(claw.id);
    if (phase === "disabled") {
      await registry.setEnabled(claw.id, false, "demo-admin");
      await reconciler.reconcileOne(claw.id);
    } else if (phase === "attention") {
      await registry.writeObserved(claw.id, {
        ...ready.observed,
        phase: "attention",
        health: "degraded",
        message: "Model auth unavailable; SecretRef could not resolve",
      });
    } else if (phase === "enrolling") {
      await registry.writeObserved(claw.id, {
        ...ready.observed,
        generation: 0,
        phase: "enrolling",
        health: "unknown",
        message: "Workspace ready; waiting for parent control-link enrollment",
        controlLink: { ...ready.observed.controlLink, status: "pending" },
      });
    }
  }
}
