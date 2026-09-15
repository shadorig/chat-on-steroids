import { z } from 'zod';
import { isProModel } from '../../shared/chat-models.js';
import type { TurnRecoveryEvidence } from './store.js';
import { readTurnRecoveryEvidence } from './store.js';

/** Provider-busy postponement. Deferral extends an existing proof; it never creates one. */
export const RECOVERY_DEFER_MS = 5 * 60_000;

/** Immutable causal evidence. Scheduling state deliberately lives outside this object. */
export const recoveryProofSchema = z.object({
  kind: z.enum(['thinking-failed', 'recovered-silence']),
  conversationId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  /** Durable work head when authority was captured. Any newer work revokes the proof. */
  headSeq: z.number().int().nonnegative(),
  /** Exact request-id-attributed MCP call whose execution made recovery continuation admissible. */
  mcpCallSeq: z.number().int().nonnegative(),
  /** Model class proven by the exact qualifying MCP call. `unknown` means that call had no model proof. */
  // `other` was the pre-release spelling. Accept it only as an on-read migration so
  // persisted local state does not become unreadable while new writes stay precise.
  modelClass: z.enum(['pro', 'non-pro', 'other', 'unknown']).transform(value => value === 'other' ? 'non-pro' as const : value)
}).strict();
export type RecoveryProof = z.infer<typeof recoveryProofSchema>;

export const recoveryGrantSchema = z.object({
  proof: recoveryProofSchema,
  /** Provider-native busy can postpone a valid proof; elapsed time never creates authority. */
  notBefore: z.number().nonnegative().optional()
}).strict();
export type RecoveryGrant = z.infer<typeof recoveryGrantSchema>;

function evidenceMatchesKind(evidence: TurnRecoveryEvidence, proof: Pick<RecoveryProof, 'kind' | 'turnId'>): boolean {
  const { lifecycle, head } = evidence;
  if (!lifecycle || lifecycle.turnId !== proof.turnId || lifecycle.integrity !== 'intact' || !head) return false;
  if (proof.kind === 'thinking-failed') {
    return lifecycle.kind === 'turn_end' && lifecycle.outcome === 'failed' &&
      lifecycle.reason === 'thinking_failed' && head.seq === lifecycle.seq &&
      // `lastToolCallAt` is part of the same serialized session snapshot. Keep this
      // independent of the bounded journal head: a tool that started after the provider
      // declared Thinking failed is positive resumed-work evidence even if a damaged or
      // future journal layout ever prevented that row from becoming the scanned head.
      (evidence.session.lastToolCallAt ?? 0) <= lifecycle.time;
  }
  return !(lifecycle.kind === 'turn_end' && ['completed', 'stopped'].includes(lifecycle.outcome));
}

function modelClassFor(evidence: TurnRecoveryEvidence): RecoveryProof['modelClass'] {
  const call = evidence.exactMcpCall?.call;
  if (!call?.model) return 'unknown';
  return isProModel(call.model, call.reasoningEffort) ? 'pro' : 'non-pro';
}

/** Capture an exact, revocable recovery right from one coherent recorder snapshot. */
export async function captureRecoveryProof(input: {
  sessionId: string;
  conversationId: string;
  turnId: string;
  kind: RecoveryProof['kind'];
  current?: () => boolean;
}): Promise<RecoveryProof | null> {
  const evidence = await readTurnRecoveryEvidence(input.sessionId, input.conversationId, input.turnId);
  if (!evidence || !evidence.exactMcpCall || !evidenceMatchesKind(evidence, input) || !evidence.head) return null;
  if (input.current && !input.current()) return null;
  return {
    kind: input.kind,
    conversationId: input.conversationId,
    turnId: input.turnId,
    headSeq: evidence.head.seq,
    mcpCallSeq: evidence.exactMcpCall.seq,
    modelClass: modelClassFor(evidence)
  };
}

/** New work or a different exact source proof revokes recovery authority; clocks do not decide causality. */
export async function validateRecoveryProof(sessionId: string, proof: RecoveryProof): Promise<TurnRecoveryEvidence | null> {
  const evidence = await readTurnRecoveryEvidence(sessionId, proof.conversationId, proof.turnId);
  if (!evidence || !evidence.exactMcpCall || !evidence.head || !evidenceMatchesKind(evidence, proof)) return null;
  if (evidence.head.seq !== proof.headSeq) return null;
  // Migrated pre-proof rows used no exact call sequence; validate the exact call without
  // pretending migration strengthened its evidence. New rows freeze the precise call and
  // therefore also freeze the model class proven by that call.
  if (proof.mcpCallSeq !== 0 && evidence.exactMcpCall.seq !== proof.mcpCallSeq) return null;
  if (proof.mcpCallSeq !== 0 && modelClassFor(evidence) !== proof.modelClass) return null;
  // A legacy row with no exact call id cannot honestly preserve a historical model assertion.
  if (proof.mcpCallSeq === 0 && proof.modelClass !== 'unknown') return null;
  return evidence;
}

export function deferRecoveryGrant(grant: RecoveryGrant, now = Date.now()): RecoveryGrant {
  return { ...grant, notBefore: now + RECOVERY_DEFER_MS };
}
