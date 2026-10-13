import {
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { archiveAuditEvent, type AuditArchive } from "../src/audit-archive.js";

export type QueueSendOptions = {
  contentType?: "json" | "text";
  delaySeconds?: number;
  messageGroupId?: string;
  messageDeduplicationId?: string;
};

export class AwsSqsQueue {
  readonly #client: SQSClient;
  readonly #queueUrl: string;

  constructor(client: SQSClient, queueUrl: string) {
    if (!queueUrl.trim()) throw new Error("SQS queue URL is required");
    this.#client = client;
    this.#queueUrl = queueUrl;
  }

  async send(body: unknown, options: QueueSendOptions = {}): Promise<void> {
    const contentType = options.contentType ?? (typeof body === "string" ? "text" : "json");
    const message = contentType === "json" ? encodeJsonBody(body) : requireTextBody(body);
    if (Buffer.byteLength(message, "utf8") > 1024 * 1024) {
      throw new Error("SQS message exceeds 1 MiB");
    }
    if (options.delaySeconds !== undefined &&
        (!Number.isInteger(options.delaySeconds) || options.delaySeconds < 0 || options.delaySeconds > 900)) {
      throw new Error("SQS delay must be between 0 and 900 seconds");
    }
    await this.#client.send(new SendMessageCommand({
      QueueUrl: this.#queueUrl,
      MessageBody: message,
      MessageAttributes: {
        "content-type": { DataType: "String", StringValue: contentType === "json" ? "application/json" : "text/plain" },
      },
      ...(options.delaySeconds === undefined ? {} : { DelaySeconds: options.delaySeconds }),
      ...(options.messageGroupId ? { MessageGroupId: options.messageGroupId } : {}),
      ...(options.messageDeduplicationId ? { MessageDeduplicationId: options.messageDeduplicationId } : {}),
    }));
  }
}

export type SqsEventRecord = {
  messageId: string;
  body: string;
};

export type SqsEvent = {
  Records: SqsEventRecord[];
};

export type SqsBatchResponse = {
  batchItemFailures: Array<{ itemIdentifier: string }>;
};

/** Archives valid events and returns Lambda's partial-batch failure shape. */
export async function archiveAuditBatch(
  event: SqsEvent,
  archive: AuditArchive,
): Promise<SqsBatchResponse> {
  const results = await Promise.allSettled(event.Records.map(async (record) => {
    // Parse and archive failures remain eligible for the configured SQS redrive.
    await archiveAuditEvent(JSON.parse(record.body), archive);
  }));
  return {
    batchItemFailures: results.flatMap((result, index) => result.status === "rejected"
      ? [{ itemIdentifier: event.Records[index]!.messageId }]
      : []),
  };
}

export function createAuditArchiveHandler(archive: AuditArchive) {
  return (event: SqsEvent): Promise<SqsBatchResponse> => archiveAuditBatch(event, archive);
}

function requireTextBody(value: unknown): string {
  if (typeof value !== "string") throw new Error("text queue messages must be strings");
  return value;
}

function encodeJsonBody(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("queue message is not JSON serializable");
  return encoded;
}
