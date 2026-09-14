import type { TurnOutcome } from '../../shared/session.js';

export interface EndedTurnProjection {
  turnId: string;
  startedAt: number | null;
  endedAt: number;
  requestIds: Set<string>;
}

/** Mutable in-memory projection of lifecycle facts that are already durable in the session log. */
export interface TurnLifecycleProjection {
  turnStartedAt: number | null;
  turnId: string | null;
  openTurns: Set<string>;
  knownTurnStarts: Set<string>;
  knownTurnEnds: Set<string>;
  lastTurnOutcome: TurnOutcome | null;
  lastTurnStartedAt: number | null;
  turnRequestIds: Set<string>;
  endedTurn: EndedTurnProjection | null;
}

/** Publish a newly committed page-authored start. */
export function projectTurnStart(state: TurnLifecycleProjection, turnId: string, startedAt: number): void {
  state.knownTurnStarts.add(turnId);
  state.turnStartedAt = startedAt;
  state.turnId = turnId;
  state.openTurns.add(turnId);
  state.turnRequestIds = new Set<string>();
  state.endedTurn = null;
}

/** Publish a committed corrective reopen of the same logical turn. */
export function projectTurnReopen(
  state: TurnLifecycleProjection,
  turnId: string,
  startedAt: number,
  requestIds?: ReadonlySet<string>
): void {
  state.knownTurnEnds.delete(turnId);
  state.openTurns.add(turnId);
  state.turnId = turnId;
  state.turnStartedAt = startedAt;
  state.lastTurnOutcome = null;
  state.endedTurn = null;
  if (requestIds) state.turnRequestIds = new Set(requestIds);
}

export interface ProjectedTurnEnd {
  current: boolean;
  startedAt: number | null;
}

/**
 * Publish a committed end. A stale end remains durable/idempotent history but cannot mutate a
 * newer active generation's current-turn fields or request-id evidence.
 */
export function projectTurnEnd(
  state: TurnLifecycleProjection,
  turnId: string,
  outcome: TurnOutcome,
  endedAt: number
): ProjectedTurnEnd {
  state.knownTurnEnds.add(turnId);
  state.openTurns.delete(turnId);
  if (state.turnId !== turnId) return { current: false, startedAt: null };

  const startedAt = state.turnStartedAt;
  state.lastTurnOutcome = outcome;
  state.lastTurnStartedAt = startedAt;
  state.endedTurn = outcome === 'completed'
    ? { turnId, startedAt, endedAt, requestIds: state.turnRequestIds }
    : null;
  state.turnRequestIds = new Set<string>();
  state.turnStartedAt = null;
  state.turnId = null;
  return { current: true, startedAt };
}
