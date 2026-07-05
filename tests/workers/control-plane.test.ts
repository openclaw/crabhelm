import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Drives the real CrabhelmControlPlane Durable Object inside workerd, so its
// SQLite-backed registry, serialized transactions, governance snapshot, and
// admin routing run in the production runtime rather than a Node fake. This
// replaces the source-text regex assertions in tests/edge-security.test.ts.
function controlPlane() {
  return env.CONTROL_PLANE.getByName("openclaw-org");
}

function adminRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  // worker/index.ts sets these only after verifying Access/session; hitting the
  // stub directly lets the DO's own requireAdministrator gate be exercised.
  headers.set("x-crabhelm-principal-id", "principal:test-admin");
  headers.set("x-crabhelm-roles", "administrator");
  if (init.body) headers.set("content-type", "application/json");
  return new Request(`https://crabhelm.internal${path}`, { ...init, headers });
}

describe("control-plane durable object in workerd", () => {
  it("exposes the pinned appliance identity over RPC", async () => {
    const identity = await controlPlane().deploymentIdentity();
    expect(identity.archiveId).toMatch(/^[0-9a-f]{64}$/u);
    expect(identity.releaseId).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses admin routes without the administrator role", async () => {
    const response = await controlPlane().fetch(
      new Request("https://crabhelm.internal/api/state", {
        headers: { "x-crabhelm-principal-id": "principal:member", "x-crabhelm-roles": "member" },
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "administrator role required" });
  });

  it("persists a policy through the SQLite registry and reflects it in state", async () => {
    const created = await controlPlane().fetch(adminRequest("/api/policies", {
      method: "POST",
      body: JSON.stringify({
        name: "Workerd Harness Policy",
        description: "created inside workerd",
        spec: {
          inference: { model: "openai/gpt-5.5", fallbackModels: [] },
          slackEnabled: false,
          access: { dmPolicy: "pairing", groupPolicy: "allowlist" },
          observability: { logLevel: "info" },
        },
      }),
    }));
    expect(created.status).toBe(201);
    const policy = await created.json() as { id: string; versions: unknown[] };
    expect(policy.versions).toHaveLength(1);

    const state = await controlPlane().fetch(adminRequest("/api/state"));
    expect(state.status).toBe(200);
    const body = await state.json() as {
      policies: Array<{ id: string; name: string }>;
      viewer: { principalId: string; roles: string[] };
      summary: { total: number };
    };
    expect(body.policies.map((entry) => entry.id)).toContain(policy.id);
    expect(body.viewer).toEqual({ principalId: "principal:test-admin", roles: ["administrator"] });
    expect(body.summary.total).toBe(0);
  });

  it("rejects a duplicate policy name from the persisted registry", async () => {
    const payload = {
      method: "POST",
      body: JSON.stringify({
        name: "Unique Harness Policy",
        spec: {
          inference: { model: "openai/gpt-5.5", fallbackModels: [] },
          slackEnabled: false,
          access: { dmPolicy: "pairing", groupPolicy: "allowlist" },
          observability: { logLevel: "info" },
        },
      }),
    };
    const first = await controlPlane().fetch(adminRequest("/api/policies", payload));
    expect(first.status).toBe(201);
    const second = await controlPlane().fetch(adminRequest("/api/policies", payload));
    expect(second.status).toBe(422);
    const body = await second.json() as { error: string };
    expect(body.error).toMatch(/already exists/u);
  });
});
