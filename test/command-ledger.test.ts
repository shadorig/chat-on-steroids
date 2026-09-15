import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';

import {
  BrowserCommandLedger,
  COMMANDS_STATE,
  type DurableCommandSnapshot
} from '../src/main/browser-bridge/command-ledger.js';
import { BrowserCommandCoordinator } from '../src/main/browser-bridge/command-coordinator.js';
import { flushDurable, initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import { faultGate, makeTempDir, removeTempDir } from './helpers.js';

let directory: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  resetDurableForTests();
  if (directory) await removeTempDir(directory);
  directory = null;
});

describe('browser command ledger', () => {
  it('exposes broker intent synchronously but withholds browser custody until its fsync commits', async () => {
    directory = await makeTempDir('clf-command-intent-');
    initDurableStore(directory);
    const ledger = new BrowserCommandLedger();
    const gate = faultGate();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      await gate.hold();
      return realRename(...args);
    });

    const intent = ledger.registerIntent({
      type: 'worker', agent: 'worker-1', task: 'inspect the fixture', model: null, reasoningEffort: null, runId: 'run-one'
    });
    expect(ledger.pendingCommands()).toEqual([intent.command]);
    expect(ledger.commands).toEqual([]);
    await gate.entered;

    let handedOut = false;
    const handout = ledger.awaitCommand(intent.command.id).then((command) => {
      handedOut = true;
      return command;
    });
    await Promise.resolve();
    expect(handedOut).toBe(false);
    expect(ledger.commands).toEqual([]);

    gate.release();
    expect(await handout).toBe(intent.command);
    expect(ledger.commands).toEqual([intent.command]);
    const durable = await readDurable<DurableCommandSnapshot>(COMMANDS_STATE);
    expect(durable?.version).toBe(5);
    expect(durable?.commands).toEqual([expect.objectContaining({ id: intent.command.id })]);
  });

  it('withdraws staged broker intent in the same tick and never publishes it after an in-flight fsync', async () => {
    directory = await makeTempDir('clf-command-intent-cancel-');
    initDurableStore(directory);
    const ledger = new BrowserCommandLedger();
    const gate = faultGate();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      await gate.hold();
      return realRename(...args);
    });

    const intent = ledger.registerIntent({
      type: 'worker', agent: 'worker-1', task: 'work that was cancelled', model: null, reasoningEffort: null, runId: 'run-cancelled'
    });
    await gate.entered;
    expect(ledger.pendingCommands()).toHaveLength(1);

    expect(ledger.cancelIntentsWhere((command) => command.id === intent.command.id)).toEqual([intent.command]);
    expect(ledger.pendingCommands()).toEqual([]);
    expect(ledger.commands).toEqual([]);

    gate.release();
    expect(await intent.ready).toBeNull();
    expect(ledger.commands).toEqual([]);
    const durable = await readDurable<DurableCommandSnapshot>(COMMANDS_STATE);
    expect(durable?.commands ?? []).toEqual([]);
  });

  it('keeps a superseding same-key intent cancellable while the older generation is still fsyncing', async () => {
    directory = await makeTempDir('clf-command-intent-supersede-cancel-');
    initDurableStore(directory);
    const ledger = new BrowserCommandLedger();
    const gate = faultGate();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      await gate.hold();
      return realRename(...args);
    });

    const first = ledger.registerIntent({
      type: 'revive', agent: 'worker-1', conversationId: 'chat-one', runId: 'run-one', wake: 'first wake'
    });
    await gate.entered;
    const second = ledger.registerIntent({
      type: 'revive', agent: 'worker-1', conversationId: 'chat-one', runId: 'run-one', wake: 'newer wake'
    });

    expect(ledger.pendingCommands()).toEqual([second.command]);
    expect(second.command).not.toBe(first.command);
    expect(ledger.cancelIntentsWhere((command) => command.spec.type === 'revive' && command.spec.runId === 'run-one'))
      .toEqual([second.command]);

    gate.release();
    expect(await first.ready).toBeNull();
    expect(await second.ready).toBeNull();
    expect(ledger.commands).toEqual([]);
    const durable = await readDurable<DurableCommandSnapshot>(COMMANDS_STATE);
    expect(durable?.commands ?? []).toEqual([]);
  });

  it('publishes only the newest same-key staged generation', async () => {
    directory = await makeTempDir('clf-command-intent-supersede-');
    initDurableStore(directory);
    const ledger = new BrowserCommandLedger();
    const gate = faultGate();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      await gate.hold();
      return realRename(...args);
    });

    const first = ledger.registerIntent({
      type: 'revive', agent: 'worker-1', conversationId: 'chat-one', runId: 'run-one', wake: 'first wake'
    });
    await gate.entered;
    const second = ledger.registerIntent({
      type: 'revive', agent: 'worker-1', conversationId: 'chat-one', runId: 'run-one', wake: 'newer wake'
    });

    gate.release();
    expect(await first.ready).toBeNull();
    expect((await second.ready)?.command).toBe(second.command);
    expect(ledger.commands).toEqual([second.command]);
    const durable = await readDurable<DurableCommandSnapshot>(COMMANDS_STATE);
    expect(durable?.commands).toEqual([
      expect.objectContaining({
        id: second.command.id,
        spec: expect.objectContaining({ type: 'revive', wake: 'newer wake' })
      })
    ]);
  });

  it('deduplicates a logically identical spec regardless of object property order', async () => {
    directory = await makeTempDir('clf-command-spec-equality-');
    initDurableStore(directory);
    const ledger = new BrowserCommandLedger();
    const first = await ledger.admit({
      type: 'worker', agent: 'worker-1', task: 'same work', model: null, reasoningEffort: 'high', runId: 'run-one'
    });
    const reordered = {
      runId: 'run-one', reasoningEffort: 'high' as const, model: null, task: 'same work', agent: 'worker-1', type: 'worker' as const
    };

    const second = await ledger.admit(reordered);
    expect(second).toMatchObject({ command: first.command, changed: false, overflow: null });
    expect(ledger.commands).toEqual([first.command]);
  });

  it('owns admitted specs and stored receipts instead of retaining caller-mutable objects', async () => {
    directory = await makeTempDir('clf-command-owned-records-');
    initDurableStore(directory);
    const ledger = new BrowserCommandLedger();
    const spec: {
      type: 'revive'; agent: string; conversationId: string; runId: string; wake: string;
    } = { type: 'revive', agent: 'worker-1', conversationId: 'chat-one', runId: 'run-one', wake: 'first wake' };
    const command = (await ledger.admit(spec)).command!;

    spec.wake = 'mutated after admission';
    expect(command.spec).toMatchObject({ type: 'revive', wake: 'first wake' });
    expect(ledger.snapshot().commands[0]?.spec).toMatchObject({ type: 'revive', wake: 'first wake' });

    const receipt = {
      id: command.id,
      client: 'page-one',
      conversationId: 'chat-one',
      outcome: 'committed' as const,
      committed: true,
      error: null as string | null,
      completedAt: Date.now()
    };
    expect(await ledger.finalize(command, receipt)).toBe(true);
    receipt.error = 'mutated after finalize';
    expect(ledger.receiptFor(command.id)?.error).toBeNull();
  });

  it('serializes retirement before a concurrent admission in memory and on disk', async () => {
    directory = await makeTempDir('clf-command-ledger-');
    initDurableStore(directory);
    const ledger = new BrowserCommandLedger();
    const first = (await ledger.admit({ type: 'resume', sessionId: 'session-first', token: 'token-first' })).command!;

    const gate = faultGate();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      await gate.hold();
      return realRename(...args);
    });

    const retiring = ledger.retire(first);
    await gate.entered;
    const admitting = ledger.admit({ type: 'resume', sessionId: 'session-second', token: 'token-second' });

    // Neither half may publish while the older durable transition is unresolved.
    expect(ledger.commands.map(command => command.spec.type === 'resume' ? command.spec.sessionId : command.id)).toEqual(['session-first']);
    let admitted = false;
    void admitting.then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);

    gate.release();
    expect(await retiring).toBe(true);
    const second = (await admitting).command!;
    expect(ledger.commands).toEqual([second]);

    const durable = await readDurable<DurableCommandSnapshot>(COMMANDS_STATE);
    expect(durable?.commands).toHaveLength(1);
    expect(durable?.commands[0]).toMatchObject({
      id: second.id,
      spec: { type: 'resume', sessionId: 'session-second', token: 'token-second' }
    });
  });

  it('publishes the idle lane marker before a callback can synchronously admit follow-up work', async () => {
    directory = await makeTempDir('clf-command-ledger-reentry-');
    initDurableStore(directory);
    const ledger = new BrowserCommandLedger();
    const first = (await ledger.admit({ type: 'resume', sessionId: 'session-first', token: 'token-first' })).command!;
    expect(await ledger.lease(first, 'page-one', Date.now())).toBe(true);

    const durable = await import('../src/main/durable.js');
    const write = durable.writeDurableNow;
    let nestedWriteStarted = false;
    const writeSpy = vi.spyOn(durable, 'writeDurableNow').mockImplementation(async (name, value) => {
      nestedWriteStarted = true;
      return write(name, value);
    });
    const gate = faultGate();
    let nested!: ReturnType<typeof ledger.admit>;
    const outer = ledger.runExclusiveOwned(first, 'page-one', () => true, async () => {
      nested = ledger.admit({ type: 'resume', sessionId: 'session-second', token: 'token-second' });
      await gate.hold();
      return 'outer-complete';
    });
    await gate.entered;

    await Promise.resolve();
    expect(nestedWriteStarted).toBe(false);
    expect(ledger.commands).toEqual([first]);

    gate.release();
    await expect(outer).resolves.toBe('outer-complete');
    const second = (await nested).command!;
    expect(ledger.commands).toEqual([first, second]);
    expect(nestedWriteStarted).toBe(true);
    writeSpy.mockRestore();
  });

  it('keeps broker-fenced retirement authoritative when its command-ledger delete needs a retry', async () => {
    directory = await makeTempDir('clf-command-broker-release-retry-');
    initDurableStore(directory);
    const ledger = new BrowserCommandLedger();
    const command = (await ledger.admit({
      type: 'worker', agent: 'worker-1', task: 'already failed durably in the broker',
      model: null, reasoningEffort: null, runId: 'run-one'
    })).command!;
    expect(await ledger.holdForBroker(command)).toBe(true);

    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('transient command-ledger failure'));
    await expect(ledger.releaseBrokerHold(command.id)).resolves.toBe(true);
    expect(ledger.snapshot().commands).toEqual([]);

    rename.mockRestore();
    await flushDurable();
    const durable = await readDurable<DurableCommandSnapshot>(COMMANDS_STATE);
    expect(durable?.commands ?? []).toEqual([]);
  });
});

describe('browser command coordinator', () => {
  it('drops process-local placement and deadline state when a durable command generation is replaced', async () => {
    directory = await makeTempDir('clf-command-coordinator-');
    initDurableStore(directory);
    const coordinator = new BrowserCommandCoordinator();
    const first = (await coordinator.admit({
      type: 'revive', agent: 'worker-1', conversationId: 'chat-one', runId: 'run-one', wake: 'first wake'
    })).command!;
    coordinator.offerPlacement(first, { conversationId: 'chat-one', background: false });
    coordinator.armDeadline(first, 60_000, () => undefined);
    expect(coordinator.placementFor(first)).toEqual({ conversationId: 'chat-one', background: false });
    expect(coordinator.hasDeadline(first)).toBe(true);

    const replaced = await coordinator.admit({
      type: 'revive', agent: 'worker-1', conversationId: 'chat-one', runId: 'run-one', wake: 'newer wake'
    });
    expect(replaced).toMatchObject({ command: first, changed: true });
    expect(coordinator.placementFor(first)).toBeNull();
    expect(coordinator.hasDeadline(first)).toBe(false);
  });
});
