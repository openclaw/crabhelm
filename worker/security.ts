import { randomUUID } from "node:crypto";
import type { InvocationGrantClaims, PrincipalRole, RuntimeClaims, RuntimeTicketClaims, SessionClaims, TurnClaims } from "../src/governance-types.js";

type Claims = InvocationGrantClaims | SessionClaims | RuntimeClaims | RuntimeTicketClaims | TurnClaims;
const encoder = new TextEncoder();

export async function signClaims<T extends Claims>(secret: string, claims: Omit<T, "iss" | "jti" | "iat" | "exp">, ttlSeconds: number): Promise<string> {
  requireSecret(secret);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 86_400) throw new Error("token TTL is invalid");
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iss: "crabhelm", jti: randomUUID(), iat: now, exp: now + ttlSeconds } as T;
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await signature(secret, encoded)}`;
}

export async function verifyClaims<T extends Claims>(secret: string, token: string, expected: { typ: T["typ"]; aud: T["aud"] }): Promise<T> {
  requireSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("token is malformed");
  const actual = await signature(secret, parts[0]);
  if (!constantTimeText(actual, parts[1])) throw new Error("token signature is invalid");
  let claims: T;
  try { claims = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0]))) as T; } catch { throw new Error("token payload is invalid"); }
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== "crabhelm" || claims.typ !== expected.typ || claims.aud !== expected.aud || !claims.jti || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) throw new Error("token claims are invalid");
  if (claims.exp <= now || claims.iat > now + 30 || claims.exp - claims.iat > 86_400) throw new Error("token expired or has an invalid lifetime");
  return claims;
}

export function sessionPayload(principalId: string, roles: PrincipalRole[]) {
  return { typ: "session" as const, aud: "crabhelm-control-plane" as const, principalId, roles };
}

async function signature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

function constantTimeText(a: string, b: string): boolean {
  const aa = encoder.encode(a), bb = encoder.encode(b);
  let mismatch = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) mismatch |= (aa[i % aa.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  return mismatch === 0;
}

function requireSecret(secret: string): void {
  if (typeof secret !== "string" || encoder.encode(secret).byteLength < 32) throw new Error("signing secret must contain at least 32 bytes");
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  return new Uint8Array(Buffer.from(value, "base64url"));
}
