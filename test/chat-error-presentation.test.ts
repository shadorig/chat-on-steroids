import { expect, it } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';
import { chatErrorPresentation, projectChatErrorResolutions } from '../src/renderer/chat-error.js';

const error = (text: string, extra = {}): Extract<SessionEvent, { kind: 'chat_error' }> => ({
  seq: 1, time: 100, source: 'extension', kind: 'chat_error', turnId: 'turn-a',
  message: { text, chars: text.length, truncated: false }, ...extra
});
const repair = (text: string, extra = {}): Extract<SessionEvent, { kind: 'progress' }> => ({
  seq: 2, time: 101, source: 'app', kind: 'progress', turnId: 'turn-a', progressId: 'browser-repair:one',
  message: { text, chars: text.length, truncated: false }, ...extra
});
const presentation = (failed: Extract<SessionEvent, { kind: 'chat_error' }>, history: readonly SessionEvent[]) =>
  chatErrorPresentation(failed, projectChatErrorResolutions(history).get(failed.seq));

it('explains every error without promising an unknown automatic retry', () => {
  const view = chatErrorPresentation(error('An unfamiliar provider error'));
  expect(view.message).toBe('An unfamiliar provider error');
  expect(view.guidance).toContain('do not send it again');
  expect(view.guidance).not.toContain('will try');
  expect(chatErrorPresentation(error('Unbekannt', { blocking: true })).guidance).toContain('Reloading cannot remove this limit');
  expect(chatErrorPresentation(error('Unbekannt', { recoverable: true })).guidance).toContain('when recovery is eligible');
});

it('uses machine reasons for current errors and prose only as legacy display compatibility', () => {
  const thinking = chatErrorPresentation(error('Localized provider failure', { reason: 'thinking_failed' }));
  expect(thinking.title).toBe('Thinking failed');
  expect(thinking.guidance).toContain('You can send a follow-up');
  expect(thinking.guidance).toContain('safe to continue');

  const stalled = chatErrorPresentation(error('Localized watchdog copy', { reason: 'no_visible_progress' }));
  expect(stalled.title).toBe('Response stalled');
  expect(stalled.message).toContain('could not confirm');

  expect(chatErrorPresentation(error('Thinking failed')).title).toBe('Thinking failed');
  expect(chatErrorPresentation(error('No visible progress for ten minutes. Legacy wording.')).title).toBe('Response stalled');
});

it('shows the existing repair receipt, not a claim that the response recovered', () => {
  const failed = error('Connection interrupted', { recoverable: true });
  const trying = repair('Trying to reload chat…');
  expect(presentation(failed, [failed, trying]).guidance).toContain(trying.message.text);
  const done = repair('Reloaded chat to recover an interrupted response.', { seq: 3 });
  const result = presentation(failed, [failed, trying, done]);
  expect(result.guidance).toContain(done.message.text);
  expect(result.guidance).not.toContain('will try to refresh');
  expect(result.guidance).toContain('wait until sending is safe');
});

it('never borrows a later question, different turn or unrelated error recovery', () => {
  const failed = error('Connection interrupted');
  const other = repair('Foreign recovery', { turnId: 'turn-b' });
  expect(presentation(failed, [failed, other]).guidance).not.toContain('Foreign recovery');
  const question: SessionEvent = { seq: 2, time: 101, source: 'extension', kind: 'user_message', message: { text: 'Next', chars: 4, truncated: false } };
  const unscoped = repair('Later recovery', { seq: 4, turnId: undefined });
  expect(presentation(failed, [failed, question, unscoped]).guidance).not.toContain('Later recovery');
  expect(presentation(failed, [failed, error('Another error', { seq: 3 }), unscoped]).guidance).not.toContain('Later recovery');
});

it('only an exact completed boundary supersedes the error guidance', () => {
  const failed = error('Localized provider failure', { reason: 'thinking_failed' });
  const end: SessionEvent = { seq: 3, time: 110, source: 'extension', kind: 'turn_end', turnId: 'turn-a', outcome: 'completed' };
  expect(presentation(failed, [failed, end]).guidance).toContain('later completed');
  expect(presentation(failed, [failed, { ...end, turnId: 'turn-b' }]).guidance).not.toContain('later completed');
  expect(presentation(failed, [failed, { ...end, outcome: 'stopped' }]).guidance).not.toContain('later completed');
  const reopened: SessionEvent = { seq: 4, time: 120, source: 'app', kind: 'turn_start', turnId: 'turn-a' };
  expect(presentation(failed, [failed, end, reopened]).guidance).toContain('Work continued');
  expect(presentation(failed, [failed, { ...reopened, turnId: 'turn-b' }]).guidance).not.toContain('Work continued');
});
