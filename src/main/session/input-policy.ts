import { isFollowupInput } from '../../shared/input.js';
import type { InputEntry } from './input-state.js';

export type InputDeliveryClass = 'immediate' | 'after-turn' | 'finish' | 'decision';

/** Stable authored-delivery class. Transport and recovery authority are separate dimensions. */
export function inputDeliveryClass(row: InputEntry): InputDeliveryClass {
  if (row.purpose === 'decision') return 'decision';
  if (row.mode === 'finish' || row.finishOwner) return 'finish';
  if (isFollowupInput(row)) return 'after-turn';
  return 'immediate';
}

/** Auto is authored immediate intent even when native files force browser transport after the turn. */
export function isImmediateUserInput(row: InputEntry): boolean {
  return (row.requestedMode ?? row.mode) === 'auto' && inputDeliveryClass(row) === 'immediate' &&
    row.attachmentDelivery !== 'tool-image-projection';
}

export function isDeferredFollowup(row: InputEntry): boolean {
  return !isImmediateUserInput(row) && isFollowupInput(row);
}

export function orderInputs(rows: readonly InputEntry[]): InputEntry[] {
  return [...rows].sort((a, b) =>
    (a.queueOrder ?? a.dueAt) - (b.queueOrder ?? b.dueAt) || a.createdAt - b.createdAt);
}
