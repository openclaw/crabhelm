import { spawn } from "node:child_process";

const SECRET_ENV = ["CLAWROUTER_ADMIN_TOKEN", "CLAWROUTER_API_KEY"];

// Every child agent-run starts gets this environment: never the admin token,
// never a per-run key.
export function childEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra };
  for (const name of SECRET_ENV) delete env[name];
  return env;
}

// Run a command. stdin: string | Buffer | readable stream | undefined.
// stdout/stderr: "capture" (default), "inherit", or a writable stream.
export function run(command, args, options = {}) {
  const { input, cwd, env = childEnv(), stdout = "capture", stderr = "capture", onSpawn } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", stdout === "inherit" ? "inherit" : "pipe", stderr === "inherit" ? "inherit" : "pipe"],
    });
    onSpawn?.(child);
    const out = [];
    const err = [];
    if (child.stdout) {
      if (stdout === "capture") child.stdout.on("data", (chunk) => out.push(chunk));
      else child.stdout.pipe(stdout, { end: false });
    }
    if (child.stderr) {
      if (stderr === "capture") child.stderr.on("data", (chunk) => err.push(chunk));
      else child.stderr.pipe(stderr, { end: false });
    }
    child.on("error", reject);
    child.on("close", (code, signal) => resolvePromise({
      code: code ?? (signal ? 128 : 1),
      signal,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
    child.stdin.on("error", () => {});
    if (input === undefined) child.stdin.end();
    else if (typeof input === "string" || Buffer.isBuffer(input)) child.stdin.end(input);
    else input.pipe(child.stdin);
  });
}
