#!/usr/bin/env node
// agent-run: run one non-interactive harness turn, on the laptop when Harbor
// placement says local, otherwise on a Crabbox lease with a per-run
// ClawRouter key that is revoked when the run ends. It never asks a person.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildAppliance, loadPins } from "../lib/appliance.mjs";
import { ClawRouterAdmin } from "../lib/clawrouter.mjs";
import { loadConfig } from "../lib/config.mjs";
import { Crabbox } from "../lib/crabbox.mjs";
import { HARNESSES, PLANNED } from "../lib/harnesses.mjs";
import { agentRun, EXIT_INFRA, sweep } from "../lib/run.mjs";

const USAGE = [
  "usage:",
  "  agent-run --harness <name> --prompt-file F [--model M] [--thinking T] [--attach FILE]... [--out DIR] [--placement auto|local|remote]",
  "  agent-run appliance build <harness>",
  "  agent-run sweep",
  "",
  "Harnesses: " + Object.keys(HARNESSES).join(", ") + " (planned: " + PLANNED.join(", ") + ").",
  "Placement auto asks harbor-capacity-placement.mjs; queue and remote run on a Crabbox broker lease.",
  "Exit: the harness exit code; 75 no capacity; 3 agent-run failure; 4 key revocation not proven.",
].join("\n");

async function main(argv) {
  const config = loadConfig();
  if (argv[0] === "appliance") {
    if (argv[1] !== "build" || !argv[2]) throw new Error("usage: agent-run appliance build <harness>");
    const stage = mkdtempSync(join(tmpdir(), "agent-run-build-"));
    try {
      const built = await buildAppliance({ config, pins: loadPins(), harness: argv[2], crabbox: new Crabbox(config, { cwd: stage }) });
      console.log(JSON.stringify(built, null, 2));
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    return 0;
  }
  if (argv[0] === "sweep") {
    const revoked = await sweep(config, new ClawRouterAdmin(config));
    console.log(JSON.stringify({ revoked }));
    return 0;
  }
  const { values } = parseArgs({
    args: argv,
    options: {
      harness: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      "prompt-file": { type: "string" },
      attach: { type: "string", multiple: true },
      out: { type: "string" },
      placement: { type: "string", default: "auto" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { console.log(USAGE); return 0; }
  if (!values.harness || !values["prompt-file"] || !["auto", "local", "remote"].includes(values.placement)) {
    console.error(USAGE);
    return 2;
  }
  return agentRun({
    harness: values.harness, model: values.model, thinking: values.thinking,
    promptFile: values["prompt-file"], attach: values.attach, out: values.out, placement: values.placement,
  }, { config });
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => { console.error("agent-run: " + (error?.message ?? error)); process.exitCode = EXIT_INFRA; },
);
