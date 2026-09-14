import { randomBytes } from 'node:crypto';
import type { ReasoningEffort } from '../../shared/session.js';
import { writeDurableNow, writeDurableSoon } from '../durable.js';

export const COMMAND_TTL_MS = 30 * 60_000;
export const MAX_COMMANDS = 20;
export const MAX_COMMAND_RECEIPTS = 64;
export const COMMANDS_STATE = 'bridge-commands';

export type CommandSpec =
  | {
      readonly type: 'worker';
      readonly agent: string;
      readonly task: string;
      readonly model: string | null;
      readonly reasoningEffort: ReasoningEffort | null;
      readonly runId: string;
    }
  | {
      readonly type: 'revive';
      readonly agent: string;
      readonly conversationId: string;
      readonly runId: string;
      readonly wake: string;
    }
  | { readonly type: 'resume'; readonly sessionId: string; readonly token: string }
  | {
      readonly type: 'stop';
      readonly sessionId: string;
      readonly conversationId: string;
      readonly turnId: string;
      readonly userMessageId?: string;
    };

interface MutableCommand {
  id: string;
  spec: CommandSpec;
  createdAt: number;
  claimedAt: number | null;
  owner: string | null;
}

/** Read-only view outside the ledger; durable command mutation has one owner. */
export type Command = Readonly<MutableCommand>;

export type CommandPhase = 'queued' | 'leased';
export type CommandReceiptOutcome = 'committed' | 'terminal-failure';

export interface CommandReceipt {
  readonly id: string;
  readonly client: string | null;
  readonly conversationId: string | null;
  readonly outcome: CommandReceiptOutcome;
  readonly committed: boolean;
  readonly error: string | null;
  readonly completedAt: number;
}

export interface DurableCommandRecord {
  readonly id: string;
  readonly spec: CommandSpec;
  readonly createdAt: number;
  readonly phase: CommandPhase;
  readonly claimedAt: number | null;
  readonly owner: string | null;
}

export interface DurableCommandSnapshot {
  readonly version: 4;
  readonly commands: DurableCommandRecord[];
  readonly receipts: CommandReceipt[];
}

export type CommandAdmission =
  | { command: Command; overflow: null; changed: boolean }
  | { command: null; overflow: Command; changed: false };

export interface CommandIntent {
  /** Stable marker allocated synchronously when the broker says browser work is owed. */
  command: Command;
  /** Resolves only after this intent either crosses the command-ledger fsync or is displaced. */
  ready: Promise<CommandAdmission | null>;
}

interface StagedCommandIntent {
  command: MutableCommand;
  cancelled: boolean;
  ready: Promise<CommandAdmission | null>;
}

/** Logical replaceable transport slot. Same slot + different generation means supersession. */
export function commandSlotKey(spec: CommandSpec): string {
  if (spec.type === 'stop') return `stop:${spec.sessionId}:${spec.turnId}`;
  if (spec.type === 'worker') return `worker:${spec.runId}:${spec.agent}`;
  if (spec.type === 'revive') return `revive:${spec.runId}:${spec.agent}`;
  return `resume:${spec.sessionId}`;
}

/** Full semantic equality for one transport generation; never depend on object key order. */
function sameCommandGeneration(left: CommandSpec, right: CommandSpec): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'worker' && right.type === 'worker') {
    return left.agent === right.agent && left.task === right.task && left.model === right.model &&
      left.reasoningEffort === right.reasoningEffort && left.runId === right.runId;
  }
  if (left.type === 'revive' && right.type === 'revive') {
    return left.agent === right.agent && left.conversationId === right.conversationId &&
      left.runId === right.runId && left.wake === right.wake;
  }
  if (left.type === 'resume' && right.type === 'resume') {
    return left.sessionId === right.sessionId && left.token === right.token;
  }
  if (left.type === 'stop' && right.type === 'stop') {
    return left.sessionId === right.sessionId && left.conversationId === right.conversationId &&
      left.turnId === right.turnId && (left.userMessageId ?? null) === (right.userMessageId ?? null);
  }
  return false;
}

const commandPhase = (command: Command): CommandPhase => (command.claimedAt === null ? 'queued' : 'leased');

/** The ledger owns its command-spec objects just as it owns the surrounding command record. */
const ownCommandSpec = (spec: CommandSpec): CommandSpec => ({ ...spec });

export function durableCommand(command: Command): DurableCommandRecord {
  return {
    id: command.id,
    spec: ownCommandSpec(command.spec),
    createdAt: command.createdAt,
    phase: commandPhase(command),
    claimedAt: command.claimedAt,
    owner: command.owner
  };
}

/**
 * Single mutable owner for browser command custody.
 *
 * Browser opens remain independent side effects, but every durable command-ledger mutation is
 * admitted here in one total order. The ledger always persists the intended next snapshot before
 * publishing that mutation in memory. Cross-ledger transitions may temporarily move a command
 * from the live queue into `heldForBroker`: it remains in every durable command snapshot until
 * the separately durable broker transition has crossed its own fsync.
 */
export class BrowserCommandLedger {
  readonly #commands: MutableCommand[] = [];
  readonly #receipts: CommandReceipt[] = [];
  readonly #heldForBroker = new Map<string, MutableCommand>();
  /**
   * Broker intent that is observable synchronously but has not crossed command-ledger durability.
   *
   * These rows are deliberately absent from `commands`, snapshots, leasing and delivery. The
   * broker callback is synchronous by contract: once its own durable topology says a worker tab
   * is owed, callers must be able to observe that owed transport in the same tick. Browser
   * custody is a different authority boundary and begins only after `ready` has fsynced it.
   */
  readonly #intents = new Map<string, StagedCommandIntent>();
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  get commands(): readonly Command[] { return this.#commands; }
  get receipts(): readonly CommandReceipt[] { return this.#receipts.map((receipt) => ({ ...receipt })); }
  get busy(): boolean { return this.#pending > 0; }

  /** Synchronous projection for UI/tests: durable commands plus broker intent awaiting fsync. */
  pendingCommands(): readonly Command[] {
    const committedIds = new Set(this.#commands.map((command) => command.id));
    return [
      ...this.#commands,
      ...[...this.#intents.values()]
        .filter((intent) => !intent.cancelled && !committedIds.has(intent.command.id))
        .map((intent) => intent.command)
    ];
  }

  receiptFor(id: string, now = Date.now()): CommandReceipt | null {
    const receipt = this.#receipts.find((entry) => entry.id === id && now - entry.completedAt <= COMMAND_TTL_MS);
    return receipt ? { ...receipt } : null;
  }

  /**
   * Synchronously registers broker intent, then commits browser custody through the ledger lane.
   *
   * This is intentionally separate from `admit()`: ordinary callers can simply await admission,
   * while the broker needs same-tick observability without giving the browser pre-fsync access.
   */
  registerIntent(spec: CommandSpec): CommandIntent {
    const ownedSpec = ownCommandSpec(spec);
    const key = commandSlotKey(ownedSpec);
    const committed = this.#commands.find((command) => commandSlotKey(command.spec) === key);
    if (committed) {
      return {
        command: committed,
        ready: this.admit(ownedSpec)
      };
    }

    const staged = this.#intents.get(key);
    if (staged) {
      if (sameCommandGeneration(staged.command.spec, ownedSpec)) {
        return { command: staged.command, ready: staged.ready };
      }
      // Replace staged authority immediately. The older generation may already be fsyncing, but
      // it has no browser custody yet; its ledger operation sees that it lost this key and either
      // abstains or rewrites its transient row before the newer generation runs. Keeping the
      // newest generation in #intents is load-bearing for same-tick cancellation: chaining an
      // untracked admit behind the old promise could resurrect work after the broker withdrew it.
    }

    const command: MutableCommand = {
      id: randomBytes(8).toString('hex'),
      spec: ownedSpec,
      createdAt: Date.now(),
      claimedAt: null,
      owner: null
    };
    const intent: StagedCommandIntent = {
      command,
      cancelled: false,
      ready: Promise.resolve(null)
    };
    this.#intents.set(key, intent);
    intent.ready = this.#enqueue(() => this.#admitInLane(ownedSpec, intent));
    return { command, ready: intent.ready };
  }

  /** One crash-consistent admission transition shared by ordinary and same-tick broker paths. */
  async #admitInLane(spec: CommandSpec, intent?: StagedCommandIntent): Promise<CommandAdmission | null> {
    const key = commandSlotKey(spec);
    const intentCurrent = (): boolean => !intent || (!intent.cancelled && this.#intents.get(key) === intent);
    const forgetIntent = (): void => {
      if (intent && this.#intents.get(key) === intent) this.#intents.delete(key);
    };
    if (!intentCurrent()) return null;

    const existing = this.#commands.find((command) => commandSlotKey(command.spec) === key);
    if (existing) {
      if (sameCommandGeneration(existing.spec, spec)) {
        forgetIntent();
        return { command: existing, overflow: null, changed: false };
      }
      const createdAt = Date.now();
      const record: DurableCommandRecord = {
        ...durableCommand(existing),
        spec,
        createdAt,
        phase: 'queued',
        claimedAt: null,
        owner: null
      };
      try {
        await writeDurableNow(COMMANDS_STATE, this.snapshot({ commandOverride: { command: existing, record } }));
      } catch (error) {
        forgetIntent();
        this.#supersedeFailedWrite();
        throw error;
      }
      if (!intentCurrent()) {
        // A same-tick cancellation/supersession won while fsync was in flight. The live command
        // is still the pre-intent generation, so rewriting the current snapshot removes the
        // transient durable replacement without ever granting browser custody.
        try { await writeDurableNow(COMMANDS_STATE, this.snapshot()); }
        catch { writeDurableSoon(COMMANDS_STATE, this.snapshot()); }
        return null;
      }
      existing.spec = spec;
      existing.createdAt = createdAt;
      existing.claimedAt = null;
      existing.owner = null;
      forgetIntent();
      return { command: existing, overflow: null, changed: true };
    }

    if (this.#commands.length >= MAX_COMMANDS) {
      forgetIntent();
      return { command: null, overflow: this.#commands[0]!, changed: false };
    }
    const command = intent?.command ?? {
      id: randomBytes(8).toString('hex'),
      spec,
      createdAt: Date.now(),
      claimedAt: null,
      owner: null
    };
    try {
      await writeDurableNow(COMMANDS_STATE, this.snapshot({ addCommand: durableCommand(command) }));
    } catch (error) {
      forgetIntent();
      this.#supersedeFailedWrite();
      throw error;
    }
    if (!intentCurrent()) {
      try { await writeDurableNow(COMMANDS_STATE, this.snapshot()); }
      catch { writeDurableSoon(COMMANDS_STATE, this.snapshot()); }
      return null;
    }
    forgetIntent();
    this.#commands.push(command);
    return { command, overflow: null, changed: true };
  }

  /** Wait for a synchronously exposed intent before a browser request is allowed to use it. */
  async awaitCommand(id: string): Promise<Command | null> {
    const committed = this.#commands.find((command) => command.id === id);
    if (committed) return committed;
    const intent = [...this.#intents.values()].find((entry) => !entry.cancelled && entry.command.id === id);
    if (!intent) return null;
    const admission = await intent.ready;
    return admission?.command && this.#commands.includes(admission.command) ? admission.command : null;
  }

  /** Same-tick withdrawal of broker intent that has not crossed browser-command durability yet. */
  cancelIntentsWhere(predicate: (command: Command) => boolean): Command[] {
    const cancelled: Command[] = [];
    for (const [key, intent] of this.#intents) {
      if (intent.cancelled || !predicate(intent.command)) continue;
      intent.cancelled = true;
      this.#intents.delete(key);
      cancelled.push(intent.command);
    }
    return cancelled;
  }

  snapshot(options: {
    commandOverride?: { command: Command; record: DurableCommandRecord };
    removeCommandIds?: ReadonlySet<string>;
    addCommand?: DurableCommandRecord;
    addReceipt?: CommandReceipt;
  } = {}): DurableCommandSnapshot {
    const { commandOverride, removeCommandIds, addCommand, addReceipt } = options;
    const now = Date.now();
    const liveAndHeld = [
      ...this.#commands,
      ...[...this.#heldForBroker.values()].filter(
        (held) => !this.#commands.some((command) => command.id === held.id)
      )
    ];
    const records = liveAndHeld
      .filter((command) => !removeCommandIds?.has(command.id))
      .map((command) => commandOverride?.command === command ? commandOverride.record : durableCommand(command));
    if (addCommand && !removeCommandIds?.has(addCommand.id) && !records.some((record) => record.id === addCommand.id)) {
      records.push(addCommand);
    }
    let receipts = this.#receipts
      .filter((receipt) => now - receipt.completedAt <= COMMAND_TTL_MS)
      .map((receipt) => ({ ...receipt }));
    if (addReceipt) receipts = [...receipts.filter((receipt) => receipt.id !== addReceipt.id), { ...addReceipt }];
    return { version: 4, commands: records, receipts: receipts.slice(-MAX_COMMAND_RECEIPTS) };
  }

  /**
   * Queue a command mutation behind every older mutation, regardless of success or failure.
   *
   * The lane is intentionally non-reentrant: work running inside it may synchronously enqueue
   * follow-up ledger work, but must not await that follow-up before returning. Installing this
   * operation's completion marker before invoking an idle callback makes that rule mechanical —
   * nested admissions always queue behind the operation that caused them.
   */
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const idle = this.#pending === 0;
    this.#pending += 1;
    const previous = this.#tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    // Publish the current lane marker before invoking caller-controlled work. An idle callback can
    // therefore start in this tick without giving a synchronous nested mutation the old tail.
    this.#tail = current;
    // Start an idle ledger operation in this tick. Besides avoiding needless latency, this is a
    // durability contract: a caller that registers broker intent and immediately asks the shared
    // durable store to flush must find this write already registered with that store. Once any
    // operation is active, later mutations serialize behind the marker installed above.
    const invoke = (): Promise<T> => {
      try { return operation(); }
      catch (error) { return Promise.reject(error); }
    };
    const run = idle ? invoke() : previous.then(invoke, invoke);
    return run.finally(() => {
      this.#pending -= 1;
      release();
    });
  }

  /** Wait until every ledger mutation accepted so far has reached its publication decision. */
  async drain(): Promise<void> {
    await this.#tail;
  }

  #supersedeFailedWrite(): void {
    // durable.ts deliberately retains a failed generation for retry. A rejected staged mutation
    // is no longer authoritative, so immediately supersede that generation with the ledger's
    // still-authoritative live snapshot.
    writeDurableSoon(COMMANDS_STATE, this.snapshot());
  }

  async admit(spec: CommandSpec): Promise<CommandAdmission> {
    const ownedSpec = ownCommandSpec(spec);
    return this.#enqueue(() => this.#admitInLane(ownedSpec) as Promise<CommandAdmission>);
  }

  async lease(command: Command, owner: string | null, claimedAt: number, allowOwnerTakeover = false): Promise<boolean> {
    return this.#enqueue(async () => {
      const live = this.#mutable(command);
      if (!live) return false;
      if (owner !== null && live.owner !== null && live.owner !== owner && !allowOwnerTakeover) return false;
      const record: DurableCommandRecord = {
        ...durableCommand(live),
        phase: 'leased',
        claimedAt,
        owner
      };
      try {
        await writeDurableNow(COMMANDS_STATE, this.snapshot({ commandOverride: { command: live, record } }));
      } catch (error) {
        this.#supersedeFailedWrite();
        throw error;
      }
      if (!this.#commands.includes(live)) return false;
      live.claimedAt = claimedAt;
      live.owner = owner;
      return true;
    });
  }

  /**
   * Coordinator-only serialization primitive for an ownership-sensitive cross-ledger checkpoint.
   * `operation` runs inside the non-reentrant ledger lane and must not await another ledger mutation.
   */
  async runExclusiveOwned<T>(
    command: Command,
    owner: string,
    current: () => boolean,
    operation: () => Promise<T>
  ): Promise<T | null> {
    return this.#enqueue(async () => {
      const live = this.#mutable(command);
      if (!live || live.owner !== owner || !current()) return null;
      return operation();
    });
  }

  async finalize(command: Command, receipt: CommandReceipt): Promise<boolean> {
    return this.#enqueue(async () => {
      const live = this.#mutable(command);
      if (!live) return this.receiptFor(receipt.id) !== null;
      const remove = new Set([live.id]);
      try {
        await writeDurableNow(COMMANDS_STATE, this.snapshot({ removeCommandIds: remove, addReceipt: receipt }));
      } catch (error) {
        this.#supersedeFailedWrite();
        throw error;
      }
      this.#removeLive(live);
      const prior = this.#receipts.findIndex((entry) => entry.id === receipt.id);
      if (prior >= 0) this.#receipts.splice(prior, 1);
      this.#receipts.push({ ...receipt });
      if (this.#receipts.length > MAX_COMMAND_RECEIPTS) this.#receipts.splice(0, this.#receipts.length - MAX_COMMAND_RECEIPTS);
      return true;
    });
  }

  async retire(command: Command): Promise<boolean> {
    return this.#enqueue(async () => {
      const live = this.#mutable(command);
      if (!live) return false;
      try {
        await writeDurableNow(COMMANDS_STATE, this.snapshot({ removeCommandIds: new Set([live.id]) }));
      } catch (error) {
        this.#supersedeFailedWrite();
        throw error;
      }
      this.#removeLive(live);
      return true;
    });
  }

  /**
   * Coordinator-only primitive: cross an external durable fence, then retire in the same lane.
   * `beforeRetire` runs inside the non-reentrant ledger lane and must not await another ledger mutation.
   */
  async retireAfterFence(command: Command, beforeRetire: () => Promise<boolean>): Promise<boolean> {
    return this.#enqueue(async () => {
      const live = this.#mutable(command);
      if (!live) return false;
      if (!await beforeRetire()) return false;
      try {
        await writeDurableNow(COMMANDS_STATE, this.snapshot({ removeCommandIds: new Set([live.id]) }));
      } catch (error) {
        this.#supersedeFailedWrite();
        throw error;
      }
      this.#removeLive(live);
      return true;
    });
  }

  /**
   * Retire transport after another durable authority already made replay inert.
   * If this ledger write fails, the old disk row is safe on restart because restore consults
   * that external authority. The failed target snapshot is kept for durable.ts retry while live
   * custody is removed immediately.
   */
  async retireInert(command: Command): Promise<boolean> {
    return this.#enqueue(async () => {
      const live = this.#mutable(command);
      if (!live) return false;
      const target = this.snapshot({ removeCommandIds: new Set([live.id]) });
      try {
        await writeDurableNow(COMMANDS_STATE, target);
      } catch {
        writeDurableSoon(COMMANDS_STATE, target);
      }
      this.#removeLive(live);
      return true;
    });
  }

  /** Remove from live delivery while retaining the old durable row until broker fsync succeeds. */
  async holdForBroker(command: Command): Promise<boolean> {
    return this.#enqueue(async () => {
      const live = this.#mutable(command);
      if (!live) return false;
      this.#heldForBroker.set(live.id, live);
      this.#removeLive(live);
      return true;
    });
  }

  /** The broker side is durable; command retirement may now cross its own durable boundary. */
  async releaseBrokerHold(id: string): Promise<boolean> {
    return this.#enqueue(async () => {
      const held = this.#heldForBroker.get(id);
      if (!held) return false;
      const target = this.snapshot({ removeCommandIds: new Set([id]) });
      try {
        await writeDurableNow(COMMANDS_STATE, target);
      } catch {
        // The separately durable broker state already makes this transport inert on restart.
        // Preserve the exact removal generation for retry rather than superseding it with the
        // stale held row; keeping that row in memory would only make every later snapshot carry
        // dead custody until the process happens to restart.
        writeDurableSoon(COMMANDS_STATE, target);
      }
      this.#heldForBroker.delete(id);
      return true;
    });
  }

  async cancelWhere(predicate: (command: Command) => boolean): Promise<Command[]> {
    return this.#enqueue(async () => {
      const doomed = this.#commands.filter(predicate);
      if (doomed.length === 0) return [];
      const ids = new Set(doomed.map((command) => command.id));
      try {
        await writeDurableNow(COMMANDS_STATE, this.snapshot({ removeCommandIds: ids }));
      } catch (error) {
        this.#supersedeFailedWrite();
        throw error;
      }
      for (const command of doomed) this.#removeLive(command);
      return doomed;
    });
  }

  /**
   * Replace live custody with a fully reconstructed startup plan.
   *
   * Recovery is allowed to publish after a failed rewrite because the old disk generation is
   * itself safe and startup remains fenced from browser admission until this returns. Preserve
   * the exact reconstructed generation for durable.ts retry rather than serializing globals that
   * are about to be published.
   */
  async restore(
    commands: readonly Command[],
    receipts: readonly CommandReceipt[],
    snapshot: DurableCommandSnapshot
  ): Promise<boolean> {
    return this.#enqueue(async () => {
      let persisted = true;
      try {
        await writeDurableNow(COMMANDS_STATE, snapshot);
      } catch {
        persisted = false;
        writeDurableSoon(COMMANDS_STATE, snapshot);
      }
      this.#commands.splice(0, this.#commands.length, ...commands.map(command => ({ ...command, spec: ownCommandSpec(command.spec) })));
      this.#receipts.splice(0, this.#receipts.length, ...receipts.slice(-MAX_COMMAND_RECEIPTS).map(receipt => ({ ...receipt })));
      this.#heldForBroker.clear();
      return persisted;
    });
  }

  resetForTests(): void {
    this.#commands.splice(0);
    this.#receipts.splice(0);
    this.#heldForBroker.clear();
    this.#intents.clear();
    this.#tail = Promise.resolve();
    this.#pending = 0;
  }

  #mutable(command: Command): MutableCommand | null {
    return this.#commands.find((entry) => entry === command) ?? null;
  }

  #removeLive(command: MutableCommand): void {
    const index = this.#commands.indexOf(command);
    if (index >= 0) this.#commands.splice(index, 1);
  }
}
