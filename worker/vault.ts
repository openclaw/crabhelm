type Envelope = { v: 1; iv: string; ciphertext: string; createdAt: string };
const encoder = new TextEncoder();

export class OAuthVault {
  readonly #bucket: R2Bucket;
  readonly #masterKey: string;

  constructor(bucket: R2Bucket, masterKey: string) {
    this.#bucket = bucket;
    this.#masterKey = masterKey;
  }

  async put(connectionId: string, principalId: string, provider: string, secret: string): Promise<string> {
    if (!secret || encoder.encode(secret).byteLength > 16 * 1024) throw new Error("OAuth secret is invalid");
    const key = vaultKey(connectionId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: source(iv), additionalData: source(aad(connectionId, principalId, provider)) }, await this.#key(), source(encoder.encode(secret)));
    const envelope: Envelope = { v: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)), createdAt: new Date().toISOString() };
    await this.#bucket.put(key, JSON.stringify(envelope), { httpMetadata: { contentType: "application/json" }, customMetadata: { classification: "credential-envelope" } });
    return key;
  }

  async get(vaultObjectKey: string, connectionId: string, principalId: string, provider: string): Promise<string> {
    if (vaultObjectKey !== vaultKey(connectionId)) throw new Error("vault key does not match connection");
    const object = await this.#bucket.get(vaultObjectKey);
    if (!object) throw new Error("OAuth credential is unavailable");
    const envelope = JSON.parse(await object.text()) as Envelope;
    if (envelope.v !== 1) throw new Error("OAuth credential envelope is unsupported");
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: source(decode(envelope.iv)), additionalData: source(aad(connectionId, principalId, provider)) }, await this.#key(), source(decode(envelope.ciphertext)));
      return new TextDecoder().decode(plain);
    } catch { throw new Error("OAuth credential could not be decrypted"); }
  }

  async delete(vaultObjectKey: string): Promise<void> { await this.#bucket.delete(vaultObjectKey); }

  async #key(): Promise<CryptoKey> {
    const raw = decode(this.#masterKey);
    if (raw.byteLength !== 32) throw new Error("vault master key must be 32-byte base64url");
    return crypto.subtle.importKey("raw", source(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
}

function vaultKey(id: string): string { return `oauth/${encodeURIComponent(id)}.json`; }
function aad(id: string, principal: string, provider: string): Uint8Array { return encoder.encode(JSON.stringify({ id, principal, provider, v: 1 })); }
function encode(value: Uint8Array): string { return Buffer.from(value).toString("base64url"); }
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  return new Uint8Array(Buffer.from(value, "base64url"));
}
function source(value: Uint8Array): ArrayBuffer { return Uint8Array.from(value).buffer; }
