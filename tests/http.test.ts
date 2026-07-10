import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createCrabhelmApiHandler, createCrabhelmStaticHandler } from "../src/http.js";
import { SimulatorChildCoreProvider } from "../src/providers.js";
import { CrabhelmReconciler } from "../src/reconciler.js";
import { CrabhelmRegistry } from "../src/registry.js";
import { createMemoryStateStore } from "../src/state.js";
import type { AuditEvent, ClawRecord } from "../src/types.js";

test("console redirects the slashless route so relative assets stay under the UI namespace", async () => {
  const handler = createCrabhelmStaticHandler(process.cwd());
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const slashless = await fetch(
      `http://127.0.0.1:${address.port}/plugins/crabhelm/ui`,
      { redirect: "manual" },
    );
    assert.equal(slashless.status, 308);
    assert.equal(slashless.headers.get("location"), "/plugins/crabhelm/ui/");
    const page = await fetch(`http://127.0.0.1:${address.port}/plugins/crabhelm/ui/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /\.\/app\.js/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("unconfigured runtime rejects single and batch creation before persistence", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const handler = createCrabhelmApiHandler({
    registry,
    reconciler: new CrabhelmReconciler(registry, new SimulatorChildCoreProvider()),
    runtime: {
      mode: "unconfigured",
      defaultTarget: "default",
      targets: [{
        id: "default",
        label: "Default",
        profile: "openclaw-core",
        ttlSeconds: 14_400,
        idleTimeoutSeconds: 14_400,
        admissionOpen: false,
        message: "Crabbox provisioning is unconfigured",
      }],
      githubImport: false,
      inference: { kind: "direct", defaultModel: "openai/gpt-5.5", metadataOnly: true },
    },
  });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/plugins/crabhelm/api`;
  const spec = {
    name: "Blocked",
    owner: { subject: "github:blocked", label: "@blocked", source: "github" },
  };
  try {
    for (const [path, body] of [["/claws", spec], ["/claws/batch", { items: [spec] }]] as const) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), { error: "Crabbox provisioning is unconfigured" });
    }
    assert.equal((await registry.list()).length, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("partial runtime admits available targets and rejects unavailable placement", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
    {
      deploymentTargets: {
        west: { profile: "openclaw-core", region: "us-west" },
        europe: { profile: "openclaw-core-eu", region: "eu-central" },
      },
      defaultDeployment: { target: "west", profile: "openclaw-core", region: "us-west" },
    },
  );
  const handler = createCrabhelmApiHandler({
    registry,
    reconciler: new CrabhelmReconciler(registry, new SimulatorChildCoreProvider()),
    runtime: {
      mode: "partial",
      defaultTarget: "west",
      targets: [
        { id: "west", label: "West", region: "us-west", profile: "openclaw-core", ttlSeconds: 14_400, idleTimeoutSeconds: 14_400, admissionOpen: true },
        { id: "europe", label: "Europe", region: "eu-central", profile: "openclaw-core-eu", ttlSeconds: 14_400, idleTimeoutSeconds: 14_400, admissionOpen: false, message: "Europe target token is unavailable" },
      ],
      githubImport: false,
      inference: { kind: "direct", defaultModel: "openai/gpt-5.5", metadataOnly: true },
    },
  });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/plugins/crabhelm/api/claws`;
  try {
    const blocked = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Blocked Europe",
        owner: { subject: "manual:blocked", label: "Blocked", source: "manual" },
        deployment: { target: "europe" },
      }),
    });
    assert.equal(blocked.status, 422);
    assert.deepEqual(await blocked.json(), { error: "Europe target token is unavailable" });

    const admitted = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "West",
        owner: { subject: "manual:west", label: "West", source: "manual" },
        deployment: { target: "west" },
      }),
    });
    assert.equal(admitted.status, 202);
    const claw = await admitted.json() as ClawRecord;
    assert.deepEqual(claw.desired.deployment, {
      target: "west",
      profile: "openclaw-core",
      region: "us-west",
    });
    assert.equal((await registry.list()).length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("GitHub import preview stays behind the parent API and returns stable member ids", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  let received: unknown;
  const handler = createCrabhelmApiHandler({
    registry,
    reconciler: new CrabhelmReconciler(registry, new SimulatorChildCoreProvider()),
    githubSource: {
      async preview(query) {
        received = query;
        return {
          source: query,
          truncated: false,
          members: [{ id: 42, login: "maintainer", role: "maintain" }],
        };
      },
    },
    runtime: {
      mode: "simulator",
      defaultTarget: "default",
      targets: [
        { id: "default", label: "Default", region: "us-west", profile: "openclaw-core", ttlSeconds: 14_400, idleTimeoutSeconds: 14_400, admissionOpen: true },
        { id: "europe", label: "Europe", region: "eu-central", profile: "openclaw-core-eu", ttlSeconds: 28_800, idleTimeoutSeconds: 14_400, admissionOpen: true },
      ],
      githubImport: true,
      inference: { kind: "direct", defaultModel: "openai/gpt-5.5", metadataOnly: true },
    },
  });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/plugins/crabhelm/api/import/github/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "repository",
          organization: "openclaw",
          repository: "openclaw",
          permission: "maintain",
        }),
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { members: Array<{ id: number }> };
    assert.equal(body.members[0]?.id, 42);
    assert.deepEqual(received, {
      scope: "repository",
      organization: "openclaw",
      repository: "openclaw",
      permission: "maintain",
    });

    const imported = await fetch(
      `http://127.0.0.1:${address.port}/plugins/crabhelm/api/import/github`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: received,
          memberIds: [42],
          options: {
            target: "europe",
            model: "openai/gpt-5.5",
            slackEnabled: false,
            dmPolicy: "pairing",
            groupPolicy: "allowlist",
            logLevel: "info",
          },
        }),
      },
    );
    assert.equal(imported.status, 202);
    const importedBody = await imported.json() as {
      results: Array<{ claw: ClawRecord; member: { id: number } }>;
    };
    assert.equal(importedBody.results[0]?.member.id, 42);
    assert.equal(importedBody.results[0]?.claw.desired.owner.subject, "github:id:42");
    assert.equal(importedBody.results[0]?.claw.desired.slug, "gh-42");
    assert.deepEqual(importedBody.results[0]?.claw.desired.deployment, {
      target: "europe",
      profile: "openclaw-core-eu",
      region: "eu-central",
    });

    const stale = await fetch(
      `http://127.0.0.1:${address.port}/plugins/crabhelm/api/import/github`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: received,
          memberIds: [99],
          options: {
            model: "openai/gpt-5.5",
            slackEnabled: false,
            dmPolicy: "pairing",
            groupPolicy: "allowlist",
            logLevel: "info",
          },
        }),
      },
    );
    assert.equal(stale.status, 422);
    assert.match(String((await stale.json() as { error: string }).error), /current preview/);
    assert.equal((await registry.list()).length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("credential rotation is exposed through the parent API and reconverges", async () => {
  const registry = new CrabhelmRegistry(
    createMemoryStateStore<ClawRecord>(),
    createMemoryStateStore<AuditEvent>(),
  );
  const handler = createCrabhelmApiHandler({
    registry,
    reconciler: new CrabhelmReconciler(registry, new SimulatorChildCoreProvider()),
    runtime: {
      mode: "simulator",
      defaultTarget: "default",
      targets: [
        { id: "default", label: "Default", region: "us-west", profile: "openclaw-core", ttlSeconds: 14_400, idleTimeoutSeconds: 14_400, admissionOpen: true },
      ],
      githubImport: false,
      inference: { kind: "direct", defaultModel: "openai/gpt-5.5", metadataOnly: true },
    },
  });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/plugins/crabhelm/api/claws`;
  try {
    const created = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Rotation Target",
        owner: { subject: "manual:rotation", label: "Rotation", source: "manual" },
      }),
    });
    assert.equal(created.status, 202);
    const claw = await created.json() as ClawRecord;
    assert.equal(claw.desired.credentialsGeneration, 1);

    const rotated = await fetch(`${base}/${claw.id}/rotate-credentials`, { method: "POST" });
    assert.equal(rotated.status, 202);
    const record = await rotated.json() as ClawRecord;
    assert.equal(record.desired.credentialsGeneration, 2);
    assert.equal(record.desired.generation, 2);
    assert.equal(record.observed.phase, "ready");
    assert.equal(record.observed.generation, 2);

    const events = (await registry.snapshot()).events;
    assert.ok(events.some((event) => event.action === "claw.rotate-credentials"));

    const missing = await fetch(`${base}/does-not-exist/rotate-credentials`, { method: "POST" });
    assert.equal(missing.status, 422);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});
