import { z } from 'zod';
import { isChatBlocked } from './blocked-chats.js';
import { inFlightToolCalls } from '../mcp/call-context.js';
import { getSession, readRecentEvents } from './store.js';
import {
  recoveryGrantSchema,
  validateRecoveryProof,
  type RecoveryGrant
} from './recovery-proof.js';

/** One source-turn boundary that exactly one queued browser follow-up may consume. */
export const followupPermitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed-turn'), turnId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('recovery'), grant: recoveryGrantSchema }).strict()
]);
export type FollowupPermit = z.infer<typeof followupPermitSchema>;

export function followupPermitTurnId(permit: FollowupPermit): string {
  return permit.kind === 'completed-turn' ? permit.turnId : permit.grant.proof.turnId;
}

export function recoveryGrantFor(entry: { followupPermit?: FollowupPermit }): RecoveryGrant | undefined {
  return entry.followupPermit?.kind === 'recovery' ? entry.followupPermit.grant : undefined;
}

type PermitCandidate = {
  sessionId: string | null;
  createdAt: number;
  followupPermit?: FollowupPermit;
};

/**
 * Re-prove a source-turn permit at claim and immediately before native Send.
 *
 * Completed turns are derived from current durable lifecycle evidence. Recovery grants additionally
 * freeze exact causal evidence and may be postponed, but elapsed time never creates authority.
 */
export async function validateFollowupPermit(
  entry: PermitCandidate,
  recoveryAllowed: (conversationId: string) => boolean
): Promise<FollowupPermit | null> {
  if (!entry.sessionId) return null;
  const session = await getSession(entry.sessionId);
  if (!session || session.origin?.kind === 'worker') return null;
  const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  const grant = recoveryGrantFor(entry);
  if (grant) {
    const proof = grant.proof;
    if (session.conversationId !== proof.conversationId || isChatBlocked(proof.conversationId) ||
        !recoveryAllowed(proof.conversationId) ||
        (session.activeTurnId && session.activeTurnId !== proof.turnId) || inFlightToolCalls(proof.conversationId) > 0) return null;
    if (end?.turnId !== proof.turnId) return null;
    // A genuine completion supersedes provisional recovery and falls through to the ordinary
    // completion policy. Otherwise the exact recovery proof must still be current.
    if (!(end.kind === 'turn_end' && end.outcome === 'completed')) {
      if ((grant.notBefore ?? 0) > Date.now()) return null;
      const settledFailure = end.kind === 'turn_end' && end.outcome === 'failed' && end.reason === 'thinking_failed';
      if (proof.kind === 'thinking-failed' && settledFailure) {
        return await validateRecoveryProof(entry.sessionId, proof) ? entry.followupPermit! : null;
      }
      if (end.kind === 'turn_start' || (end.kind === 'turn_end' && end.outcome !== 'stopped')) {
        return await validateRecoveryProof(entry.sessionId, proof) ? entry.followupPermit! : null;
      }
    }
  }
  if (session.activeTurnId) return null;
  // Ordinary completion can mint its permit from durable lifecycle state. Recovery failures are
  // different: their exact proof and listen deadline are assigned only by the bridge after the
  // browser confirms the recovery refresh, so a bare failed turn must never mint Send authority.
  if (end?.kind !== 'turn_end' || !end.turnId || end.time < entry.createdAt) return null;
  if (end.outcome !== 'completed') return null;
  return { kind: 'completed-turn', turnId: end.turnId };
}
