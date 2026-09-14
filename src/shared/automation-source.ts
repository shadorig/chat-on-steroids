import type { SessionEvent } from './session.js';

export const MAX_AUTOMATION_SOURCE_ID_CHARS = 256;

export type AutomationSourceBoundary =
  | { kind: 'turn'; turnId: string }
  | { kind: 'reply'; messageId: string };

/** Opaque current-schema identity: validate exactly; never trim or truncate authority. */
export function isAutomationSourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_AUTOMATION_SOURCE_ID_CHARS && value.trim() === value;
}

/** Strict current-schema parser. Compatibility translation belongs only in the legacy adapter below. */
export function parseAutomationSourceBoundary(raw: unknown): AutomationSourceBoundary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (value.kind === 'turn' && keys.length === 2 && keys.includes('turnId') && isAutomationSourceId(value.turnId)) {
    return { kind: 'turn', turnId: value.turnId };
  }
  if (value.kind === 'reply' && keys.length === 2 && keys.includes('messageId') && isAutomationSourceId(value.messageId)) {
    return { kind: 'reply', messageId: value.messageId };
  }
  return null;
}

export function automationSourceBoundaryEquals(
  left: AutomationSourceBoundary | null | undefined,
  right: AutomationSourceBoundary | null | undefined
): boolean {
  if (!left || !right || left.kind !== right.kind) return left == null && right == null;
  return left.kind === 'turn'
    ? left.turnId === (right as Extract<AutomationSourceBoundary, { kind: 'turn' }>).turnId
    : left.messageId === (right as Extract<AutomationSourceBoundary, { kind: 'reply' }>).messageId;
}

/** Converts the pre-structured Goal/outbox source encoding into the explicit boundary model. */
export function automationSourceBoundaryFromLegacy(value: string | null | undefined): AutomationSourceBoundary | null {
  if (!value || value.trim() !== value) return null;
  if (!value.startsWith('reply:')) return isAutomationSourceId(value) ? { kind: 'turn', turnId: value } : null;
  const messageId = value.slice('reply:'.length);
  return isAutomationSourceId(messageId) ? { kind: 'reply', messageId } : null;
}

/** Stable diagnostic/compatibility spelling; runtime authority should keep the structured value. */
export function automationSourceBoundaryId(boundary: AutomationSourceBoundary): string {
  return boundary.kind === 'turn' ? boundary.turnId : `reply:${boundary.messageId}`;
}

/** The automation source proven by one terminal session event, if that event names one exactly. */
export function completedAutomationSourceBoundary(event: SessionEvent): AutomationSourceBoundary | null {
  if (event.kind === 'turn_end') {
    return event.outcome === 'completed' && isAutomationSourceId(event.turnId) ? { kind: 'turn', turnId: event.turnId } : null;
  }
  if (event.kind !== 'assistant_message' || event.final !== true || event.state !== 'final') return null;
  if (isAutomationSourceId(event.turnId)) return { kind: 'turn', turnId: event.turnId };
  return isAutomationSourceId(event.messageId) ? { kind: 'reply', messageId: event.messageId } : null;
}
