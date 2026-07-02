import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRestMemberSource } from "../src/github.js";

test("GitHub organization import paginates, deduplicates, and preserves numeric identity", async () => {
  const urls: string[] = [];
  const source = new GitHubRestMemberSource({
    token: "test-token",
    fetch: async (input) => {
      urls.push(String(input));
      const page = new URL(String(input)).searchParams.get("page");
      const values = page === "1"
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, login: `member-${index + 1}`, type: "User" }))
        : [{ id: 1, login: "member-1", type: "User" }, { id: 101, login: "zeta", type: "User" }];
      return new Response(JSON.stringify(values), { status: 200 });
    },
  });

  const result = await source.preview({ scope: "organization", organization: "OpenClaw", role: "member" });
  assert.equal(result.members.length, 101);
  assert.deepEqual(result.members.find((member) => member.id === 101), { id: 101, login: "zeta" });
  assert.equal(urls.length, 2);
  assert.match(urls[0] ?? "", /\/orgs\/openclaw\/members\?/);
  assert.match(urls[0] ?? "", /role=member/);
});

test("GitHub repository import keeps only maintainers and admins", async () => {
  const source = new GitHubRestMemberSource({
    token: "test-token",
    fetch: async () => new Response(JSON.stringify([
      { id: 1, login: "reader", type: "User", permissions: { pull: true }, role_name: "read" },
      { id: 2, login: "maintainer", type: "User", permissions: { maintain: true }, role_name: "maintain" },
      { id: 3, login: "owner", type: "User", permissions: { admin: true }, role_name: "admin" },
      { id: 4, login: "build-bot", type: "Bot", permissions: { admin: true } },
    ]), { status: 200 }),
  });

  const result = await source.preview({
    scope: "repository",
    organization: "openclaw",
    repository: "openclaw",
    permission: "maintain",
  });
  assert.deepEqual(result.members.map((member) => [member.id, member.role]), [[2, "maintain"], [3, "admin"]]);
});

test("GitHub repository discovery bounds scanned pages even when few collaborators match", async () => {
  let requests = 0;
  const source = new GitHubRestMemberSource({
    token: "test-token",
    maxMembers: 101,
    fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify(
        Array.from({ length: 100 }, (_, index) => ({
          id: requests * 1_000 + index,
          login: `reader-${requests}-${index}`,
          type: "User",
          permissions: { pull: true },
          role_name: "read",
        })),
      ), { status: 200 });
    },
  });

  const result = await source.preview({
    scope: "repository",
    organization: "openclaw",
    repository: "openclaw",
    permission: "maintain",
  });
  assert.equal(requests, 2);
  assert.equal(result.members.length, 0);
  assert.equal(result.truncated, true);
});

test("GitHub import rejects insecure API origins and bounded input errors", async () => {
  assert.throws(
    () => new GitHubRestMemberSource({ baseUrl: "http://github.example.test", token: "test" }),
    /HTTPS or loopback/,
  );
  const source = new GitHubRestMemberSource({
    token: "test",
    fetch: async () => new Response("[]", { status: 200 }),
  });
  await assert.rejects(
    source.preview({ scope: "team", organization: "bad/org", team: "core" }),
    /organization is invalid/,
  );
});
