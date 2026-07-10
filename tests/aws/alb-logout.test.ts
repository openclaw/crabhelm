import assert from "node:assert/strict";
import test from "node:test";
import { albLogoutResponse } from "../../aws/alb-logout.js";

const consoleOrigin = "https://crabhelm.example.com";
const sessionCookieName = "AWSELBAuthSessionCookie-7";
const options = { consoleOrigin, sessionCookieName };

test("ALB logout expires the base cookie and every supported shard", () => {
  const response = albLogoutResponse(new Request(`${consoleOrigin}/logout`), options);
  assert.ok(response);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${consoleOrigin}/signed-out`);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.deepEqual(
    response.headers.getSetCookie(),
    [
      sessionCookieName,
      `${sessionCookieName}-0`,
      `${sessionCookieName}-1`,
      `${sessionCookieName}-2`,
      `${sessionCookieName}-3`,
    ].map((name) =>
      `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=-1; Secure; HttpOnly; SameSite=None`
    ),
  );
});

test("ALB logout lands on an unauthenticated no-store page", async () => {
  const response = albLogoutResponse(new Request(`${consoleOrigin}/signed-out`), options);
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/u);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.match(await response.text(), /Signed out/u);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
});

test("ALB logout handles only exact console paths and safe methods", () => {
  assert.equal(
    albLogoutResponse(new Request("https://crabhelm-runtime.example.com/logout"), options),
    undefined,
  );
  assert.equal(
    albLogoutResponse(new Request(`${consoleOrigin}/logout/extra`), options),
    undefined,
  );
  const rejected = albLogoutResponse(new Request(`${consoleOrigin}/logout`, {
    method: "POST",
  }), options);
  assert.ok(rejected);
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET, HEAD");
});
