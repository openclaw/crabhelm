import assert from "node:assert/strict";
import test from "node:test";
import { resolveCrabhelmConfig } from "../src/config.js";

test("deployment config synthesizes one fixed unconfigured target by default", () => {
  const config = resolveCrabhelmConfig({});
  assert.deepEqual(config.deployment, {
    simulator: false,
    defaultTarget: "default",
    targets: [{
      id: "default",
      label: "default",
      tokenEnv: "CRABHELM_CRABBOX_TOKEN",
      profile: "openclaw-core",
      ttlSeconds: 14_400,
      idleTimeoutSeconds: 14_400,
    }],
  });
});

test("deployment config resolves independent administrator-defined targets", () => {
  const config = resolveCrabhelmConfig({
    deployment: {
      defaultTarget: "europe",
      targets: [
        {
          id: "west",
          label: "US West",
          region: "us-west",
          crabboxUrl: "https://west.example.test",
          tokenEnv: "CRABHELM_WEST_TOKEN",
          profile: "openclaw-core",
        },
        {
          id: "europe",
          label: "EU Central",
          region: "eu-central",
          crabboxUrl: "https://eu.example.test",
          tokenEnv: "CRABHELM_EU_TOKEN",
          profile: "openclaw-core-eu",
          ttlSeconds: 86_400,
        },
      ],
    },
  });
  assert.equal(config.deployment.defaultTarget, "europe");
  assert.equal(config.deployment.targets[0]?.tokenEnv, "CRABHELM_WEST_TOKEN");
  assert.deepEqual(config.deployment.targets[1], {
    id: "europe",
    label: "EU Central",
    region: "eu-central",
    crabboxUrl: "https://eu.example.test",
    tokenEnv: "CRABHELM_EU_TOKEN",
    profile: "openclaw-core-eu",
    ttlSeconds: 86_400,
    idleTimeoutSeconds: 14_400,
  });
});

test("deployment config rejects duplicate and missing default targets", () => {
  assert.throws(
    () => resolveCrabhelmConfig({ deployment: { targets: [{ id: "same" }, { id: "same" }] } }),
    /duplicated/,
  );
  assert.throws(
    () => resolveCrabhelmConfig({ deployment: { defaultTarget: "missing", targets: [{ id: "only" }] } }),
    /must name a configured target/,
  );
});
