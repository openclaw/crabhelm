import type { GovernanceAuditEvent } from "./governance-types.js";

export type AuditArchive = {
  put(key: string, value: string, options: {
    httpMetadata: { contentType: string };
    customMetadata: Record<string, string>;
  }): Promise<unknown>;
};

export async function archiveAuditEvent(value: unknown, archive: AuditArchive): Promise<void> {
  if (!isAuditEvent(value)) throw new Error("audit message is malformed");
  // Use the producer's identity on replay so both queue backends overwrite the
  // same object instead of creating a second archive record.
  const date = value.at.slice(0, 10);
  await archive.put(`${date}/${value.at}-${value.id}.json`, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      classification: "audit-metadata",
      correlationId: value.correlationId,
    },
  });
}

function isAuditEvent(value: unknown): value is GovernanceAuditEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<GovernanceAuditEvent>;
  if (typeof event.id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(event.id)) return false;
  if (typeof event.at !== "string" || !/^\d{4}-\d{2}-\d{2}T[^/]{1,80}$/u.test(event.at)) return false;
  if (typeof event.correlationId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(event.correlationId)) return false;
  if (typeof event.action !== "string" || typeof event.summary !== "string") return false;
  if (typeof event.outcome !== "string" || !new Set(["requested", "succeeded", "failed", "denied"]).has(event.outcome)) return false;
  return true;
}
