/** Minimum shape needed to identify contiguous lifecycle segments in append order. */
export interface SegmentEvent {
  seq: number;
  origin?: number;
  time: number;
  kind: string;
  turnId?: string | null;
}

export interface TurnSegment {
  turnId: string;
  /** Stable append-domain position of the start that opened this contiguous segment. */
  anchor: number;
  /** Observation time of its newest durable end, absent while the segment is open. */
  endTime?: number;
}

export interface TurnSegmentProjection<T extends SegmentEvent> {
  /** Canonical append-order view used to build this projection. */
  entries: readonly T[];
  segmentByEntry: ReadonlyMap<T, TurnSegment>;
  segments: readonly TurnSegment[];
}

const positionOf = (entry: SegmentEvent): number =>
  typeof entry.origin === 'number' && Number.isFinite(entry.origin) ? entry.origin : entry.seq;

/**
 * Projects logical turn ids into contiguous append-order segments without rewriting history.
 *
 * A corrective app-authored `turn_start` may reopen the same logical turn after a terminal row.
 * That start begins a new segment. Duplicate starts while the segment is still open remain
 * idempotent. Consumers should use this projection rather than independently remembering the
 * reopen rule.
 */
export function projectTurnSegments<T extends SegmentEvent>(entries: readonly T[]): TurnSegmentProjection<T> {
  const byAppendOrder = [...entries].sort((a, b) => positionOf(a) - positionOf(b) || a.seq - b.seq);
  const currentByTurn = new Map<string, TurnSegment & { closed: boolean }>();
  const segmentByEntry = new Map<T, TurnSegment>();
  const segments: Array<TurnSegment & { closed: boolean }> = [];

  for (const entry of byAppendOrder) {
    const turnId = entry.turnId;
    if (!turnId) continue;
    let segment = currentByTurn.get(turnId);
    if (entry.kind === 'turn_start' && (!segment || segment.closed)) {
      segment = { turnId, anchor: positionOf(entry), closed: false };
      currentByTurn.set(turnId, segment);
      segments.push(segment);
    }
    // A closed segment can still receive late-attributed evidence carrying its turn id. Closed
    // only means a later `turn_start` for the same logical id must mint a new segment.
    if (!segment) continue;
    segmentByEntry.set(entry, segment);
    if (entry.kind === 'turn_end') {
      segment.endTime = Math.max(segment.endTime ?? Number.NEGATIVE_INFINITY, entry.time);
      segment.closed = true;
    }
  }

  return {
    entries: byAppendOrder,
    segmentByEntry,
    segments: segments.map(({ closed: _closed, ...segment }) => segment)
  };
}
