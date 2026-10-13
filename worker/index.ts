import { archiveAuditEvent } from "../src/audit-archive.js";
import { handleCrabhelmRequest } from "./http-service.js";

export { CrabhelmControlPlane } from "./control-plane.js";
export { CrabhelmClawCoordinator } from "./claw-coordinator.js";
export { CrabhelmAdmin } from "./admin-entrypoint.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleCrabhelmRequest(request, env, ctx, { runtimeLabel: "cloudflare-workers" });
  },
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await archiveAuditEvent(message.body, env.AUDIT_ARCHIVE);
        message.ack();
      } catch {
        // Keep a failed record eligible for retry without consuming attempts
        // on valid messages later in the same batch.
        message.retry();
        console.error(JSON.stringify({
          event: "audit_archive_failed",
          messageId: message.id,
          attempts: message.attempts,
        }));
      }
    }
  },
} satisfies ExportedHandler<Env>;
