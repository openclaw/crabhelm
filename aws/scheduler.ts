export class CoalescingScheduler {
  readonly #run: () => Promise<void>;
  readonly #retryMs: number;
  #timer?: ReturnType<typeof setTimeout>;
  #scheduledAt?: number;
  #stopped = false;

  constructor(run: () => Promise<void>, options: { retryMs?: number } = {}) {
    this.#run = run;
    this.#retryMs = options.retryMs ?? 15_000;
  }

  async schedule(at: number): Promise<void> {
    if (this.#stopped) return;
    if (!Number.isFinite(at)) throw new Error("scheduled time must be finite");
    const normalized = Math.max(Date.now(), Math.floor(at));
    if (this.#scheduledAt !== undefined && this.#scheduledAt <= normalized) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#scheduledAt = normalized;
    this.#timer = setTimeout(() => void this.#fire(), Math.min(normalized - Date.now(), 2_147_483_647));
  }

  stop(): void {
    this.#stopped = true;
    this.#scheduledAt = undefined;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #fire(): Promise<void> {
    if (this.#stopped) return;
    this.#timer = undefined;
    this.#scheduledAt = undefined;
    try {
      await this.#run();
    } catch (error) {
      console.error(JSON.stringify({
        event: "aws_control_plane_reconcile_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      await this.schedule(Date.now() + this.#retryMs);
    }
  }
}
