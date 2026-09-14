import { describe, expect, it } from 'vitest';
import { projectTurnEnd, projectTurnReopen, projectTurnStart, type TurnLifecycleProjection } from '../src/main/session/turn-lifecycle.js';

const state = (): TurnLifecycleProjection => ({
  turnStartedAt: null,
  turnId: null,
  openTurns: new Set(),
  knownTurnStarts: new Set(),
  knownTurnEnds: new Set(),
  lastTurnOutcome: null,
  lastTurnStartedAt: null,
  turnRequestIds: new Set(),
  endedTurn: null
});

describe('turn lifecycle projection', () => {
  it('lets a stale end become durable history without tearing down a newer active turn', () => {
    const live = state();
    projectTurnStart(live, 'turn-new', 200);
    live.turnRequestIds.add('request-new');

    expect(projectTurnEnd(live, 'turn-old', 'completed', 300)).toEqual({ current: false, startedAt: null });
    expect(live.turnId).toBe('turn-new');
    expect(live.turnStartedAt).toBe(200);
    expect(live.turnRequestIds).toEqual(new Set(['request-new']));
    expect(live.lastTurnOutcome).toBeNull();
    expect(live.knownTurnEnds.has('turn-old')).toBe(true);
  });

  it('reopens the same logical turn while preserving exact request evidence when supplied', () => {
    const live = state();
    projectTurnStart(live, 'turn-one', 100);
    live.turnRequestIds.add('request-one');
    projectTurnEnd(live, 'turn-one', 'completed', 150);
    projectTurnReopen(live, 'turn-one', 100, new Set(['request-one']));

    expect(live.turnId).toBe('turn-one');
    expect(live.turnStartedAt).toBe(100);
    expect(live.knownTurnEnds.has('turn-one')).toBe(false);
    expect(live.openTurns.has('turn-one')).toBe(true);
    expect(live.turnRequestIds).toEqual(new Set(['request-one']));
  });
});
