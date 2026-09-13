import type { ReasoningEffort } from './session.js';
import { finishInstruction } from './finish.js';

/** Normalized image bytes only. No local filesystem path crosses into the renderer. */
export interface InputImage { name: string; dataUrl: string; }
/** Upload metadata without a local path. Outbox ids require immutable staging;
 * recorded native-message ids are presentation metadata and grant no file access. */
export interface InputAttachment { id: string; name: string; size: number; mimeType: string; preview?: string; }
export const MAX_PROJECTED_IMAGE_COUNT = 4;
export const MAX_PROJECTED_IMAGE_SOURCE_BYTES = 12 * 1024 * 1024;
export const MAX_PROJECTED_IMAGE_BYTES = 384_000;
export const MAX_PROJECTED_IMAGE_DATA_URL_CHARS = 'data:image/webp;base64,'.length + Math.ceil(MAX_PROJECTED_IMAGE_BYTES / 3) * 4;
export const MAX_TOOL_INPUT_TEXT_BYTES = 128_000;
export const TOOL_INPUT_HEADER = '\n--- New instructions from the user ---\n';
/**
 * Renderer-side preflight budget for authored Current-turn text.
 *
 * Main remains authoritative and may add context-specific setup, but the UI must at least reserve
 * the fixed transport framing it knows every tool-delivered message can require. The finish
 * instruction only varies between one-digit lead values, so either supported value has the same
 * UTF-8 size.
 */
export const MAX_TOOL_AUTHORED_TEXT_BYTES = MAX_TOOL_INPUT_TEXT_BYTES - new TextEncoder()
  .encode(`${TOOL_INPUT_HEADER}\n\n${finishInstruction(5)}`).byteLength;
export const BROWSER_INPUT_FAILURE_REASONS = ['pickup_withdrawn_before_send'] as const;
export type BrowserInputFailureReason = (typeof BROWSER_INPUT_FAILURE_REASONS)[number];
/** Cheap UI preflight only; decode and current-turn ownership are still proven in main. */
export function canAttemptImageProjection(files: Array<InputImage | InputAttachment>): boolean {
  return files.length > 0 && files.length <= MAX_PROJECTED_IMAGE_COUNT && files.every(file => 'dataUrl' in file ||
    (file.size <= MAX_PROJECTED_IMAGE_SOURCE_BYTES && ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType)));
}
/** UI preflight only; main still validates the exact final transport envelope. */
export function canAttemptToolText(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= MAX_TOOL_AUTHORED_TEXT_BYTES;
}
export type InputAutomation = 'off' | 'goal' | 'loop';

/** One shared definition of a queued continuation across main-process custody and renderer UI. */
export function isFollowupInput(input: { mode: string; sessionId?: string | null; purpose?: string }): boolean {
  return input.mode === 'finish' || (input.mode === 'after-turn' && !!input.sessionId && input.purpose !== 'decision');
}

/** Finish tasks continue the chat; their old enqueue-time picker is not a new
 * model choice. Apply this projection to legacy queues too, preserving authored
 * fields for idempotent retries and keeping delivery/history on the same rule. */
export function browserInputModel(input: { mode: string; model: string | null; reasoningEffort: ReasoningEffort | null }): { model: string | null; reasoningEffort: ReasoningEffort | null } {
  return input.mode === 'finish'
    ? { model: null, reasoningEffort: null }
    : { model: input.model, reasoningEffort: input.reasoningEffort };
}
