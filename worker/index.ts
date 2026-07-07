import type { GovernanceAuditEvent } from "../src/governance-types.js";
import { archiveAuditEvent, handleCrabhelmRequest } from "./http-service.js";

export { CrabhelmControlPlane } from "./control-plane.js";
export { CrabhelmClawCoordinator } from "./claw-coordinator.js";
export { CrabhelmAdmin } from "./admin-entrypoint.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleCrabhelmRequest(request, env, ctx, { runtimeLabel: "cloudflare-workers" });
  },
  async queue(batch: MessageBatch<GovernanceAuditEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await archiveAuditEvent(message.body, env);
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, GovernanceAuditEvent>;
