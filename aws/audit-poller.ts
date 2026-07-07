import {
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  archiveAuditBatch,
  type AuditArchive,
} from "./sqs-queue.js";

export type AuditPollerOptions = {
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
  maxMessages?: number;
  retryDelayMs?: number;
  onError?: (error: unknown) => void;
};

export type AuditPollResult = {
  received: number;
  deleted: number;
  retained: number;
};

/** Long-poll consumer for the singleton ECS service. */
export class AuditQueuePoller {
  readonly #client: SQSClient;
  readonly #queueUrl: string;
  readonly #archive: AuditArchive;
  readonly #waitTimeSeconds: number;
  readonly #visibilityTimeoutSeconds: number;
  readonly #maxMessages: number;
  readonly #retryDelayMs: number;
  readonly #onError: (error: unknown) => void;
  #controller?: AbortController;
  #task?: Promise<void>;

  constructor(
    client: SQSClient,
    queueUrl: string,
    archive: AuditArchive,
    options: AuditPollerOptions = {},
  ) {
    if (!queueUrl.trim()) throw new Error("SQS queue URL is required");
    this.#client = client;
    this.#queueUrl = queueUrl;
    this.#archive = archive;
    this.#waitTimeSeconds = boundedInteger(options.waitTimeSeconds ?? 20, 1, 20, "SQS wait time");
    this.#visibilityTimeoutSeconds = boundedInteger(
      options.visibilityTimeoutSeconds ?? 60,
      0,
      43_200,
      "SQS visibility timeout",
    );
    this.#maxMessages = boundedInteger(options.maxMessages ?? 10, 1, 10, "SQS batch size");
    this.#retryDelayMs = boundedInteger(options.retryDelayMs ?? 1_000, 100, 60_000, "SQS retry delay");
    this.#onError = options.onError ?? ((error) => {
      console.error(JSON.stringify({
        event: "aws_audit_poller_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  get running(): boolean {
    return this.#task !== undefined;
  }

  start(): void {
    if (this.#task) return;
    const controller = new AbortController();
    this.#controller = controller;
    const task = this.#run(controller.signal).finally(() => {
      if (this.#task === task) {
        this.#task = undefined;
        this.#controller = undefined;
      }
    });
    this.#task = task;
  }

  async stop(): Promise<void> {
    const task = this.#task;
    if (!task) return;
    this.#controller?.abort();
    await task;
  }

  async pollOnce(signal?: AbortSignal): Promise<AuditPollResult> {
    const response = await this.#client.send(new ReceiveMessageCommand({
      QueueUrl: this.#queueUrl,
      WaitTimeSeconds: this.#waitTimeSeconds,
      VisibilityTimeout: this.#visibilityTimeoutSeconds,
      MaxNumberOfMessages: this.#maxMessages,
      MessageAttributeNames: ["All"],
    }), signal ? { abortSignal: signal } : undefined);
    const messages = response.Messages ?? [];
    if (messages.length === 0) return { received: 0, deleted: 0, retained: 0 };

    const records = messages.map((message, index) => ({
      messageId: entryId(index),
      body: message.Body ?? "",
    }));
    const archived = await archiveAuditBatch({ Records: records }, this.#archive);
    const retained = new Set(archived.batchItemFailures.map((failure) => failure.itemIdentifier));
    const deletions = deletionEntries(messages, retained);
    if (deletions.length === 0) {
      return { received: messages.length, deleted: 0, retained: messages.length };
    }

    const deletion = await this.#client.send(new DeleteMessageBatchCommand({
      QueueUrl: this.#queueUrl,
      Entries: deletions,
    }), signal ? { abortSignal: signal } : undefined);
    for (const failed of deletion.Failed ?? []) {
      this.#report(new Error(`SQS audit delete failed (${failed.Code ?? "unknown"}): ${failed.Message ?? failed.Id}`));
    }
    const failedDeletes = deletion.Failed?.length ?? 0;
    const deleted = deletion.Successful?.length ?? Math.max(0, deletions.length - failedDeletes);
    return {
      received: messages.length,
      deleted,
      retained: messages.length - deleted,
    };
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
      } catch (error) {
        if (signal.aborted) break;
        this.#report(error);
        await delay(this.#retryDelayMs, signal);
      }
    }
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Error reporting must not stop queue consumption.
    }
  }
}

function deletionEntries(
  messages: Message[],
  retained: ReadonlySet<string>,
): Array<{ Id: string; ReceiptHandle: string }> {
  return messages.flatMap((message, index) => {
    const id = entryId(index);
    if (retained.has(id) || !message.ReceiptHandle) return [];
    return [{ Id: id, ReceiptHandle: message.ReceiptHandle }];
  });
}

function entryId(index: number): string {
  return `message-${index}`;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      done();
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}
