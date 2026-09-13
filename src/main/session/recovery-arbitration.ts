import { continuationForSession } from './continuation.js';
import { runningToolCalls } from '../mcp/call-context.js';
import { logWarn } from '../logger.js';
import {
  acceptGoalReplyNow,
  effectiveLoopAfterTurnFor,
  goalPendingReplyFor,
  withdrawRecoveryGoalReplyNow
} from '../goal.js';
import { bindRecoveryToQueuedInput } from './input.js';
import { captureRecoveryProof, type RecoveryGrant } from './recovery-proof.js';

export type RecoveryAssignment =
  | { kind: 'none' }
  | { kind: 'queued-input'; inputId: string; notBefore?: number }
  | { kind: 'goal-loop'; replyId: string; notBefore?: number };

/**
 * Allocate one exact recovered turn to its next durable owner.
 *
 * Proof creation is separate from ownership. Explicit user work gets first refusal through the
 * outbox; synthesized Goal/Loop work is considered only when the outbox has neither an eligible
 * instruction nor transport custody. Each destination owns its own persistence.
 */
export async function assignRecoveredContinuation(input: {
  sessionId: string;
  conversationId: string;
  turnId: string;
  kind: 'thinking-failed' | 'recovered-silence';
  current: () => boolean;
  notBefore?: number;
  goal?: { replyId: string; turnId: string; allowed: () => boolean };
}): Promise<RecoveryAssignment> {
  if (!input.current()) return { kind: 'none' };
  const proof = await captureRecoveryProof({
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    kind: input.kind,
    current: input.current
  });
  if (!proof || !input.current()) return { kind: 'none' };
  const grant: RecoveryGrant = {
    proof,
    ...(input.notBefore !== undefined && input.notBefore > Date.now() ? { notBefore: input.notBefore } : {})
  };
  const binding = await bindRecoveryToQueuedInput({
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    grant,
    current: input.current
  });
  if (binding.kind === 'bound') {
    return { kind: 'queued-input', inputId: binding.inputId, ...(grant.notBefore ? { notBefore: grant.notBefore } : {}) };
  }
  if (binding.kind !== 'none' || !input.goal || !input.current() || !input.goal.allowed()) return { kind: 'none' };
  if (continuationForSession(input.sessionId) || runningToolCalls(input.conversationId) > 0 || goalPendingReplyFor(input.conversationId)) {
    return { kind: 'none' };
  }
  if (proof.modelClass === 'unknown' ||
      (proof.modelClass === 'pro' && !await effectiveLoopAfterTurnFor(input.sessionId, input.conversationId))) {
    return { kind: 'none' };
  }
  const accepted = await acceptGoalReplyNow({
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    recovery: grant,
    replyId: input.goal.replyId,
    turnId: input.goal.turnId,
    eventSeq: proof.headSeq,
    blocked: false,
    current: input.current
  });
  const pending = accepted ? goalPendingReplyFor(input.conversationId) : null;
  return pending?.replyId === input.goal.replyId
    ? { kind: 'goal-loop', replyId: input.goal.replyId, ...(grant.notBefore ? { notBefore: grant.notBefore } : {}) }
    : { kind: 'none' };
}

/**
 * Transfer a still-unspent synthetic recovery to newly queued explicit user work.
 *
 * The destination commits first. If retiring Goal then fails, both projections can temporarily
 * exist. `recoveredGoalPrecedenceClear` re-runs this precedence before every synthetic recovery
 * draft, so duplicate projections can never become duplicate authority. The caller still validates
 * the recovery proof itself after this await; this function answers only who owns the checkpoint.
 */
export async function preferQueuedInputOverGoalRecovery(sessionId: string, conversationId: string): Promise<boolean> {
  const pending = goalPendingReplyFor(conversationId);
  if (!pending?.recovery) return false;
  const binding = await bindRecoveryToQueuedInput({
    sessionId,
    conversationId,
    grant: pending.recovery,
    current: () => goalPendingReplyFor(conversationId)?.replyId === pending.replyId
  });
  if (binding.kind === 'none' || binding.kind === 'invalid') return false;
  if (binding.kind === 'bound') {
    await withdrawRecoveryGoalReplyNow(conversationId, pending.replyId)
      .catch(error => logWarn(`goal: explicit input owns recovery but synthetic cleanup failed: ${String(error)}`));
  }
  // `blocked` means explicit browser/tool custody already owns sequencing for this session.
  return true;
}

/** Final explicit-input precedence fence for one synthetic recovery obligation. */
export async function recoveredGoalPrecedenceClear(
  sessionId: string,
  conversationId: string,
  replyId: string
): Promise<boolean> {
  const pending = goalPendingReplyFor(conversationId);
  if (!pending?.recovery || pending.replyId !== replyId) return false;
  if (await preferQueuedInputOverGoalRecovery(sessionId, conversationId)) return false;
  const current = goalPendingReplyFor(conversationId);
  return current?.replyId === replyId && Boolean(current.recovery);
}
