import type { ChildCoreProvider } from "./providers.js";
import { childPolicyHash } from "./domain.js";
import {
  CrabhelmOperationalError,
  safeOperationalFailure,
  type CrabhelmOperationalErrorCode,
} from "./errors.js";
import { isRegistryWriteConflict, type CrabhelmRegistry } from "./registry.js";
import type {
  AuditEvent,
  ClawObserved,
  ClawRecord,
  InferenceObservation,
  InspectResult,
  ProvisionResult,
} from "./types.js";

const defaultDrainQuietPeriodMs = 5_000;

export type InferenceControl = {
  reconcile(claw: ClawRecord): Promise<InferenceObservation>;
};

export class CrabhelmReconciler {
  readonly #registry: CrabhelmRegistry;
  readonly #provider: ChildCoreProvider;
  readonly #clawTails = new Map<string, Promise<void>>();
  readonly #drainQuietPeriodMs: number;
  readonly #now: () => Date;
  readonly #inference?: InferenceControl;
  #running = false;

  constructor(
    registry: CrabhelmRegistry,
    provider: ChildCoreProvider,
    options: { drainQuietPeriodMs?: number; now?: () => Date; inference?: InferenceControl } = {},
  ) {
    this.#registry = registry;
    this.#provider = provider;
    this.#drainQuietPeriodMs = options.drainQuietPeriodMs ?? defaultDrainQuietPeriodMs;
    this.#now = options.now ?? (() => new Date());
    this.#inference = options.inference;
    if (!Number.isFinite(this.#drainQuietPeriodMs) || this.#drainQuietPeriodMs < 0) {
      throw new Error("drain quiet period must be a non-negative number");
    }
  }

  async reconcileAll(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const claw of await this.#registry.list()) {
        await this.reconcileOne(claw.id);
      }
    } finally {
      this.#running = false;
    }
  }

  reconcileOne(id: string): Promise<ClawRecord> {
    const previous = this.#clawTails.get(id) ?? Promise.resolve();
    const operation = previous.then(
      () => this.#reconcileOne(id),
      () => this.#reconcileOne(id),
    );
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#clawTails.set(id, tail);
    return operation.finally(() => {
      if (this.#clawTails.get(id) === tail) this.#clawTails.delete(id);
    });
  }

  async #reconcileOne(id: string): Promise<ClawRecord> {
    let claw = await this.#registry.get(id);
    try {
      if (claw.observed.phase === "deleted") return claw;
      let inference: InferenceObservation | undefined;
      if (claw.desired.inference.router.kind === "clawrouter") {
        if (!this.#inference) {
          throw new CrabhelmOperationalError(
            "CLAWROUTER_UNCONFIGURED",
            "ClawRouter desired state has no configured inference control",
          );
        }
        inference = await this.#inference.reconcile(claw);
      }
      if (inference) {
        claw = { ...claw, observed: { ...claw.observed, inference } };
      }
      if (claw.observed.deletion) {
        const attemptAt = this.#now().toISOString();
        if (claw.observed.deletion.stage === "disable") {
          let providerState;
          try {
            providerState = await this.#provider.inspect(claw, { reconcileDesired: false });
          } catch (error) {
            if (!(error instanceof CrabhelmOperationalError) || error.code !== "CRABBOX_WORKSPACE_FAILED") {
              throw error;
            }
            return await this.#writeObserved(claw, {
              ...claw.observed,
              phase: "deleting",
              health: "offline",
              message: "Provider reports a failed workspace; central ingress is closed and runtime drain is next",
              deletion: { ...claw.observed.deletion, stage: "drain", lastAttemptAt: attemptAt },
            });
          }
          if (providerState.absent) {
            return await this.#markProviderAbsent(
              claw,
              providerState.message ?? "Provider resource confirmed absent",
            );
          }
          const result = await this.#provider.disable(claw);
          if (!result.applied) throw new Error(result.message ?? "child disable was not applied");
          const { applied: _applied, ...observedResult } = result;
          return await this.#writeObserved(claw, {
            ...claw.observed,
            ...observedResult,
            phase: "deleting",
            message: "Child ingress disabled; waiting for active agent runs to drain",
            deletion: { ...claw.observed.deletion, stage: "drain", lastAttemptAt: attemptAt },
          });
        }
        if (claw.observed.deletion.stage === "drain") {
          let providerState;
          try {
            providerState = await this.#provider.inspect(claw, { reconcileDesired: false });
          } catch (error) {
            if (!(error instanceof CrabhelmOperationalError) || error.code !== "CRABBOX_WORKSPACE_FAILED") {
              throw error;
            }
            providerState = { absent: false };
          }
          if (providerState.absent) {
            return await this.#markProviderAbsent(
              claw,
              providerState.message ?? "Provider resource confirmed absent during drain",
            );
          }
          const result = await this.#provider.drain(claw);
          const drainObservedAt = this.#now().toISOString();
          if (!result.drained) {
            return await this.#writeObserved(claw, {
              ...claw.observed,
              phase: "deleting",
              message: result.message,
              deletion: {
                ...claw.observed.deletion,
                lastAttemptAt: attemptAt,
                drainedAt: undefined,
              },
            });
          }
          const drainedAt = claw.observed.deletion.drainedAt;
          if (!drainedAt) {
            return await this.#writeObserved(claw, {
              ...claw.observed,
              phase: "deleting",
              message: "No active child runs; confirming a quiet drain period before release",
              deletion: {
                ...claw.observed.deletion,
                lastAttemptAt: attemptAt,
                drainedAt: drainObservedAt,
              },
            });
          }
          const quietFor = this.#now().getTime() - Date.parse(drainedAt);
          if (!Number.isFinite(quietFor) || quietFor < this.#drainQuietPeriodMs) {
            return await this.#writeObserved(claw, {
              ...claw.observed,
              phase: "deleting",
              message: "No active child runs; quiet drain period is still in progress",
              deletion: { ...claw.observed.deletion, lastAttemptAt: attemptAt },
            });
          }
          return await this.#writeObserved(claw, {
            ...claw.observed,
            phase: "deleting",
            message: "Child ingress disabled and active runs drained; provider release is next",
            deletion: { ...claw.observed.deletion, stage: "release", lastAttemptAt: attemptAt },
          });
        }
        if (claw.observed.deletion.stage === "release") {
          const result = await this.#provider.remove(claw);
          if (result.absent) return await this.#markProviderAbsent(claw, result.message);
          return await this.#writeObserved(claw, {
            ...claw.observed,
            phase: "deleting",
            message: result.message,
            deletion: { ...claw.observed.deletion, stage: "confirm", lastAttemptAt: attemptAt },
          });
        }
        if (claw.observed.deletion.stage === "confirm") {
          const result = await this.#provider.remove(claw);
          if (result.absent) return await this.#markProviderAbsent(claw, result.message);
          return await this.#writeObserved(claw, {
            ...claw.observed,
            phase: "deleting",
            message: result.message,
            deletion: { ...claw.observed.deletion, lastAttemptAt: attemptAt },
          });
        }
        if (claw.observed.deletion.stage === "revoke") {
          const result = await this.#provider.revokeControl(claw);
          if (
            !result.alreadyAbsent &&
            !result.removedPairedDevice &&
            !result.rejectedPendingRequest
          ) {
            throw new Error("native parent pairing absence was not confirmed");
          }
          return await this.#markDeleted(claw, `${claw.observed.message}; ${result.message}`);
        }
        const result = await this.#provider.inspect(claw, { reconcileDesired: false });
        if (result.absent) return await this.#markProviderAbsent(claw, "Provider resource confirmed absent");
        return await this.#writeObserved(claw, {
          ...claw.observed,
          phase: "deleting",
          message: result.message ?? "Waiting for provider absence confirmation",
          deletion: { ...claw.observed.deletion, lastAttemptAt: attemptAt },
        });
      }
      if (!claw.desired.enabled) {
        const result = await this.#provider.disable(claw);
        if (!result.applied) throw new Error(result.message ?? "child disable was not applied");
        const { applied: _applied, ...observedResult } = result;
        return await this.#writeObserved(claw, {
          ...claw.observed,
          ...observedResult,
          generation: claw.desired.generation,
          phase: "disabled",
        });
      }
      if (!claw.observed.lifecycle) {
        claw = await this.#writeObserved(claw, {
          ...claw.observed,
          phase: "provisioning",
          message: "Creating one isolated child workspace",
        });
        const result = await this.#provider.provision(claw);
        const resultInference = inferenceResult(inference, result);
        const resultReady = result.phase === "ready" && (!inference || resultInference?.routeVerified === true);
        const now = this.#now().toISOString();
        return await this.#writeObserved(
          claw,
          {
            generation: resultReady ? claw.desired.generation : 0,
            phase: result.phase === "ready" && !resultReady ? "attention" : result.phase,
            message: result.phase === "ready" && !resultReady
              ? "ClawRouter configuration is present but live routed inference proof is missing"
              : result.message,
            health: result.phase === "ready" && !resultReady ? "degraded" : result.health,
            lifecycle: result.lifecycle,
            controlLink: result.controlLink ?? claw.observed.controlLink,
            gatewayVersion: result.gatewayVersion,
            configHash: result.configHash,
            probes: result.probes,
            ...(resultInference ? { inference: resultInference } : {}),
            lastSeenAt: resultReady ? now : undefined,
          },
          resultReady
            ? {
                actor: "crabhelm-reconciler",
                action: "claw.create",
                outcome: "succeeded",
                summary: `${claw.desired.name} is ready`,
                generation: claw.desired.generation,
              }
            : undefined,
        );
      }
      const result = await this.#provider.inspect(claw);
      if (result.absent) {
        return await this.#writeObserved(
          claw,
          {
            ...claw.observed,
            generation: 0,
            phase: "provisioning",
            health: "offline",
            message: "Provider resource expired or disappeared; recreating the managed runtime",
            lifecycle: undefined,
            controlLink: { ...claw.observed.controlLink, status: "offline", lastSeenAt: undefined },
            gatewayVersion: undefined,
            configHash: undefined,
            probes: undefined,
            lastSeenAt: undefined,
          },
          {
            actor: "crabhelm-reconciler",
            action: "claw.recover",
            outcome: "requested",
            summary: `${claw.desired.name} provider resource was absent; replacement requested`,
            generation: claw.desired.generation,
          },
        );
      }
      const ready = result.phase === "ready" && result.health === "healthy";
      const resultInference = inferenceResult(inference, result);
      const routedReady = ready && (!inference || resultInference?.routeVerified === true);
      const policyApplied = result.configHash === childPolicyHash(claw);
      const observed: ClawObserved = {
        ...claw.observed,
        ...result,
        generation: routedReady || policyApplied ? claw.desired.generation : claw.observed.generation,
        phase: ready && !routedReady ? "attention" : result.phase ?? claw.observed.phase,
        message: ready && !routedReady
          ? "ClawRouter configuration is present but live routed inference proof is missing"
          : result.message ?? claw.observed.message,
        health: ready && !routedReady ? "degraded" : result.health ?? claw.observed.health,
        controlLink: result.controlLink ?? claw.observed.controlLink,
        lastSeenAt: result.lastSeenAt ?? claw.observed.lastSeenAt,
        ...(resultInference ? { inference: resultInference } : {}),
      };
      return await this.#writeObserved(claw, observed);
    } catch (error) {
      if (isRegistryWriteConflict(error)) return this.#registry.get(id);
      const failure = safeReconcileFailure(error, claw);
      const message = `${failure.message} [${failure.code}]`;
      try {
        return await this.#writeObserved(
          claw,
        {
          ...claw.observed,
          phase: "attention",
          health: "degraded",
          message: message.slice(0, 500),
        },
        {
          actor: "crabhelm-reconciler",
          action: "claw.reconcile",
          outcome: "failed",
          summary: message.slice(0, 300),
          generation: claw.desired.generation,
          details: { code: failure.code },
        },
        );
      } catch (writeError) {
        if (isRegistryWriteConflict(writeError)) return this.#registry.get(id);
        throw writeError;
      }
    }
  }

  #markDeleted(claw: ClawRecord, message: string): Promise<ClawRecord> {
    return this.#writeObserved(
      claw,
      {
        ...claw.observed,
        generation: claw.desired.generation,
        phase: "deleted",
        health: "offline",
        message,
        controlLink: { ...claw.observed.controlLink, status: "revoked" },
        deletion: undefined,
      },
      {
        actor: "crabhelm-reconciler",
        action: "claw.remove",
        outcome: "succeeded",
        summary: `Removed ${claw.desired.name}; provider absence confirmed`,
        generation: claw.desired.generation,
      },
    );
  }

  #markProviderAbsent(claw: ClawRecord, message: string): Promise<ClawRecord> {
    return this.#writeObserved(claw, {
      ...claw.observed,
      phase: "deleting",
      health: "offline",
      message,
      deletion: {
        ...(claw.observed.deletion ?? {
          requestedAt: this.#now().toISOString(),
        }),
        stage: "revoke",
        lastAttemptAt: this.#now().toISOString(),
      },
    });
  }

  #writeObserved(
    claw: ClawRecord,
    observed: ClawObserved,
    audit?: Omit<AuditEvent, "id" | "at" | "clawId">,
  ): Promise<ClawRecord> {
    return this.#registry.writeObserved(claw.id, observed, audit, {
      expectedRevision: claw.revision,
    });
  }
}

function inferenceResult(
  inference: InferenceObservation | undefined,
  result: ProvisionResult | InspectResult,
): InferenceObservation | undefined {
  if (!inference) return undefined;
  const model = result.probes?.model;
  const routeVerified =
    inference.routerHealthy &&
    inference.catalogReady &&
    model?.liveInferenceProbe === true &&
    model.configuredModel === inference.model &&
    model.resolvedModel === inference.model;
  return { ...inference, routeVerified };
}

function safeReconcileFailure(
  error: unknown,
  claw: ClawRecord,
): { code: CrabhelmOperationalErrorCode; message: string } {
  if (claw.observed.deletion) {
    return safeOperationalFailure(error, {
      code: "CHILD_REMOVAL_FAILED",
      message: "Child removal did not complete",
    });
  }
  if (!claw.observed.lifecycle) {
    return safeOperationalFailure(error, {
      code: "CHILD_PROVISION_FAILED",
      message: "Child provisioning did not complete",
    });
  }
  return safeOperationalFailure(error, {
    code: "CHILD_RECONCILE_FAILED",
    message: "Child reconciliation did not complete",
  });
}
