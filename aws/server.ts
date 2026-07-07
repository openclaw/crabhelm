import { readFile } from "node:fs/promises";
import {
  createServer,
  STATUS_CODES,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { Pool } from "pg";
import WebSocket, { WebSocketServer } from "ws";
import { CrabhelmControlPlaneService } from "../worker/control-plane-service.js";
import {
  authenticateRuntimeConnect,
  handleCrabhelmRequest,
} from "../worker/http-service.js";
import { createAlbIdentityVerifier } from "./alb-identity.js";
import { AuditQueuePoller } from "./audit-poller.js";
import { loadAwsConfig, type AwsConfig } from "./config.js";
import { LocalAssetsFetcher } from "./local-assets.js";
import { runMigrations } from "./migrations.js";
import {
  AwsCoordinatorDirectory,
  type AwsClawCoordinator,
  type AwsRuntimeSocket,
} from "./postgres-coordinator.js";
import { PostgresStateDatabase } from "./postgres-state.js";
import { AwsS3Bucket } from "./s3-bucket.js";
import { CoalescingScheduler } from "./scheduler.js";
import { AwsSqsQueue } from "./sqs-queue.js";
import { awsTerminalDialer } from "./terminal-dialer.js";

const shutdownWebSocketGraceMs = 5_000;
const shutdownHttpGraceMs = 30_000;
const coordinatorSweepIntervalMs = 60_000;
const maxHttpHeaderBytes = 64 * 1024;
const websocketPath = "/api/runtime/connect";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type HttpRequestListener = (request: IncomingMessage, response: ServerResponse) => void;

export function createAwsHttpServer(listener: HttpRequestListener): Server {
  return createServer({ maxHeaderSize: maxHttpHeaderBytes }, listener);
}

export type AwsServerOptions = {
  config?: AwsConfig;
  assetsDirectory?: string;
  migrationsDirectory?: string;
  installSignalHandler?: boolean;
};

export type RunningAwsServer = {
  server: Server;
  close(): Promise<void>;
};

/** Starts the single-process ECS control plane. The ECS service must remain singleton. */
export async function startAwsServer(options: AwsServerOptions = {}): Promise<RunningAwsServer> {
  const config = options.config ?? loadAwsConfig();
  const ca = await verifiedCertificateAuthority(config.aws.databaseCaPath);
  const pool = new Pool({
    connectionString: config.aws.databaseUrl,
    ssl: { ca, rejectUnauthorized: true },
    application_name: "crabhelm-aws",
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (error) => logError("aws_postgres_pool_failed", error));

  let server: Server | undefined;
  let auditPoller: AuditQueuePoller | undefined;
  let controlScheduler: CoalescingScheduler | undefined;
  let coordinatorSweepTimer: ReturnType<typeof setInterval> | undefined;
  let coordinatorSweepTask: Promise<void> | undefined;
  let s3: S3Client | undefined;
  let sqs: SQSClient | undefined;
  let signalHandler: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;

  try {
    await runMigrations(
      pool,
      options.migrationsDirectory ?? path.resolve(process.cwd(), "aws", "migrations"),
    );

    s3 = new S3Client({ region: config.aws.region });
    sqs = new SQSClient({ region: config.aws.region });
    const appliances = new AwsS3Bucket(s3, config.aws.appliancesBucket);
    const oauthVault = new AwsS3Bucket(s3, config.aws.oauthVaultBucket);
    const auditArchive = new AwsS3Bucket(s3, config.aws.auditArchiveBucket);
    const auditQueue = new AwsSqsQueue(sqs, config.aws.auditQueueUrl);
    const assets = new LocalAssetsFetcher(
      options.assetsDirectory ?? path.resolve(process.cwd(), "web"),
    );
    const background = new BackgroundTasks();

    const coordinatorDirectory = new AwsCoordinatorDirectory({
      pool,
      vaultMasterKey: config.controlPlane.VAULT_MASTER_KEY,
      runtimeSigningSecret: config.controlPlane.RUNTIME_SIGNING_SECRET,
      ...(config.controlPlane.SLACK_BOT_TOKEN
        ? { slackBotToken: config.controlPlane.SLACK_BOT_TOKEN }
        : {}),
    });
    // A process-wide cadence cannot be disarmed by coalesced per-claw wakeups.
    const runCoordinatorSweep = (): void => {
      if (coordinatorSweepTask) return;
      coordinatorSweepTask = background.run(() => coordinatorDirectory.cleanupSweep())
        .catch(() => undefined)
        .finally(() => {
          coordinatorSweepTask = undefined;
        });
    };

    let controlPlane: CrabhelmControlPlaneService;
    controlScheduler = new CoalescingScheduler(() => background.run(() => controlPlane.alarm()));
    const controlPlaneNamespace = {
      getByName(name: string) {
        if (name !== "openclaw-org") throw new Error("control-plane name is invalid");
        return controlPlane;
      },
    };
    const env = {
      ...config.controlPlane,
      APPLIANCES: appliances,
      OAUTH_VAULT: oauthVault,
      AUDIT_ARCHIVE: auditArchive,
      AUDIT_QUEUE: auditQueue,
      ASSETS: assets,
      CONTROL_PLANE: controlPlaneNamespace,
      CLAW_COORDINATOR: coordinatorDirectory,
    } as unknown as Env;

    controlPlane = new CrabhelmControlPlaneService(
      new PostgresStateDatabase(pool),
      env,
      {
        schedule: (at) => controlScheduler!.schedule(at),
        restart: () => {
          queueMicrotask(() => process.kill(process.pid, "SIGTERM"));
          throw new Error("AWS control-plane restart requested");
        },
        terminalDialer: awsTerminalDialer,
        accessConfigured: true,
      },
    );

    const identityVerifier = createAlbIdentityVerifier({
      region: config.aws.region,
      loadBalancerArn: config.access.loadBalancerArn,
      oidcIssuer: config.access.oidcIssuer,
      oidcClientId: config.access.oidcClientId,
      adminEmails: config.access.adminEmails,
      adminGroups: config.access.adminGroups,
    });
    const webSockets = new Map<WebSocket, AwsClawCoordinator>();
    const webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: true,
      perMessageDeflate: false,
      maxPayload: 64 * 1024,
      handleProtocols(protocols) {
        return protocols.has("crabhelm.runtime.v1") ? "crabhelm.runtime.v1" : false;
      },
    });
    let shuttingDown = false;

    server = createAwsHttpServer((request, response) => {
      void serveHttpRequest(request, response, {
        config,
        env,
        background,
        identityVerifier,
        shuttingDown: () => shuttingDown,
      }).catch((error: unknown) => {
        logError("aws_http_request_failed", error, {
          method: request.method ?? "unknown",
          path: safePath(request.url),
        });
        failNodeResponse(response);
      });
    });
    server.on("upgrade", (request, socket, head) => {
      // After Node emits `upgrade`, application code owns socket errors.
      socket.on("error", () => undefined);
      if (shuttingDown) {
        void writeUpgradeResponse(socket, new Response("service unavailable", { status: 503 }));
        return;
      }
      void upgradeRuntimeSocket(
        request,
        socket,
        head,
        config,
        env,
        coordinatorDirectory,
        webSocketServer,
        webSockets,
      ).catch((error: unknown) => {
        logError("aws_runtime_upgrade_failed", error, { path: safePath(request.url) });
        if (!socket.destroyed) socket.destroy();
      });
    });

    await listen(server, config.listen.host, config.listen.port);

    auditPoller = new AuditQueuePoller(sqs, config.aws.auditQueueUrl, auditArchive);
    auditPoller.start();
    await controlScheduler.schedule(Date.now());
    runCoordinatorSweep();
    coordinatorSweepTimer = setInterval(runCoordinatorSweep, coordinatorSweepIntervalMs);
    coordinatorSweepTimer.unref();

    const activeServer = server;
    const activeAuditPoller = auditPoller;
    const activeControlScheduler = controlScheduler;
    const activeCoordinatorSweepTimer = coordinatorSweepTimer;
    const activeS3 = s3;
    const activeSqs = sqs;
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        shuttingDown = true;
        if (signalHandler) process.removeListener("SIGTERM", signalHandler);
        activeControlScheduler.stop();
        clearInterval(activeCoordinatorSweepTimer);

        const httpClosed = closeHttpServer(activeServer);
        try {
          const stopped = await Promise.allSettled([
            activeAuditPoller.stop(),
            closeRuntimeSockets(webSockets, webSocketServer),
          ]);
          const drained = await Promise.allSettled([
            closeWebSocketServer(webSocketServer),
            httpClosed,
            background.drain(),
          ]);
          const failed = [...stopped, ...drained].find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        } finally {
          await pool.end();
          activeS3.destroy();
          activeSqs.destroy();
        }
      })();
      return closePromise;
    };

    if (options.installSignalHandler !== false) {
      signalHandler = () => {
        void close().catch((error: unknown) => {
          process.exitCode = 1;
          logError("aws_shutdown_failed", error);
        });
      };
      process.once("SIGTERM", signalHandler);
    }

    console.log(JSON.stringify({
      event: "aws_server_listening",
      host: config.listen.host,
      port: config.listen.port,
    }));
    return { server: activeServer, close };
  } catch (error) {
    controlScheduler?.stop();
    if (coordinatorSweepTimer) clearInterval(coordinatorSweepTimer);
    await auditPoller?.stop().catch(() => undefined);
    if (server?.listening) await closeHttpServer(server).catch(() => undefined);
    s3?.destroy();
    sqs?.destroy();
    await pool.end().catch(() => undefined);
    throw error;
  }
}

type HttpRequestContext = {
  config: AwsConfig;
  env: Env;
  background: BackgroundTasks;
  identityVerifier: ReturnType<typeof createAlbIdentityVerifier>;
  shuttingDown(): boolean;
};

async function serveHttpRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  context: HttpRequestContext,
): Promise<void> {
  if (context.shuttingDown()) {
    await sendNodeResponse(outgoing, new Response("service unavailable", { status: 503 }), incoming.method);
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(new Error("HTTP client disconnected"));
  const abortIfIncomplete = () => {
    if (!outgoing.writableFinished) abort();
  };
  incoming.once("aborted", abort);
  outgoing.once("close", abortIfIncomplete);
  try {
    const request = fetchRequest(incoming, context.config, controller.signal);
    if (!request) {
      await sendNodeResponse(outgoing, new Response("not found", { status: 404 }), incoming.method);
      return;
    }
    const response = await handleCrabhelmRequest(
      request,
      context.env,
      { waitUntil: (promise) => context.background.waitUntil(promise) },
      {
        runtimeLabel: "aws-ecs",
        runtimeConnect: async () => new Response("websocket required", { status: 426 }),
        identityVerifier: (candidate) => context.identityVerifier(candidate),
      },
    );
    await sendNodeResponse(outgoing, response, incoming.method);
  } finally {
    incoming.removeListener("aborted", abort);
    outgoing.removeListener("close", abortIfIncomplete);
  }
}

function fetchRequest(
  incoming: IncomingMessage,
  config: AwsConfig,
  signal: AbortSignal,
): Request | undefined {
  const target = incoming.url ?? "/";
  const origin = requestOrigin(incoming, target, config);
  if (!origin) return undefined;
  const url = new URL(target, origin);
  if (url.origin !== origin) return undefined;

  const method = incoming.method?.toUpperCase() ?? "GET";
  const headers = requestHeaders(incoming);
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    redirect: "manual",
    signal,
    ...(body ? { body, duplex: "half" } : {}),
  };
  return new Request(url, init);
}

function requestOrigin(
  incoming: IncomingMessage,
  target: string,
  config: AwsConfig,
): string | undefined {
  if (!target.startsWith("/") || target.startsWith("//")) return undefined;
  if (isHealthTarget(target)) return config.controlPlane.PUBLIC_URL;
  const hosts = incoming.headersDistinct.host ?? [];
  if (hosts.length !== 1) return undefined;
  let hostOrigin: string;
  try {
    const candidate = new URL(`https://${hosts[0]}`);
    if (candidate.username || candidate.password || candidate.pathname !== "/" || candidate.search || candidate.hash) {
      return undefined;
    }
    hostOrigin = candidate.origin;
  } catch {
    return undefined;
  }
  const publicUrl = new URL(config.controlPlane.PUBLIC_URL);
  if (hostOrigin === publicUrl.origin) return publicUrl.origin;
  const runtimeUrl = new URL(config.controlPlane.RUNTIME_URL);
  return hostOrigin === runtimeUrl.origin ? runtimeUrl.origin : undefined;
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  return headers;
}

async function sendNodeResponse(
  outgoing: ServerResponse,
  response: Response,
  requestMethod?: string,
): Promise<void> {
  outgoing.statusCode = response.status;
  const connectionHeaders = headerTokens(response.headers.get("connection"));
  for (const [name, value] of response.headers) {
    if (hopByHopHeaders.has(name) || connectionHeaders.has(name)) continue;
    if (name === "set-cookie") continue;
    outgoing.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);

  if (requestMethod?.toUpperCase() === "HEAD" || !response.body) {
    await response.body?.cancel();
    outgoing.end();
    return;
  }
  outgoing.flushHeaders();
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
    outgoing,
  );
}

async function upgradeRuntimeSocket(
  incoming: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  config: AwsConfig,
  env: Env,
  coordinators: AwsCoordinatorDirectory,
  webSocketServer: WebSocketServer,
  sockets: Map<WebSocket, AwsClawCoordinator>,
): Promise<void> {
  socket.pause();
  const request = fetchRequest(incoming, config, AbortSignal.timeout(15_000));
  if (!request) {
    await writeUpgradeResponse(socket, new Response("not found", { status: 404 }));
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== config.controlPlane.RUNTIME_URL || url.pathname !== websocketPath) {
    await writeUpgradeResponse(socket, new Response("not found", { status: 404 }));
    return;
  }
  const authentication = await authenticateRuntimeConnect(request, env, url);
  if (!authentication.ok) {
    await writeUpgradeResponse(socket, authentication.response);
    return;
  }

  const coordinator = coordinators.getByName(authentication.identity.clawId);
  webSocketServer.handleUpgrade(incoming, socket, head, (webSocket) => {
    sockets.set(webSocket, coordinator);
    webSocket.once("close", () => sockets.delete(webSocket));
    webSocketServer.emit("connection", webSocket, incoming);
    const runtimeSocket = webSocket as unknown as AwsRuntimeSocket;
    void coordinator.attachSocket(runtimeSocket, authentication.identity).catch((error: unknown) => {
      logError("aws_runtime_attach_failed", error, { clawId: authentication.identity.clawId });
      sockets.delete(webSocket);
      closeWebSocket(webSocket, 1011, "runtime coordinator failed");
    });
  });
}

async function writeUpgradeResponse(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const lines = [
    `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? "Error"}`,
    "Connection: close",
    `Content-Length: ${body.byteLength}`,
  ];
  for (const [name, value] of response.headers) {
    if (hopByHopHeaders.has(name) || name === "content-length" || name === "set-cookie") continue;
    lines.push(`${name}: ${value}`);
  }
  for (const cookie of response.headers.getSetCookie()) lines.push(`set-cookie: ${cookie}`);
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  socket.end(body);
}

async function closeRuntimeSockets(
  sockets: Map<WebSocket, AwsClawCoordinator>,
  server: WebSocketServer,
): Promise<void> {
  const closing = [...server.clients].map(async (socket) => {
    const coordinator = sockets.get(socket);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    let failure: unknown;
    try {
      socket.close(1012, "service restart");
    } catch (error) {
      failure = error;
    }
    try {
      await coordinator?.webSocketClose(socket as unknown as AwsRuntimeSocket);
    } catch (error) {
      failure ??= error;
    }
    await Promise.race([closed, delay(shutdownWebSocketGraceMs)]);
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    if (failure) throw failure;
  });
  await Promise.allSettled(closing);
  sockets.clear();
}

function closeWebSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    socket.terminate();
    return;
  }
  const timer = setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, shutdownWebSocketGraceMs);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function closeHttpServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
  const forced = delay(shutdownHttpGraceMs).then(() => server.closeAllConnections());
  return Promise.race([closed, forced.then(() => closed)]);
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      server.removeListener("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.removeListener("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(port, host);
  });
}

async function verifiedCertificateAuthority(file: string): Promise<string> {
  const ca = await readFile(file, "utf8");
  if (!ca.includes("-----BEGIN CERTIFICATE-----") || !ca.includes("-----END CERTIFICATE-----")) {
    throw new Error("RDS CA bundle is invalid");
  }
  return ca;
}

class BackgroundTasks {
  readonly #tasks = new Set<Promise<void>>();

  waitUntil(promise: Promise<unknown>): void {
    void this.run(() => promise).catch(() => undefined);
  }

  run(operation: () => Promise<unknown>): Promise<void> {
    const operationTask = Promise.resolve()
      .then(operation)
      .then(() => undefined);
    let tracked: Promise<void>;
    tracked = operationTask
      .catch((error: unknown) => logError("aws_background_task_failed", error))
      .finally(() => this.#tasks.delete(tracked));
    this.#tasks.add(tracked);
    return operationTask;
  }

  async drain(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
  }
}

function failNodeResponse(response: ServerResponse): void {
  if (!response.headersSent) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("internal server error");
    return;
  }
  response.destroy();
}

function headerTokens(value: string | null): Set<string> {
  return new Set((value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

function isHealthTarget(value: string): boolean {
  return value === "/healthz" || value.startsWith("/healthz?");
}

function safePath(value: string | undefined): string {
  if (!value) return "/";
  try {
    return new URL(value, "http://localhost").pathname.slice(0, 500);
  } catch {
    return "invalid";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    event,
    ...fields,
    error: error instanceof Error ? error.message : String(error),
  }));
}
