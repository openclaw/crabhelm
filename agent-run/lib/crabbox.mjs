import { run } from "./proc.mjs";
import { splitWords } from "./shell.mjs";

// Thin wrapper over the crabbox CLI: one warmed broker lease per run, raw ssh
// for upload, the run itself (with a remote forward) and download, then stop.
export class Crabbox {
  #config;
  #run;
  #cwd;

  constructor(config, { runner = run, cwd } = {}) {
    this.#config = config;
    this.#run = runner;
    this.#cwd = cwd;
  }

  #providerArgs() {
    return ["--provider", this.#config.crabboxProvider];
  }

  async warmup(slug, log = process.stderr, { onSpawn } = {}) {
    const c = this.#config;
    const result = await this.#run("crabbox", [
      "warmup", ...this.#providerArgs(), "--type", c.crabboxType, "--slug", slug,
      "--idle-timeout", c.leaseIdleTimeout, "--ttl", c.leaseTtl,
    ], { cwd: this.#cwd, stdout: "capture", stderr: "capture", onSpawn });
    const text = result.stdout + "\n" + result.stderr;
    for (const line of text.split("\n")) if (/^(leased|ready|warmup complete|serve route|waiting)/.test(line)) log.write("agent-run: crabbox " + line + "\n");
    const leased = /leased (\S+) slug=(\S+)/.exec(text);
    if (result.code !== 0 || !leased) {
      for (const line of text.trim().split("\n").slice(-5)) log.write("agent-run: crabbox " + line + "\n");
      const capacity = /serve_capacity_unavailable|awaiting-capacity/.test(text);
      const error = new Error("crabbox warmup failed (exit " + result.code + ")" + (capacity ? ": no broker capacity" : ""));
      error.capacity = capacity;
      error.leaseId = leased?.[1];
      throw error;
    }
    return { leaseId: leased[1], slug: leased[2] };
  }

  // argv for ssh to the lease, as printed by "crabbox ssh".
  async sshArgv(slug) {
    const result = await this.#run("crabbox", ["ssh", ...this.#providerArgs(), "--id", slug], { cwd: this.#cwd });
    if (result.code !== 0) throw new Error("crabbox ssh failed (exit " + result.code + ")");
    const line = result.stdout.trim().split("\n").filter((l) => l.startsWith("'ssh'") || l.startsWith("ssh ")).at(-1);
    if (!line) throw new Error("crabbox ssh printed no ssh command");
    const argv = splitWords(line);
    if (argv[0] !== "ssh" || argv.length < 2) throw new Error("unexpected crabbox ssh output");
    return argv;
  }

  async stop(slug) {
    const result = await this.#run("crabbox", ["stop", ...this.#providerArgs(), "--id", slug], { cwd: this.#cwd });
    const text = result.stdout + "\n" + result.stderr;
    const released = /released lease=(\S+)/.exec(text);
    // The coordinator has no such lease (for example a warmup cancelled by a signal): nothing is left running.
    if (!released && /\/release: http 404\b/.test(text)) return { stopped: true, absent: true, exitCode: result.code, lease: null };
    return { stopped: result.code === 0 && Boolean(released), exitCode: result.code, lease: released?.[1] ?? null };
  }
}

// Insert ssh options before the destination (the last word of the argv).
export function sshCommand(baseArgv, { options = [], remote }) {
  const destination = baseArgv.at(-1);
  return [...baseArgv.slice(1, -1), ...options, destination, ...(remote ? [remote] : [])];
}
