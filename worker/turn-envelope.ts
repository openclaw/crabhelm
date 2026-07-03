type Envelope = { v: 1; iv: string; ciphertext: string };
const encoder = new TextEncoder();

export async function encryptTurnPayload(masterKey: string, jobId: string, payload: unknown): Promise<string> {
  const plain = encoder.encode(JSON.stringify(payload));
  if (plain.byteLength > 64 * 1024) throw new Error("turn payload exceeds 64 KiB");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: source(iv), additionalData: source(aad(jobId)) },
    await key(masterKey),
    source(plain),
  );
  return JSON.stringify({ v: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) } satisfies Envelope);
}

export async function decryptTurnPayload<T>(masterKey: string, jobId: string, value: string): Promise<T> {
  const envelope = JSON.parse(value) as Envelope;
  if (envelope.v !== 1) throw new Error("turn envelope is unsupported");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: source(decode(envelope.iv)), additionalData: source(aad(jobId)) },
      await key(masterKey),
      source(decode(envelope.ciphertext)),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new Error("turn payload could not be decrypted");
  }
}

async function key(value: string): Promise<CryptoKey> {
  const raw = decode(value);
  if (raw.byteLength !== 32) throw new Error("turn envelope key must be 32-byte base64url");
  return crypto.subtle.importKey("raw", source(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function aad(jobId: string): Uint8Array { return encoder.encode(JSON.stringify({ purpose: "runtime-turn", jobId, v: 1 })); }
function encode(value: Uint8Array): string { return Buffer.from(value).toString("base64url"); }
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  return new Uint8Array(Buffer.from(value, "base64url"));
}
function source(value: Uint8Array): ArrayBuffer { return Uint8Array.from(value).buffer; }
