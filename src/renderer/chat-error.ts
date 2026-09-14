import type { SessionEvent } from '../shared/session.js';
import { t } from './i18n.js';

type ChatError = Extract<SessionEvent, { kind: 'chat_error' }>;
type ErrorReason = NonNullable<ChatError['reason']>;
type RepairProgress = Extract<SessionEvent, { kind: 'progress' }>;

export interface ChatErrorResolution {
  repair?: RepairProgress;
  continued: boolean;
  completed: boolean;
}

/** Display compatibility only for histories recorded before chat errors carried machine reasons. */
function legacyErrorReason(text: string): ErrorReason | null {
  if (text === 'Thinking failed') return 'thinking_failed';
  if (text.startsWith('No visible progress for ten minutes.')) return 'no_visible_progress';
  return null;
}

/**
 * Resolves every error against later canonical evidence in one timeline pass.
 *
 * Only the most recent unbounded error can own later recovery evidence: a new question, another
 * error, or a different turn start closes the previous error's projection exactly as the old
 * per-row forward scan did. Keeping this fold separate makes rendering O(N) per event revision
 * and presentation O(1) per row.
 */
export function projectChatErrorResolutions(history: readonly SessionEvent[]): ReadonlyMap<number, ChatErrorResolution> {
  const result = new Map<number, ChatErrorResolution>();
  let active: ChatError | null = null;
  for (const event of history) {
    if (event.kind === 'chat_error') {
      active = event;
      result.set(event.seq, { continued: false, completed: false });
      continue;
    }
    if (!active) continue;
    if (event.kind === 'user_message' || (event.kind === 'turn_start' && event.turnId !== active.turnId)) {
      active = null;
      continue;
    }
    const resolution = result.get(active.seq)!;
    if (active.turnId && event.turnId === active.turnId && event.kind === 'turn_end' && event.outcome === 'completed') {
      resolution.completed = true;
    }
    if (active.turnId && event.turnId === active.turnId && event.time > active.time &&
        (event.kind === 'tool_call' || (event.kind === 'turn_start' && event.source === 'app'))) {
      resolution.continued = true;
      resolution.completed = false;
    }
    if (event.source === 'app' && event.kind === 'progress' && event.progressId?.startsWith('browser-repair:') &&
        (!event.turnId || (!!active.turnId && event.turnId === active.turnId))) {
      resolution.repair = event;
    }
  }
  return result;
}

/** Presentation only: lifecycle/recovery authority comes from recorded machine facts. */
export function chatErrorPresentation(error: ChatError, resolution?: ChatErrorResolution) {
  const text = error.message.text.trim();
  const reason = error.reason ?? legacyErrorReason(text);
  const thinking = reason === 'thinking_failed';
  const stalled = reason === 'no_visible_progress';
  const title = thinking ? t('Thinking failed') : stalled ? t('Response stalled') : t('ChatGPT reported a problem');
  const message = thinking ? t('ChatGPT’s page reported a failure. This does not prove the work stopped.')
    : stalled ? t('No visible progress for ten minutes. The app could not confirm that this turn finished.') : error.message.text;
  const severity = error.blocking === true ? 'blocking' as const
    : thinking || stalled || error.recoverable === true ? 'warning' as const : 'error' as const;
  let guidance = error.blocking === true
    ? t('Wait until ChatGPT allows requests again, then retry. Reloading cannot remove this limit.')
    : thinking
      ? t('You can send a follow-up. Automatic follow-ups wait until the chat is safe to continue; fresh work postpones them.')
      : error.recoverable === true || stalled
        ? t('The app will try to refresh this chat when recovery is eligible. A refresh does not resend your message. If it stays stuck, open ChatGPT and check the page before retrying.')
        : t('Open this chat in ChatGPT and check the error. If your message is already there, do not send it again; otherwise retry when the page is ready.');

  if (resolution?.completed) return { title, message, severity, guidance: t('This turn later completed. You can continue with a new message.') };
  if (resolution?.continued) return { title, message, severity, guidance: t('Work continued after this notice. Automatic continuation waits for work to settle; the failed page alone does not trigger another message.') };
  if (resolution?.repair && error.blocking !== true) guidance = `${resolution.repair.message.text} ${thinking
    ? t('You can send a follow-up. Automatic follow-ups wait for the refreshed chat to stay idle before sending.')
    : t('Queued messages still wait until sending is safe. If the chat stays stuck, open ChatGPT and check the page before retrying.')}`;
  return { title, message, severity, guidance };
}
