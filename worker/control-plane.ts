import { DurableObject } from "cloudflare:workers";
import type { AccessIdentity } from "./access.js";
import { CrabhelmControlPlaneService } from "./control-plane-service.js";
import { DurableObjectStateDatabase } from "./state.js";

export class CrabhelmControlPlane extends DurableObject<Env> {
  readonly #service: CrabhelmControlPlaneService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#service = new CrabhelmControlPlaneService(
      new DurableObjectStateDatabase(ctx.storage),
      env,
      {
        schedule: (at) => ctx.storage.setAlarm(at),
        restart: () => {
          ctx.abort("Crabhelm deployment requested a control-plane isolate restart");
          throw new Error("control-plane isolate restart did not abort execution");
        },
      },
    );
  }

  fetch(request: Request): Promise<Response> {
    return this.#service.fetch(request);
  }

  deploymentIdentity(): { archiveId: string; releaseId: string } {
    return this.#service.deploymentIdentity();
  }

  restartForDeployment(): never {
    return this.#service.restartForDeployment();
  }

  alarm(): Promise<void> {
    return this.#service.alarm();
  }

  managedSpec(clawId: string): Promise<Response> {
    return this.#service.managedSpec(clawId);
  }

  bootstrapInference(clawId: string) {
    return this.#service.bootstrapInference(clawId);
  }

  inferenceCredentials(clawId: string, credentialsGeneration: number) {
    return this.#service.inferenceCredentials(clawId, credentialsGeneration);
  }

  prometheusMetrics() {
    return this.#service.prometheusMetrics();
  }

  resolveAccessIdentity(identity: AccessIdentity): Promise<{
    principalId: string;
    roles: Array<"administrator" | "member">;
  }> {
    return this.#service.resolveAccessIdentity(identity);
  }

  routeSlackTurn(input: Parameters<CrabhelmControlPlaneService["routeSlackTurn"]>[0]) {
    return this.#service.routeSlackTurn(input);
  }

  decideSlackConfirmation(
    input: Parameters<CrabhelmControlPlaneService["decideSlackConfirmation"]>[0],
  ) {
    return this.#service.decideSlackConfirmation(input);
  }
}
