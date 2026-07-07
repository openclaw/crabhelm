import assert from "node:assert/strict";
import test from "node:test";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { createAlbIdentityVerifier } from "../../aws/alb-identity.js";

const region = "us-west-2";
const signer = "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/crabhelm/abc123";
const issuer = "https://identity.example.com";
const client = "crabhelm-client";
const kid = "12345678-1234-1234-1234-123456789012";

test("ALB identity verifier checks the signer, signature, client, issuer, and roles", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const pem = await exportSPKI(publicKey);
  const now = 1_800_000_000_000;
  let fetches = 0;
  const verifier = createAlbIdentityVerifier({
    region,
    loadBalancerArn: signer,
    oidcIssuer: issuer,
    oidcClientId: client,
    adminEmails: ["admin@example.com"],
    adminGroups: [],
    now: () => now,
    fetch: async (url) => {
      fetches++;
      assert.equal(String(url), `https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`);
      return new Response(pem, { status: 200 });
    },
  });
  const token = await new SignJWT({
    sub: "oidc-subject",
    email: "Admin@Example.com",
    email_verified: true,
    groups: ["engineering"],
  }).setProtectedHeader({
    alg: "ES256",
    kid,
    signer,
    client,
    iss: issuer,
    exp: Math.floor(now / 1000) + 300,
  }).sign(privateKey);
  const request = new Request("https://crabhelm.example.com/api/state", {
    headers: {
      "x-amzn-oidc-data": token,
      "x-amzn-oidc-identity": "oidc-subject",
    },
  });

  assert.deepEqual(await verifier(request), {
    subject: "email:admin@example.com",
    email: "admin@example.com",
    roles: ["administrator", "member"],
    groups: ["engineering"],
  });
  await verifier(request);
  assert.equal(fetches, 1, "public key should be cached by kid");
});

test("ALB identity verifier rejects a mismatched signer before fetching a key", async () => {
  const { privateKey } = await generateKeyPair("ES256");
  let fetched = false;
  const now = Date.now();
  const verifier = createAlbIdentityVerifier({
    region,
    loadBalancerArn: signer,
    oidcIssuer: issuer,
    oidcClientId: client,
    adminEmails: [],
    adminGroups: ["admins"],
    now: () => now,
    fetch: async () => {
      fetched = true;
      return new Response("", { status: 500 });
    },
  });
  const token = await new SignJWT({ sub: "subject", email: "member@example.com" })
    .setProtectedHeader({
      alg: "ES256",
      kid,
      signer: `${signer}-forged`,
      client,
      iss: issuer,
      exp: Math.floor(now / 1000) + 300,
    })
    .sign(privateKey);

  await assert.rejects(
    verifier(new Request("https://crabhelm.example.com", {
      headers: { "x-amzn-oidc-data": token },
    })),
    /signer is invalid/u,
  );
  assert.equal(fetched, false);
});

test("ALB identity verifier rejects unsupported AWS China load balancers", () => {
  assert.throws(() => createAlbIdentityVerifier({
    region: "cn-north-1",
    loadBalancerArn:
      "arn:aws-cn:elasticloadbalancing:cn-north-1:123456789012:loadbalancer/app/crabhelm/abc123",
    oidcIssuer: issuer,
    oidcClientId: client,
    adminEmails: [],
    adminGroups: ["admins"],
  }), /ALB ARN is invalid/u);
});

test("ALB identity verifier uses the GovCloud public-key endpoint", async () => {
  const govRegion = "us-gov-west-1";
  const govSigner =
    "arn:aws-us-gov:elasticloadbalancing:us-gov-west-1:123456789012:loadbalancer/app/crabhelm/abc123";
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const pem = await exportSPKI(publicKey);
  const now = 1_800_000_000_000;
  const verifier = createAlbIdentityVerifier({
    region: govRegion,
    loadBalancerArn: govSigner,
    oidcIssuer: issuer,
    oidcClientId: client,
    adminEmails: ["admin@example.com"],
    adminGroups: [],
    now: () => now,
    fetch: async (url) => {
      assert.equal(
        String(url),
        `https://s3-${govRegion}.amazonaws.com/aws-elb-public-keys-prod-${govRegion}/${kid}`,
      );
      return new Response(pem, { status: 200 });
    },
  });
  const token = await new SignJWT({
    sub: "gov-subject",
    email: "admin@example.com",
    email_verified: true,
  }).setProtectedHeader({
    alg: "ES256",
    kid,
    signer: govSigner,
    client,
    iss: issuer,
    exp: Math.floor(now / 1000) + 300,
  }).sign(privateKey);

  assert.equal((await verifier(new Request("https://crabhelm.example.com", {
    headers: { "x-amzn-oidc-data": token },
  })))?.email, "admin@example.com");
});
