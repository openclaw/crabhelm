import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs the real Worker (worker/index.ts) and both Durable Objects inside
// workerd, so router host-splitting, auth gating, and DO storage are exercised
// in the production runtime instead of only through the Node fetch shim.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Bindings, DO classes, R2 buckets, and queues are read from the real
      // deployment config; miniflare simulates the stateful ones.
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Any unexpected external request becomes a retryable failure. The
        // Slack-off delivery test therefore stays pending if it leaks a post.
        outboundService: () => new Response(
          JSON.stringify({ ok: false, error: "transient" }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
        // Test-only signing material so the control-plane admission gate can
        // open where a test needs it. These never match production secrets.
        bindings: {
          BOOTSTRAP_SIGNING_SECRET: "x".repeat(48),
          SESSION_SIGNING_SECRET: "x".repeat(48),
          INVOCATION_SIGNING_SECRET: "x".repeat(48),
          RUNTIME_SIGNING_SECRET: "x".repeat(48),
          VAULT_MASTER_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
          CRABHELM_SLACK: "off",
          SLACK_BOT_TOKEN: "stale",
        },
      },
    }),
  ],
  test: {
    include: ["tests/workers/**/*.test.ts"],
  },
});
