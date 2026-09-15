import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';
import {
  activeTurn,
  addActiveRequestId,
  damageTurnLineage,
  emptyTurnLifecycleProjection,
  lastTurn,
  mergeOpeningIdentity,
  openingIdentity,
  projectTurnEnd,
  projectTurnIdentity,
  projectTurnStart,
  reduceTurnLifecycleEvent,
  turnRecord,
  turnStartDisposition
} from '../src/main/session/turn-lifecycle.js';

describe('turn lifecycle projection', () => {
  it('lets a stale end become durable history without tearing down a newer active turn', () => {
    const live = emptyTurnLifecycleProjection();
    projectTurnStart(live, 'turn-new', 200, 'question-new');
    addActiveRequestId(live, 'request-new');

    expect(projectTurnEnd(live, 'turn-old', 'completed', 300)).toEqual({
      current: false,
      logicalStartedAt: null,
      segmentStartedAt: null
    });
    expect(activeTurn(live)).toMatchObject({ id: 'turn-new', logicalStartedAt: 200 });
    expect(activeTurn(live)!.requestIds).toEqual(new Set(['request-new']));
    expect(lastTurn(live)).toBeNull();
    expect(turnRecord(live, 'turn-old')?.phase).toBe('ended');
  });

  it('reopens the same logical turn while preserving opening and request evidence', () => {
    const live = emptyTurnLifecycleProjection();
    projectTurnStart(live, 'turn-one', 100, 'question-one');
    addActiveRequestId(live, 'request-one');
    projectTurnEnd(live, 'turn-one', 'completed', 150);
    reduceTurnLifecycleEvent(live, {
      seq: 3,
      source: 'app',
      time: 160,
      kind: 'turn_start',
      turnId: 'turn-one',
      openingUserMessageId: 'question-one'
    });

    expect(activeTurn(live)).toMatchObject({
      id: 'turn-one',
      logicalStartedAt: 100,
      segmentStartedAt: 160,
      opening: { status: 'exact', messageId: 'question-one' }
    });
    expect(turnRecord(live, 'turn-one')?.phase).toBe('unclosed');
    expect(activeTurn(live)!.requestIds).toEqual(new Set(['request-one']));
    expect(lastTurn(live)).toBeNull();
    expect(live.reopenCandidate).toBeNull();
  });

  it('advances one monotonic terminal epoch per current end and never rewinds it on reopen', () => {
    const live = emptyTurnLifecycleProjection();
    projectTurnStart(live, 'turn-a', 100, 'question-a');
    expect(live.terminalRevision).toBe(0);

    projectTurnEnd(live, 'turn-a', 'completed', 150);
    expect(live.terminalRevision).toBe(1);
    reduceTurnLifecycleEvent(live, {
      seq: 3,
      source: 'app',
      time: 175,
      kind: 'turn_start',
      turnId: 'turn-a',
      openingUserMessageId: 'question-a'
    });
    expect(live.terminalRevision).toBe(1);

    projectTurnEnd(live, 'turn-a', 'completed', 200);
    expect(live.terminalRevision).toBe(2);
    projectTurnStart(live, 'turn-b', 250, 'question-b');
    projectTurnEnd(live, 'turn-a', 'completed', 300);
    expect(live.terminalRevision).toBe(2);
    expect(activeTurn(live)?.id).toBe('turn-b');
  });

  it('never borrows an opening identity from a different last turn', () => {
    const live = emptyTurnLifecycleProjection();
    projectTurnStart(live, 'turn-one', 100, 'question-one');
    projectTurnEnd(live, 'turn-one', 'failed', 150);

    reduceTurnLifecycleEvent(live, {
      seq: 3,
      source: 'app',
      time: 200,
      kind: 'turn_start',
      turnId: 'turn-two'
    });

    expect(activeTurn(live)?.id).toBe('turn-two');
    expect(activeTurn(live)!.opening).toEqual({ status: 'unknown' });
  });

  it('represents contradictory immutable openings as conflict instead of latest-wins', () => {
    const exact = openingIdentity('question-a');
    expect(mergeOpeningIdentity(exact, 'question-a')).toEqual(exact);
    expect(mergeOpeningIdentity(exact, 'question-b')).toEqual({ status: 'conflict' });
    expect(mergeOpeningIdentity({ status: 'conflict' }, 'question-a')).toEqual({ status: 'conflict' });
  });

  it('classifies exact lifecycle replay separately from immutable opening conflict', () => {
    const live = emptyTurnLifecycleProjection();
    projectTurnStart(live, 'turn-one', 100, 'question-a');

    expect(turnStartDisposition(live, 'turn-one', 'question-a')).toBe('replay');
    expect(turnStartDisposition(live, 'turn-one', 'question-b')).toBe('conflict');
    projectTurnIdentity(live, 'turn-one', 'question-b');
    expect(turnRecord(live, 'turn-one')?.opening).toEqual({ status: 'conflict' });
    expect(activeTurn(live)?.opening).toEqual({ status: 'conflict' });
  });

  it('persists newly exact opening evidence without reopening an already ended turn', () => {
    const live = emptyTurnLifecycleProjection();
    projectTurnStart(live, 'legacy-turn', 100, null);
    projectTurnEnd(live, 'legacy-turn', 'completed', 150);

    expect(turnStartDisposition(live, 'legacy-turn', 'question-late')).toBe('identity-update');
    projectTurnIdentity(live, 'legacy-turn', 'question-late');
    expect(turnRecord(live, 'legacy-turn')).toMatchObject({
      opening: { status: 'exact', messageId: 'question-late' },
      phase: 'ended',
      outcome: 'completed'
    });
    expect(activeTurn(live)).toBeNull();
  });

  it('keeps known lineage damage distinct from missing opening identity', () => {
    const live = emptyTurnLifecycleProjection();
    projectTurnStart(live, 'turn-one', 100, null);
    damageTurnLineage(live, 'turn-one');
    projectTurnIdentity(live, 'turn-one', 'question-one');

    expect(turnRecord(live, 'turn-one')).toMatchObject({
      opening: { status: 'exact', messageId: 'question-one' },
      integrity: 'damaged'
    });
  });

  it('retains scoped damage that arrives before the first surviving lifecycle row', () => {
    const live = emptyTurnLifecycleProjection();
    reduceTurnLifecycleEvent(live, {
      seq: 1,
      time: 100,
      source: 'extension',
      kind: 'recording_gap',
      reason: 'worker_journal_overflow',
      affectedTurnId: 'missing-start-turn',
      lostKinds: { turn_start: 1 }
    });
    reduceTurnLifecycleEvent(live, {
      seq: 2,
      time: 120,
      source: 'extension',
      kind: 'turn_end',
      turnId: 'missing-start-turn',
      outcome: 'failed'
    });

    expect(turnRecord(live, 'missing-start-turn')).toMatchObject({
      phase: 'ended',
      integrity: 'damaged'
    });
  });

  it('never heals one logical lineage when the same id is reopened after known damage', () => {
    const live = emptyTurnLifecycleProjection();
    projectTurnStart(live, 'damaged-reopen', 100, 'question-one');
    damageTurnLineage(live, 'damaged-reopen');
    projectTurnEnd(live, 'damaged-reopen', 'failed', 120);
    projectTurnStart(live, 'damaged-reopen', 130, 'question-one');

    expect(activeTurn(live)).toMatchObject({
      id: 'damaged-reopen',
      logicalStartedAt: 100,
      segmentStartedAt: 130,
      integrity: 'damaged'
    });
  });

  it('does not turn exactly classified metadata loss into lifecycle damage', () => {
    const live = emptyTurnLifecycleProjection();
    projectTurnStart(live, 'metadata-loss-turn', 100, 'question-one');
    reduceTurnLifecycleEvent(live, {
      seq: 2,
      time: 110,
      source: 'extension',
      kind: 'recording_gap',
      reason: 'page_queue_overflow',
      lostKinds: { model_selection: 1, conversation_title: 1 }
    });

    expect(activeTurn(live)?.integrity).toBe('intact');
  });

  it('replays the same durable lifecycle events to the same projection', () => {
    const events: SessionEvent[] = [
      { seq: 1, time: 100, source: 'extension', kind: 'turn_start', turnId: 'turn-one' },
      { seq: 2, time: 110, source: 'extension', kind: 'turn_identity', turnId: 'turn-one', openingUserMessageId: 'question-one' },
      { seq: 3, time: 120, source: 'extension', kind: 'turn_end', turnId: 'turn-one', outcome: 'completed' },
      { seq: 4, time: 130, source: 'app', kind: 'turn_start', turnId: 'turn-one', openingUserMessageId: 'question-one', detail: 'corrective reopen' },
      { seq: 5, time: 140, source: 'extension', kind: 'recording_gap', reason: 'worker_journal_overflow',
        affectedTurnId: 'turn-one', lostKinds: { turn_end: 1 } }
    ];
    const live = emptyTurnLifecycleProjection();
    const replay = emptyTurnLifecycleProjection();
    for (const event of events) reduceTurnLifecycleEvent(live, event);
    for (const event of events) reduceTurnLifecycleEvent(replay, event);

    const snapshot = (state: typeof live) => ({
      turns: [...state.turnsById],
      activeTurnId: state.activeTurnId,
      lastTerminalTurnId: state.lastTerminalTurnId,
      terminalRevision: state.terminalRevision
    });
    expect(snapshot(replay)).toEqual(snapshot(live));
    expect(turnRecord(replay, 'turn-one')?.integrity).toBe('damaged');
  });
});
