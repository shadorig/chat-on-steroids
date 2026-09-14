import { isReasoningEffort, type ReasoningEffort } from './session.js';

export type ChatModelSelection = { model: string; reasoningEffort: ReasoningEffort | null };

/** Canonical persisted/browser selection shape. Unknown or malformed values fail closed. */
export function chatModelSelection(value: unknown): ChatModelSelection | null {
  if (!value || typeof value !== 'object') return null;
  const { model, reasoningEffort } = value as Record<string, unknown>;
  if (typeof model !== 'string' || model.length === 0 || model.trim() !== model || !/^[a-zA-Z0-9 ._-]{1,80}$/.test(model) ||
      (reasoningEffort != null && !isReasoningEffort(reasoningEffort))) return null;
  return { model, reasoningEffort: isReasoningEffort(reasoningEffort) ? reasoningEffort : null };
}
/** GPT-6 Pro is Astra. Compare exact picker names/slugs, never arbitrary substring matches. */
export function isAstraModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return /^(?:astra|gpt-?6(?:\.0)?-pro|gpt-?6-astra)$/.test(normalized) ||
    (/^(?:gpt-?)?6(?:\.0)?$/.test(normalized) && effort === 'pro');
}
export type ChatModelOption = { id: string; label: string; efforts: ReasoningEffort[]; aliases?: string[] };
export const STANDARD_COMPARISON_CONTEXT_CAP = 256_000;
export const PRO_COMPARISON_CONTEXT_CAP = 400_000;
/** Current account-wide ceiling used only by the Usage comparison projection. */
export function comparisonContextCap(models: readonly Pick<ChatModelOption, 'id' | 'efforts'>[]): number {
  return models.some(model => isProModel(model.id) || model.efforts.includes('pro'))
    ? PRO_COMPARISON_CONTEXT_CAP
    : STANDARD_COMPARISON_CONTEXT_CAP;
}
/** Pro silence policy follows the selected provider identity, including the older generation. */
export function isProModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return effort === 'pro' || isAstraModel(model, effort) || /^gpt-?\d+(?:[.-]\d+)?-pro$/.test(normalized);
}
/** Exact provider capability for browser Loop continuation between native turns. */
export function supportsAfterTurnLoop(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  return isProModel(model, effort) && !isAstraModel(model, effort);
}
/** Keep the selected generation intact; Pro is already a complete model label. */
export function chatModelDisplayLabel(label: string, effort: ReasoningEffort, effortLabel: string): string {
  if (effort === 'pro') return /\bpro$/i.test(label) ? label : `${label.replace(/\s+Sol$/i, '')} Pro`;
  return `${label} · ${effortLabel}`;
}
export type ChatModelCatalog = {
  state: 'unknown' | 'pending' | 'ready' | 'unavailable';
  requestedAt: number | null;
  observedAt: number | null;
  models: ChatModelOption[];
  error?: string;
};
