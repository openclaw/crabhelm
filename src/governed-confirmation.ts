type JsonObject = Record<string, unknown>;

export async function waitForConfirmation(
  controlUrl: string,
  turnToken: string,
  id: string,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + 9 * 60 * 1000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const response = await fetch(new URL(`/api/runtime/confirmations/${encodeURIComponent(id)}`, controlUrl), {
      signal: signal ? AbortSignal.any([AbortSignal.timeout(15_000), signal]) : AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${turnToken}` },
    });
    const result = await boundedJson(response);
    if (!response.ok) throw new Error(providerError(result, response.status));
    if (result.status !== "pending") return String(result.status);
    await sleep(2_000, signal);
  }
  return "expired";
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(ms);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  if (combined.aborted) {
    signal?.throwIfAborted();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    combined.addEventListener("abort", () => {
      if (signal?.aborted) reject(signal.reason);
      else resolve();
    }, { once: true });
  });
}

export async function boundedJson(response: Response): Promise<JsonObject> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 128 * 1024) throw new Error("Crabhelm response is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 128 * 1024) throw new Error("Crabhelm response is too large");
  try { return JSON.parse(new TextDecoder().decode(bytes)) as JsonObject; }
  catch { throw new Error(`Crabhelm returned invalid JSON (${response.status})`); }
}

export function providerError(value: JsonObject, status: number): string {
  return typeof value.error === "string" ? value.error.slice(0, 300) : `Crabhelm request failed (${status})`;
}
