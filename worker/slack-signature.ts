const maxSlackBodyBytes = 128 * 1024;

export async function verifySlackRequest(headers: Headers, raw: Uint8Array, secret: string, now = Date.now()): Promise<boolean> {
  if (!secret || raw.byteLength > maxSlackBodyBytes) return false;
  const timestamp = headers.get("x-slack-request-timestamp") ?? "";
  const signature = headers.get("x-slack-signature") ?? "";
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(now / 1000 - seconds) > 5 * 60 || !/^v0=[0-9a-f]{64}$/u.test(signature)) return false;
  const payload = new TextEncoder().encode(`v0:${timestamp}:${new TextDecoder().decode(raw)}`);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = Buffer.from(await crypto.subtle.sign("HMAC", key, payload)).toString("hex");
  return constantTime(`v0=${digest}`, signature);
}

function constantTime(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length, 1);
  for (let index = 0; index < length; index++) mismatch |= (left[index % left.length] ?? 0) ^ (right[index % right.length] ?? 0);
  return mismatch === 0;
}
