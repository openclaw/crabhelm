import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";

export type ObjectHttpMetadata = {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
};

export type ObjectPutOptions = {
  httpMetadata?: ObjectHttpMetadata;
  customMetadata?: Record<string, string>;
};

export type ObjectBody =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>;

export type StoredObject = {
  key: string;
  body: ReadableStream<Uint8Array>;
  httpEtag: string;
  etag: string;
  size: number;
  uploaded?: Date;
  httpMetadata: ObjectHttpMetadata;
  customMetadata: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
};

export type S3BucketOptions = {
  kmsKeyId?: string;
};

/** Minimal R2Bucket-compatible adapter used by the portable control plane. */
export class AwsS3Bucket {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #kmsKeyId?: string;

  constructor(client: S3Client, bucket: string, options: S3BucketOptions = {}) {
    if (!bucket.trim()) throw new Error("S3 bucket name is required");
    this.#client = client;
    this.#bucket = bucket;
    this.#kmsKeyId = options.kmsKeyId?.trim() || undefined;
  }

  async get(key: string): Promise<StoredObject | null> {
    requireKey(key);
    let result: GetObjectCommandOutput;
    try {
      result = await this.#client.send(new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
      }));
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
    if (!result.Body) return null;

    const body = toWebStream(result.Body);
    const consume = () => consumeBody(body);
    return {
      key,
      body,
      httpEtag: result.ETag ?? "",
      etag: stripEtagQuotes(result.ETag ?? ""),
      size: result.ContentLength ?? 0,
      ...(result.LastModified ? { uploaded: result.LastModified } : {}),
      httpMetadata: {
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        ...(result.CacheControl ? { cacheControl: result.CacheControl } : {}),
        ...(result.ContentDisposition ? { contentDisposition: result.ContentDisposition } : {}),
        ...(result.ContentEncoding ? { contentEncoding: result.ContentEncoding } : {}),
        ...(result.ContentLanguage ? { contentLanguage: result.ContentLanguage } : {}),
      },
      customMetadata: { ...(result.Metadata ?? {}) },
      arrayBuffer: consume,
      async text() {
        return new TextDecoder().decode(await consume());
      },
      async json<T = unknown>() {
        return JSON.parse(new TextDecoder().decode(await consume())) as T;
      },
    };
  }

  async put(key: string, value: ObjectBody, options: ObjectPutOptions = {}): Promise<void> {
    requireKey(key);
    const input = sdkBody(value);
    const metadata = options.httpMetadata ?? {};
    await this.#client.send(new PutObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      Body: input.body,
      ...(input.contentLength === undefined ? {} : { ContentLength: input.contentLength }),
      ...(metadata.contentType ? { ContentType: metadata.contentType } : {}),
      ...(metadata.cacheControl ? { CacheControl: metadata.cacheControl } : {}),
      ...(metadata.contentDisposition ? { ContentDisposition: metadata.contentDisposition } : {}),
      ...(metadata.contentEncoding ? { ContentEncoding: metadata.contentEncoding } : {}),
      ...(metadata.contentLanguage ? { ContentLanguage: metadata.contentLanguage } : {}),
      ...(options.customMetadata ? { Metadata: options.customMetadata } : {}),
      ...(this.#kmsKeyId
        ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.#kmsKeyId }
        : {}),
    }));
  }

  async delete(key: string): Promise<void> {
    requireKey(key);
    await this.#client.send(new DeleteObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    }));
  }
}

function sdkBody(value: ObjectBody): {
  body: string | Uint8Array | Blob | Readable;
  contentLength?: number;
} {
  if (typeof value === "string") {
    return { body: value, contentLength: Buffer.byteLength(value) };
  }
  if (value instanceof Uint8Array) {
    return { body: value, contentLength: value.byteLength };
  }
  if (value instanceof ArrayBuffer) {
    return { body: new Uint8Array(value), contentLength: value.byteLength };
  }
  if (value instanceof Blob) {
    return { body: value, contentLength: value.size };
  }
  if (value instanceof ReadableStream) {
    return {
      body: Readable.fromWeb(
        value as import("node:stream/web").ReadableStream<Uint8Array>,
      ),
    };
  }
  throw new Error("unsupported S3 object body");
}

function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  if (body instanceof Blob) return body.stream();
  if (body instanceof Uint8Array) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
  }
  if (body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function") {
    return (body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream();
  }
  if (body instanceof Readable) {
    return Readable.toWeb(body) as ReadableStream<Uint8Array>;
  }
  throw new Error("S3 returned an unsupported object body");
}

async function consumeBody(body: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (candidate.name === "NoSuchBucket") return false;
  return candidate.name === "NoSuchKey" || candidate.name === "NotFound" ||
    candidate.$metadata?.httpStatusCode === 404;
}

function stripEtagQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function requireKey(key: string): void {
  if (!key || Buffer.byteLength(key, "utf8") > 1024) throw new Error("object key is invalid");
}
