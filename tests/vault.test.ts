import assert from "node:assert/strict";
import test from "node:test";
import { OAuthVault } from "../worker/vault.js";

const masterKey = Buffer.alloc(32, 7).toString("base64url");

test("vault get rejects oversized envelopes before reading the object body", async () => {
  let textCalls = 0;
  const bucket = {
    async get() {
      return {
        size: 1024 * 1024,
        async text() {
          textCalls += 1;
          return "x".repeat(1024 * 1024);
        },
      };
    },
    async put() {},
    async delete() {},
  };
  const vault = new OAuthVault(bucket as never, masterKey);
  await assert.rejects(
    () => vault.get("oauth/conn.json", "conn", "principal", "github"),
    /envelope is too large/u,
  );
  assert.equal(textCalls, 0);
});

test("vault get rejects a huge body when object size is missing", async () => {
  const payload = "x".repeat(64 * 1024);
  const bucket = {
    async get() {
      return {
        size: 0,
        async text() {
          return payload;
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
      };
    },
    async put() {},
    async delete() {},
  };
  const vault = new OAuthVault(bucket as never, masterKey);
  await assert.rejects(
    () => vault.get("oauth/conn.json", "conn", "principal", "github"),
    /envelope is too large/u,
  );
});

test("vault put and get round-trip a max-size secret", async () => {
  const store = new Map<string, string>();
  const bucket = {
    async get(key: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return {
        size: bytes.byteLength,
        async text() {
          return value;
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  const vault = new OAuthVault(bucket as never, masterKey);
  const secret = "s".repeat(16 * 1024);
  const key = await vault.put("conn", "principal", "github", secret);
  assert.equal(key, "oauth/conn.json");
  assert.equal(await vault.get(key, "conn", "principal", "github"), secret);
  await assert.rejects(
    () => vault.put("conn", "principal", "github", `${secret}x`),
    /OAuth secret is invalid/u,
  );
});
