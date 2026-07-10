import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const CONSOLE = "https://crabhelm.example.com";
const RUNTIME = "https://crabhelm-runtime.example.com";
const CHILD_ID = "685b2bda-351e-450b-a91c-45938c54454f";

// These exercise worker/index.ts end-to-end inside workerd: host-splitting,
// the Access/session auth gate, bootstrap bearer enforcement, and asset
// header hardening — none of which the Node fetch shim (src/http.ts) covers.
describe("worker router in workerd", () => {
  it("serves an unauthenticated health probe on either host", async () => {
    for (const origin of [CONSOLE, RUNTIME]) {
      const response = await SELF.fetch(`${origin}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, service: "crabhelm" });
    }
  });

  it("rejects control-plane API calls without an identity", async () => {
    const response = await SELF.fetch(`${CONSOLE}/api/state`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "authentication required" });
  });

  it("keeps console APIs and assets on the exact HTTPS console origin", async () => {
    for (const origin of [RUNTIME, "https://preview.example.test", "http://crabhelm.example.com"]) {
      expect((await SELF.fetch(`${origin}/api/state`)).status).toBe(404);
      expect((await SELF.fetch(`${origin}/`)).status).toBe(404);
    }
  });

  it("rejects cross-site browser mutations before authentication", async () => {
    const crossSite = await SELF.fetch(`${CONSOLE}/api/claws/${CHILD_ID}/reconcile`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("cache-control")).toBe("no-store");
    expect(await crossSite.json()).toEqual({ error: "cross-site mutation rejected" });

    const wrongSameSiteOrigin = await SELF.fetch(`${CONSOLE}/api/claws/${CHILD_ID}/reconcile`, {
      method: "POST",
      headers: { origin: "https://evil.example.com", "sec-fetch-site": "same-site" },
    });
    expect(wrongSameSiteOrigin.status).toBe(403);

    const sameOrigin = await SELF.fetch(`${CONSOLE}/api/claws/${CHILD_ID}/reconcile`, {
      method: "POST",
      headers: { origin: CONSOLE, "sec-fetch-site": "same-origin" },
    });
    expect(sameOrigin.status).toBe(401);

    const crossSiteRead = await SELF.fetch(`${CONSOLE}/api/state`, {
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    });
    expect(crossSiteRead.status).toBe(401);
  });

  it("strips caller-supplied identity headers before reaching the control plane", async () => {
    // A forged principal/role header must not authenticate; the gate still 401s.
    const response = await SELF.fetch(`${CONSOLE}/api/state`, {
      headers: { "x-crabhelm-principal-id": "principal:attacker", "x-crabhelm-roles": "administrator" },
    });
    expect(response.status).toBe(401);
  });

  it("keeps runtime-plane routes off the console host", async () => {
    for (const path of ["/slack/events", "/api/runtime/ticket", `/bootstrap/${CHILD_ID}/install.sh`, "/model/v1/models"]) {
      const response = await SELF.fetch(`${CONSOLE}${path}`, { method: "POST" });
      expect(response.status).toBe(404);
    }
  });

  it("does not expose the retired Crabhelm-owned model proxy", async () => {
    const response = await SELF.fetch(`${RUNTIME}/model/v1/models`);
    expect(response.status).toBe(404);
  });

  it("keeps Prometheus disabled unless explicitly configured", async () => {
    const response = await SELF.fetch(`${RUNTIME}/metrics`);
    expect(response.status).toBe(404);
  });

  it("requires a bootstrap bearer for appliance delivery on the runtime host", async () => {
    const response = await SELF.fetch(`${RUNTIME}/bootstrap/${CHILD_ID}/install.sh`);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a malformed child id before touching storage", async () => {
    const response = await SELF.fetch(`${RUNTIME}/bootstrap/not-a-uuid/install.sh`, {
      headers: { authorization: "Bearer whatever" },
    });
    expect(response.status).toBe(404);
  });

  it("upgrades required for the runtime WebSocket and rejects unknown tickets", async () => {
    const noUpgrade = await SELF.fetch(`${RUNTIME}/api/runtime/connect?clawId=${CHILD_ID}`);
    expect(noUpgrade.status).toBe(426);
    const badTicket = await SELF.fetch(`${RUNTIME}/api/runtime/connect?clawId=${CHILD_ID}`, {
      headers: { upgrade: "websocket", "sec-websocket-protocol": "crabhelm.runtime.v1, crabhelm.ticket.forged" },
    });
    expect(badTicket.status).toBe(401);
  });

  it("hardens console asset responses with a strict CSP", async () => {
    const response = await SELF.fetch(`${CONSOLE}/`);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
