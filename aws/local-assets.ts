import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type LocalAssetsOptions = {
  spaFallback?: string | false;
};

/** Fetch-like static asset handler for ECS/local AWS deployments. */
export class LocalAssetsFetcher {
  readonly #root: string;
  readonly #spaFallback: string | false;

  constructor(root: string, options: LocalAssetsOptions = {}) {
    if (!path.isAbsolute(root)) throw new Error("asset root must be absolute");
    this.#root = root;
    this.#spaFallback = options.spaFallback === undefined ? "index.html" : options.spaFallback;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (pathname.includes("\0") || pathname.split("/").includes("..")) {
      return new Response("not found", { status: 404 });
    }

    const requested = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const asset = await this.#readAsset(requested) ??
      (this.#spaFallback === false ? undefined : await this.#readAsset(`/${this.#spaFallback}`));
    if (!asset) return new Response("not found", { status: 404 });

    const headers = new Headers({
      "content-type": contentType(asset.path),
      "content-length": String(asset.bytes.byteLength),
      "last-modified": asset.modified.toUTCString(),
    });
    return new Response(request.method === "HEAD" ? null : new Uint8Array(asset.bytes), {
      status: 200,
      headers,
    });
  }

  async #readAsset(pathname: string): Promise<{ path: string; bytes: Buffer; modified: Date } | undefined> {
    const root = await realpath(this.#root);
    const candidate = path.resolve(root, `.${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    if (!isWithin(root, candidate)) return undefined;
    let actual: string;
    try {
      actual = await realpath(candidate);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    if (!isWithin(root, actual)) return undefined;
    const details = await stat(actual);
    if (!details.isFile()) return undefined;
    return { path: actual, bytes: await readFile(actual), modified: details.mtime };
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" &&
    ["ENOENT", "ENOTDIR"].includes(String((error as { code?: unknown }).code)));
}

function contentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".txt": return "text/plain; charset=utf-8";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}
