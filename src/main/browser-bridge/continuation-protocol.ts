export const CONTINUATION_CHECKPOINT_ACTIONS = [
  'source-claim',
  'source-arm',
  'source-release',
  'destination-claim',
  'destination-arm',
  'destination-release'
] as const;

export type ContinuationCheckpointAction = (typeof CONTINUATION_CHECKPOINT_ACTIONS)[number];

const CHECKPOINT_ACTIONS = new Set<ContinuationCheckpointAction>(CONTINUATION_CHECKPOINT_ACTIONS);

/** Protocol <=16 represented send transitions as independent booleans. */
const LEGACY_CHECKPOINT_FIELDS = [
  'sourceAttempt',
  'sourceDispatch',
  'sourceLost',
  'destinationAttempt',
  'destinationDispatch',
  'destinationLost'
] as const;

export function hasLegacyContinuationCheckpoint(body: Readonly<Record<string, unknown>>): boolean {
  return LEGACY_CHECKPOINT_FIELDS.some((field) => body[field] === true);
}

export function continuationCheckpointAction(value: unknown): ContinuationCheckpointAction | null {
  return typeof value === 'string' && CHECKPOINT_ACTIONS.has(value as ContinuationCheckpointAction)
    ? value as ContinuationCheckpointAction
    : null;
}

export const sourceCheckpointAction = (
  action: ContinuationCheckpointAction | null
): action is Extract<ContinuationCheckpointAction, `source-${string}`> => action?.startsWith('source-') === true;

export const destinationCheckpointAction = (
  action: ContinuationCheckpointAction | null
): action is Extract<ContinuationCheckpointAction, `destination-${string}`> => action?.startsWith('destination-') === true;

export const isContinuationSendCheckpoint = (action: ContinuationCheckpointAction | null): boolean =>
  action === 'source-claim' || action === 'source-arm' || action === 'destination-claim' || action === 'destination-arm';
