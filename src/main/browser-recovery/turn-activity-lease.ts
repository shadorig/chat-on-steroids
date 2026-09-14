export type TurnModelClass = 'pro' | 'non-pro' | 'unknown';

interface TurnActivityLeaseBase {
  /** Process-local semantic generation. Scheduling-only changes preserve it. */
  leaseId: number;
  /** Durable session principal whose current frontend owned this activity when it was proven. */
  sessionId: string;
  turnId: string | null;
  model: TurnModelClass;
}

export interface ActiveTurnActivityLease extends TurnActivityLeaseBase {
  phase: 'active';
  evidenceAt: number;
  expiresAt: number;
  /** Exact request-id MCP proof survives a native terminal observation until its quiet window ends. */
  evidence: 'native' | 'exact-mcp';
}

export interface FailedViewAwaitingRefreshLease extends TurnActivityLeaseBase {
  phase: 'failed-view-awaiting-refresh';
  turnId: string;
  observedAt: number;
  refreshDueAt: number;
}

export interface FailedViewListeningLease extends TurnActivityLeaseBase {
  phase: 'failed-view-listening';
  turnId: string;
  observedAt: number;
  listenUntil: number;
}

export type TurnActivityLease =
  | ActiveTurnActivityLease
  | FailedViewAwaitingRefreshLease
  | FailedViewListeningLease;

export type NewTurnActivityLease = TurnActivityLease extends infer Lease
  ? Lease extends TurnActivityLease
    ? Omit<Lease, 'leaseId'>
    : never
  : never;

export type TurnActivityOwnership = Pick<ActiveTurnActivityLease, 'turnId' | 'model'> & {
  evidence?: ActiveTurnActivityLease['evidence'];
};

export const isActiveTurnActivity = (lease: TurnActivityLease): lease is ActiveTurnActivityLease =>
  lease.phase === 'active';

export const isFailedViewActivity = (
  lease: TurnActivityLease
): lease is FailedViewAwaitingRefreshLease | FailedViewListeningLease => lease.phase !== 'active';

export function activityLeaseDeadline(lease: TurnActivityLease): number {
  switch (lease.phase) {
    case 'active': return lease.expiresAt;
    case 'failed-view-awaiting-refresh': return lease.refreshDueAt;
    case 'failed-view-listening': return lease.listenUntil;
  }
}

export function activityLeaseEvidenceAt(lease: TurnActivityLease): number {
  return lease.phase === 'active' ? lease.evidenceAt : lease.observedAt;
}

/**
 * Moves only the scheduling edge of this exact semantic generation.
 * Deadline extension is scheduling rather than new authority, so the explicit lease id is kept.
 */
export function extendActivityLeaseDeadline(lease: TurnActivityLease, until: number): TurnActivityLease {
  switch (lease.phase) {
    case 'active': return { ...lease, expiresAt: until };
    case 'failed-view-awaiting-refresh': return { ...lease, refreshDueAt: until };
    case 'failed-view-listening': return { ...lease, listenUntil: until };
  }
}
