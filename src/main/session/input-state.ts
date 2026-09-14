import { z } from 'zod';
import { REASONING_EFFORTS } from '../../shared/session.js';
import {
  MAX_PROJECTED_IMAGE_COUNT,
  MAX_PROJECTED_IMAGE_DATA_URL_CHARS
} from '../../shared/input.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../../shared/user-prompt.js';
import { attachmentSchema } from './input-attachments.js';
import { projectedImageRefSchema } from './input-image-projection.js';
import { followupPermitSchema } from './input-followup.js';
import {
  automationSourceBoundaryFromLegacy,
  isAutomationSourceId,
  MAX_AUTOMATION_SOURCE_ID_CHARS,
  type AutomationSourceBoundary
} from '../../shared/automation-source.js';

export const inputArgs = z.object({
  projectId: z.string().uuid().nullable().optional(),
  automation: z.enum(['off', 'goal', 'loop']).optional(),
  loopTrigger: z.enum(['session-finish', 'after-turn']).optional(),
  objective: z.string().trim().max(16000).optional(),
  stages: z.array(z.string().trim().min(1).max(16000)).max(11).optional(),
  images: z.array(z.object({ name: z.string().min(1).max(110), dataUrl: z.string().max(MAX_PROJECTED_IMAGE_DATA_URL_CHARS).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/) })).max(MAX_PROJECTED_IMAGE_COUNT).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  attachmentDelivery: z.literal('tool-image-projection').optional(),
  id: z.string().uuid(),
  sessionId: z.string().min(8).max(64).nullable(),
  text: z.string().trim().min(1).max(MAX_CHATGPT_MESSAGE_CHARS),
  mode: z.enum(['auto', 'after-turn', 'finish']),
  afterTurn: z.boolean().optional(),
  dueAt: z.number().int().nonnegative(),
  model: z.string().max(80).nullable(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable()
});
export type InputArgs = z.infer<typeof inputArgs>;

const automationSourceIdSchema = z.string().min(1).max(MAX_AUTOMATION_SOURCE_ID_CHARS).refine(isAutomationSourceId);
const automationSourceBoundarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('turn'), turnId: automationSourceIdSchema }).strict(),
  z.object({ kind: z.literal('reply'), messageId: automationSourceIdSchema }).strict()
]);

export const inputEntrySchema = inputArgs.extend({
  /** Immutable projection refs; authored attachment IDs remain the replay identity. */
  projectedImages: z.array(projectedImageRefSchema).max(MAX_PROJECTED_IMAGE_COUNT).optional(),
  /** Exact source-turn authority this browser follow-up may consume once. */
  followupPermit: followupPermitSchema.optional(),
  /** Exact automation source boundary frozen when this explicit message is authored. */
  automationSource: automationSourceBoundarySchema.optional(),
  /** Exact tool-free turn this explicit browser correction may interrupt. */
  directTurn: z.object({ id: z.string().min(1).max(256), startedAt: z.number() }).optional(),
  finishOwner: z.object({ turnId: z.string().min(1).max(256), periodic: z.boolean(), userRequested: z.boolean().optional() }).optional(),
  requestedMode: z.enum(['auto', 'after-turn', 'finish']).optional(),
  transportIntent: z.enum(['tool', 'browser']).optional(),
  text: z.string().min(1).max(240000),
  deliveryText: z.string().min(1).max(240000).optional(),
  purpose: z.enum(['user', 'decision']).optional(),
  lifetime: z.literal('temporary-planner').optional(),
  decisionSourceSessionId: z.string().min(8).max(64).optional(),
  response: z.string().max(16000).optional(),
  state: z.enum(['queued', 'browser', 'tool', 'sent', 'cancelled', 'failed', 'decision']),
  offeredAt: z.number().optional(),
  sendAuthorizedAt: z.number().optional(),
  requiresAuthorization: z.boolean().optional(),
  error: z.string().max(200).optional(),
  owner: z.string().nullable(),
  createdAt: z.number(),
  conversationId: z.string().nullable(),
  deliveredSessionId: z.string().min(8).max(64).nullable().optional(),
  messageId: z.string().min(1).max(256).optional(),
  deliveredAt: z.number().optional(),
  stagesApplied: z.boolean().optional(),
  historyRecorded: z.boolean().optional(),
  queueOrder: z.number().int().nonnegative().optional(),
  projectAuthorityEra: z.string().uuid().optional()
});
export type InputEntry = z.infer<typeof inputEntrySchema>;

const SNAPSHOT_VERSION = 2 as const;
const snapshotSchema = z.object({ version: z.literal(SNAPSHOT_VERSION), entries: z.array(inputEntrySchema) }).strict();

const v1EntrySchema = inputEntrySchema
  .omit({ automationSource: true })
  .extend({ automationSourceTurnId: z.string().min(1).max(256).optional() });
const v1SnapshotSchema = z.object({ version: z.literal(1), entries: z.array(v1EntrySchema) }).strict();

/**
 * The only shipped pre-snapshot format was the 2.0.10 bare row array. Its `completedTurnId` is
 * positive completed-turn authority and is the one legacy field worth translating. Fields created
 * only while protocol 15 was under development are intentionally not part of this schema.
 */
const legacyEntrySchema = inputEntrySchema
  .omit({ attachmentDelivery: true, projectedImages: true, followupPermit: true, automationSource: true })
  .extend({ completedTurnId: z.string().max(256).optional() });

function withLegacyAutomationSource<T extends { automationSourceTurnId?: string }>(row: T): Omit<T, 'automationSourceTurnId'> & {
  automationSource?: AutomationSourceBoundary;
} {
  const { automationSourceTurnId, ...rest } = row;
  const automationSource = automationSourceBoundaryFromLegacy(automationSourceTurnId);
  return { ...rest, ...(automationSource ? { automationSource } : {}) };
}

export function decodeInputState(raw: unknown): { entries: InputEntry[]; migrated: boolean } {
  if (raw === null || raw === undefined) return { entries: [], migrated: false };
  const current = snapshotSchema.safeParse(raw);
  if (current.success) return { entries: current.data.entries, migrated: false };
  const v1 = v1SnapshotSchema.safeParse(raw);
  if (v1.success) {
    return {
      entries: v1.data.entries.map(row => withLegacyAutomationSource(row) as InputEntry),
      migrated: true
    };
  }
  const legacy = z.array(legacyEntrySchema).safeParse(raw);
  if (!legacy.success) throw new Error('The message outbox could not be read safely');
  return {
    entries: legacy.data.map(({ completedTurnId, ...row }): InputEntry => ({
      ...row,
      ...(completedTurnId ? { followupPermit: { kind: 'completed-turn' as const, turnId: completedTurnId } } : {})
    })),
    migrated: true
  };
}

export function encodeInputState(entries: InputEntry[]): unknown {
  const durable = entries.map(row => row.lifetime === 'temporary-planner'
    ? { ...row, text: '[Temporary planner]', deliveryText: undefined, response: undefined }
    : row);
  return snapshotSchema.parse({ version: SNAPSHOT_VERSION, entries: durable });
}
