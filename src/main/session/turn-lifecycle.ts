import type { SessionEvent, TurnOutcome } from '../../shared/session.js';

/** Opening-question authority for one logical recorder turn. */
export type OpeningIdentity =
  | { readonly status: 'unknown' }
  | { readonly status: 'exact'; readonly messageId: string }
  | { readonly status: 'conflict' };

const UNKNOWN_OPENING: OpeningIdentity = { status: 'unknown' };

export type LineageIntegrity = 'intact' | 'damaged';

export function openingIdentity(messageId?: string | null): OpeningIdentity {
  return messageId ? { status: 'exact', messageId } : UNKNOWN_OPENING;
}

/** Immutable opening identity can become known or conflicted, never silently change owners. */
export function mergeOpeningIdentity(current: OpeningIdentity, messageId?: string | null): OpeningIdentity {
  if (current.status === 'conflict' || !messageId) return current;
  if (current.status === 'unknown') return { status: 'exact', messageId };
  return current.messageId === messageId ? current : { status: 'conflict' };
}

export interface TurnRecord {
  opening: OpeningIdentity;
  integrity: LineageIntegrity;
  /** First durable start of the logical turn; corrective same-id reopens retain it. */
  logicalStartedAt: number | null;
  /** Newest durable start segment for this logical turn. */
  segmentStartedAt: number | null;
  /** Historical rows can remain unclosed when their terminal observation was never recorded. */
  phase: 'unclosed' | 'ended';
  outcome: TurnOutcome | null;
}

export interface ActiveTurnProjection {
  id: string;
  logicalStartedAt: number | null;
  segmentStartedAt: number | null;
  opening: OpeningIdentity;
  integrity: LineageIntegrity;
  /** ChatGPT request ids observed while this logical turn was open. */
  requestIds: Set<string>;
}

export interface LastTurnProjection {
  /** Null only when old/bounded restore retained the outcome but not the historical turn id. */
  id: string | null;
  logicalStartedAt: number | null;
  segmentStartedAt: number | null;
  opening: OpeningIdentity;
  integrity: LineageIntegrity;
  outcome: TurnOutcome;
}

/** Completed turn retained only while same-request work can prove its page terminal was false. */
export interface ReopenCandidateProjection {
  turnId: string;
  endedAt: number;
  requestIds: Set<string>;
}

export type TurnStartDisposition = 'new' | 'identity-update' | 'replay' | 'conflict';

/** Mutable in-memory projection of lifecycle facts already committed to the session journal. */
export interface TurnLifecycleProjection {
  /** One mutable owner for every logical turn's identity, integrity and lifecycle state. */
  turnsById: Map<string, TurnRecord>;
  /** Scoped recorder loss is a monotonic tombstone, even before the first surviving row for T. */
  damagedTurnIds: Set<string>;
  activeTurnId: string | null;
  activeRequestIds: Set<string>;
  lastTerminalTurnId: string | null;
  /** Legacy bounded restore can retain an outcome after its historical turn id aged out. */
  legacyLastTurnOutcome: TurnOutcome | null;
  reopenCandidate: ReopenCandidateProjection | null;
  /** Monotonic process-local count of current-turn terminal boundaries. Reopen never rewinds it. */
  terminalRevision: number;
}

export function emptyTurnLifecycleProjection(): TurnLifecycleProjection {
  return {
    turnsById: new Map(),
    damagedTurnIds: new Set(),
    activeTurnId: null,
    activeRequestIds: new Set(),
    lastTerminalTurnId: null,
    legacyLastTurnOutcome: null,
    reopenCandidate: null,
    terminalRevision: 0
  };
}

export function turnRecord(state: TurnLifecycleProjection, turnId: string | null | undefined): TurnRecord | null {
  return turnId ? state.turnsById.get(turnId) ?? null : null;
}

export function activeTurn(state: TurnLifecycleProjection): ActiveTurnProjection | null {
  const id = state.activeTurnId;
  const record = turnRecord(state, id);
  if (!id || !record || record.phase !== 'unclosed') return null;
  return {
    id,
    logicalStartedAt: record.logicalStartedAt,
    segmentStartedAt: record.segmentStartedAt,
    opening: record.opening,
    integrity: record.integrity,
    requestIds: state.activeRequestIds
  };
}

export function lastTurn(state: TurnLifecycleProjection): LastTurnProjection | null {
  const id = state.lastTerminalTurnId;
  const record = turnRecord(state, id);
  if (!id || !record || record.phase !== 'ended' || !record.outcome) {
    return state.legacyLastTurnOutcome
      ? {
          id: null,
          logicalStartedAt: null,
          segmentStartedAt: null,
          opening: UNKNOWN_OPENING,
          integrity: 'intact',
          outcome: state.legacyLastTurnOutcome
        }
      : null;
  }
  return {
    id,
    logicalStartedAt: record.logicalStartedAt,
    segmentStartedAt: record.segmentStartedAt,
    opening: record.opening,
    integrity: record.integrity,
    outcome: record.outcome
  };
}

/** Exact page-start replay semantics. Same id with a different immutable opening is a conflict. */
export function turnStartDisposition(
  state: TurnLifecycleProjection,
  turnId: string,
  openingUserMessageId: string | null
): TurnStartDisposition {
  const known = state.turnsById.get(turnId);
  if (!known) return 'new';
  if (known.opening.status === 'conflict') return 'replay';
  const merged = mergeOpeningIdentity(known.opening, openingUserMessageId);
  if (merged.status === 'conflict') return 'conflict';
  if (known.opening.status === 'unknown' && merged.status === 'exact') return 'identity-update';
  return 'replay';
}

/** Publish a newly committed page-authored start. */
export function projectTurnStart(
  state: TurnLifecycleProjection,
  turnId: string,
  logicalStartedAt: number,
  openingUserMessageId: string | null
): void {
  const prior = state.turnsById.get(turnId);
  const inheritedRequests = state.reopenCandidate?.turnId === turnId
    ? state.reopenCandidate.requestIds
    : new Set<string>();
  state.turnsById.set(turnId, {
    opening: mergeOpeningIdentity(prior?.opening ?? UNKNOWN_OPENING, openingUserMessageId),
    // Integrity belongs to the logical id, not one segment. A same-id corrective start can never
    // heal recorder loss, and a scoped gap may have survived even when the original start did not.
    integrity: state.damagedTurnIds.has(turnId) || prior?.integrity === 'damaged' ? 'damaged' : 'intact',
    logicalStartedAt: prior?.logicalStartedAt ?? logicalStartedAt,
    segmentStartedAt: logicalStartedAt,
    phase: 'unclosed',
    outcome: null
  });
  state.activeTurnId = turnId;
  state.activeRequestIds = new Set(inheritedRequests);
  if (state.lastTerminalTurnId === turnId) state.lastTerminalTurnId = null;
  state.reopenCandidate = null;
}

/** Publish immutable opening evidence without changing lifecycle phase. */
export function projectTurnIdentity(
  state: TurnLifecycleProjection,
  turnId: string,
  openingUserMessageId: string
): void {
  const known = state.turnsById.get(turnId);
  if (!known) return;
  state.turnsById.set(turnId, {
    ...known,
    opening: mergeOpeningIdentity(known.opening, openingUserMessageId)
  });
}

/** Mark only the lineage whose lifecycle evidence is known to be incomplete. */
export function damageTurnLineage(state: TurnLifecycleProjection, turnId: string): void {
  state.damagedTurnIds.add(turnId);
  const known = state.turnsById.get(turnId);
  if (!known || known.integrity === 'damaged') return;
  state.turnsById.set(turnId, { ...known, integrity: 'damaged' });
}

export function recordingGapAffectsLifecycle(event: Extract<SessionEvent, { kind: 'recording_gap' }>): boolean {
  const lost = event.lostKinds;
  // Old/unscoped gaps and bridge-rejected unknown loss remain conservative. Explicitly scoped
  // assistant/progress/tool loss is transcript damage, not lifecycle damage.
  if (!lost || Object.keys(lost).length === 0) return true;
  return (lost.turn_start ?? 0) > 0 || (lost.turn_end ?? 0) > 0 || (lost.unknown ?? 0) > 0;
}

/** Apply one already-durable lifecycle fact. No authorization or guessing belongs here. */
export function reduceTurnLifecycleEvent(state: TurnLifecycleProjection, event: SessionEvent): ProjectedTurnEnd | null {
  if (event.kind === 'turn_start' && event.turnId) {
    projectTurnStart(state, event.turnId, event.time, event.openingUserMessageId ?? null);
    return null;
  }
  if (event.kind === 'turn_identity') {
    projectTurnIdentity(state, event.turnId, event.openingUserMessageId);
    return null;
  }
  if (event.kind === 'turn_end' && event.turnId) {
    return projectTurnEnd(state, event.turnId, event.outcome, event.time);
  }
  if (event.kind === 'recording_gap' && recordingGapAffectsLifecycle(event)) {
    if (event.affectedTurnId) {
      damageTurnLineage(state, event.affectedTurnId);
    } else {
      for (const [turnId, turn] of state.turnsById) {
        if (turn.phase === 'unclosed') damageTurnLineage(state, turnId);
      }
    }
  }
  return null;
}

export function addActiveRequestId(state: TurnLifecycleProjection, requestId: string): void {
  if (state.activeTurnId) state.activeRequestIds.add(requestId);
}

export function reopenCandidateTurn(state: TurnLifecycleProjection): (ReopenCandidateProjection & { turn: ActiveTurnProjection }) | null {
  const candidate = state.reopenCandidate;
  if (!candidate) return null;
  const record = state.turnsById.get(candidate.turnId);
  if (!record) return null;
  return {
    ...candidate,
    turn: {
      id: candidate.turnId,
      logicalStartedAt: record.logicalStartedAt,
      segmentStartedAt: record.segmentStartedAt,
      opening: record.opening,
      integrity: record.integrity,
      requestIds: candidate.requestIds
    }
  };
}

export interface ProjectedTurnEnd {
  current: boolean;
  logicalStartedAt: number | null;
  segmentStartedAt: number | null;
}

/** A stale end remains durable history but cannot tear down a newer active generation. */
export function projectTurnEnd(
  state: TurnLifecycleProjection,
  turnId: string,
  outcome: TurnOutcome,
  endedAt: number
): ProjectedTurnEnd {
  const known = state.turnsById.get(turnId);
  state.turnsById.set(turnId, {
    opening: known?.opening ?? UNKNOWN_OPENING,
    integrity: state.damagedTurnIds.has(turnId) || known?.integrity === 'damaged' ? 'damaged' : 'intact',
    logicalStartedAt: known?.logicalStartedAt ?? null,
    segmentStartedAt: known?.segmentStartedAt ?? null,
    phase: 'ended',
    outcome
  });
  if (state.activeTurnId !== turnId) {
    return { current: false, logicalStartedAt: null, segmentStartedAt: null };
  }
  const record = state.turnsById.get(turnId)!;
  state.lastTerminalTurnId = turnId;
  state.legacyLastTurnOutcome = null;
  state.reopenCandidate = outcome === 'completed'
    ? { turnId, endedAt, requestIds: new Set(state.activeRequestIds) }
    : null;
  state.activeTurnId = null;
  state.activeRequestIds = new Set();
  state.terminalRevision++;
  return {
    current: true,
    logicalStartedAt: record.logicalStartedAt,
    segmentStartedAt: record.segmentStartedAt
  };
}
