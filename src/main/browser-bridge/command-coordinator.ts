import {
  BrowserCommandLedger,
  type Command,
  type CommandAdmission,
  type CommandIntent,
  type CommandReceipt,
  type CommandSpec,
  type DurableCommandSnapshot
} from './command-ledger.js';

export interface CommandPlacement {
  conversationId: string | null;
  background: boolean;
}

interface CommandRuntime {
  deadline: NodeJS.Timeout | null;
  placement: CommandPlacement | null;
}

/**
 * Owns ephemeral browser-command execution state around the durable command ledger.
 *
 * Timers and placement offers are process-local scheduling facts. They never belong in the
 * durable command entity and disappear whenever custody leaves the live ledger. Cross-ledger
 * sequencing remains explicit here while the ledger itself only serializes its own state.
 */
export class BrowserCommandCoordinator {
  readonly #ledger: BrowserCommandLedger;
  readonly #runtime = new Map<string, CommandRuntime>();

  constructor(ledger = new BrowserCommandLedger()) {
    this.#ledger = ledger;
  }

  get commands(): readonly Command[] { return this.#ledger.commands; }
  get receipts(): readonly CommandReceipt[] { return this.#ledger.receipts; }
  get busy(): boolean { return this.#ledger.busy; }

  pendingCommands(): readonly Command[] { return this.#ledger.pendingCommands(); }
  receiptFor(id: string, now = Date.now()): CommandReceipt | null { return this.#ledger.receiptFor(id, now); }
  awaitCommand(id: string): Promise<Command | null> { return this.#ledger.awaitCommand(id); }
  drain(): Promise<void> { return this.#ledger.drain(); }

  stageBrokerIntent(spec: CommandSpec): CommandIntent {
    const intent = this.#ledger.registerIntent(spec);
    return {
      command: intent.command,
      ready: intent.ready.then((result) => {
        if (result?.changed && result.command) this.clearRuntime(result.command);
        return result;
      })
    };
  }

  cancelStagedIntentsWhere(predicate: (command: Command) => boolean): Command[] {
    const cancelled = this.#ledger.cancelIntentsWhere(predicate);
    for (const command of cancelled) this.clearRuntime(command);
    return cancelled;
  }

  async admit(spec: CommandSpec): Promise<CommandAdmission> {
    const result = await this.#ledger.admit(spec);
    if (result.changed && result.command) this.clearRuntime(result.command);
    return result;
  }

  lease(command: Command, owner: string | null, claimedAt: number, allowOwnerTakeover = false): Promise<boolean> {
    return this.#ledger.lease(command, owner, claimedAt, allowOwnerTakeover);
  }

  /**
   * Runs one exact continuation checkpoint while the resume command's browser owner cannot change.
   * The callback is continuation authority only; ordinary callers never receive the ledger's
   * generic serialized-callback primitive.
   */
  runContinuationCheckpoint<T>(
    command: Command,
    owner: string,
    continuationClaimCurrent: () => boolean,
    operation: () => Promise<T>
  ): Promise<T | null> {
    if (command.spec.type !== 'resume') return Promise.resolve(null);
    return this.#ledger.runExclusiveOwned(command, owner, continuationClaimCurrent, operation);
  }

  async finalize(command: Command, receipt: CommandReceipt): Promise<boolean> {
    const result = await this.#ledger.finalize(command, receipt);
    if (result) this.clearRuntime(command);
    return result;
  }

  async retire(command: Command): Promise<boolean> {
    const result = await this.#ledger.retire(command);
    if (result) this.clearRuntime(command);
    return result;
  }

  /** Release one automatic resume attempt while preserving its continuation ticket. */
  async retireAutomaticResumeAttempt(
    command: Command,
    releaseContinuationAttempt: () => Promise<boolean>
  ): Promise<boolean> {
    if (command.spec.type !== 'resume') return false;
    const result = await this.#ledger.retireAfterFence(command, releaseContinuationAttempt);
    if (result) this.clearRuntime(command);
    return result;
  }

  /** The continuation is already absent/aborted, so its resume transport is restart-inert. */
  async retireResumeTransportAfterAbort(command: Command): Promise<boolean> {
    if (command.spec.type !== 'resume') return false;
    const result = await this.#ledger.retireInert(command);
    if (result) this.clearRuntime(command);
    return result;
  }

  async holdForBroker(command: Command): Promise<boolean> {
    const result = await this.#ledger.holdForBroker(command);
    if (result) this.clearRuntime(command);
    return result;
  }

  releaseBrokerHold(id: string): Promise<boolean> { return this.#ledger.releaseBrokerHold(id); }

  async cancelWhere(predicate: (command: Command) => boolean): Promise<Command[]> {
    const cancelled = await this.#ledger.cancelWhere(predicate);
    for (const command of cancelled) this.clearRuntime(command);
    return cancelled;
  }

  async restore(
    commands: readonly Command[],
    receipts: readonly CommandReceipt[],
    snapshot: DurableCommandSnapshot
  ): Promise<boolean> {
    this.clearAllRuntime();
    return this.#ledger.restore(commands, receipts, snapshot);
  }

  offerPlacement(command: Command, placement: CommandPlacement): void {
    this.#runtimeFor(command).placement = placement;
  }

  takePlacement(command: Command): CommandPlacement | null {
    const runtime = this.#runtime.get(command.id);
    const placement = runtime?.placement ?? null;
    if (runtime) runtime.placement = null;
    this.#deleteEmptyRuntime(command.id);
    return placement;
  }

  placementFor(command: Command): CommandPlacement | null {
    return this.#runtime.get(command.id)?.placement ?? null;
  }

  armDeadline(command: Command, delay: number, expire: () => void | Promise<void>): void {
    const runtime = this.#runtimeFor(command);
    if (runtime.deadline) clearTimeout(runtime.deadline);
    runtime.deadline = setTimeout(() => {
      const current = this.#runtime.get(command.id);
      if (current) current.deadline = null;
      this.#deleteEmptyRuntime(command.id);
      // Node ignores this return value. Fake-timer validation can await it, which keeps tests at
      // the same publication boundary as production's already-started durable expiry cleanup.
      return expire();
    }, Math.max(1, delay));
    runtime.deadline.unref?.();
  }

  hasDeadline(command: Command): boolean {
    return this.#runtime.get(command.id)?.deadline != null;
  }

  clearDeadline(command: Command): void {
    const runtime = this.#runtime.get(command.id);
    if (!runtime) return;
    if (runtime.deadline) clearTimeout(runtime.deadline);
    runtime.deadline = null;
    this.#deleteEmptyRuntime(command.id);
  }

  clearRuntime(command: Command): void {
    const runtime = this.#runtime.get(command.id);
    if (runtime?.deadline) clearTimeout(runtime.deadline);
    this.#runtime.delete(command.id);
  }

  clearAllRuntime(): void {
    for (const runtime of this.#runtime.values()) if (runtime.deadline) clearTimeout(runtime.deadline);
    this.#runtime.clear();
  }

  resetForTests(): void {
    this.clearAllRuntime();
    this.#ledger.resetForTests();
  }

  #runtimeFor(command: Command): CommandRuntime {
    let runtime = this.#runtime.get(command.id);
    if (!runtime) {
      runtime = { deadline: null, placement: null };
      this.#runtime.set(command.id, runtime);
    }
    return runtime;
  }

  #deleteEmptyRuntime(id: string): void {
    const runtime = this.#runtime.get(id);
    if (runtime && !runtime.deadline && !runtime.placement) this.#runtime.delete(id);
  }
}
