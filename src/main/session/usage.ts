import { z } from 'zod';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { listUsageSessions, readEvents } from './store.js';
import { readDurable, writeDurableSoon } from '../durable.js';
import { logInfo } from '../logger.js';
import { eventTokens } from '../../shared/session.js';
import { usageModelKey, type ModelUsage, type UsageModelTokens, type UsageOverview } from '../../shared/usage.js';
import { getChatModels } from '../chat-models.js';
import { comparisonContextCap } from '../../shared/chat-models.js';
const row = z.object({ model: z.string().min(1).max(100), scope: z.enum(['model', 'feature', 'shared']), remaining: z.number().finite().nonnegative().nullable(), remainingPercent: z.number().min(0).max(100).nullable(), resetAt: z.number().finite().positive().nullable(), windowSeconds: z.number().finite().positive().nullable() });
let limits: ModelUsage[] = [];
let latestObservedAt = 0;
const FRESH_MS = 10 * 60000;
export function observeUsage(raw: unknown, capturedAt: unknown = Date.now()): void {
  const parsed = z.array(row).max(80).parse(raw);
  const now = Date.now();
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt) || capturedAt > now + 5000 || now - capturedAt > FRESH_MS || capturedAt < latestObservedAt) return;
  // A snapshot is one account observation. Never merge old counters from another
  // account/tab into the latest response; an explicit empty snapshot clears them.
  latestObservedAt = capturedAt;
  limits = parsed.map((entry) => ({ ...entry, observedAt: capturedAt }));
}
// Cache recorded facts, not today's comparison policy. A model-catalog change can therefore
// re-project the same history at a different comparison ceiling without rereading transcripts.
const CACHE_VERSION = 5;
const cachedCall = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  model: z.string().min(1).max(100),
  reasoningEffort: z.string().max(100).nullable(),
  assumed: z.boolean(),
  count: z.number().int().positive().max(1_000_000)
});
const cachedSegment = z.object({ contextTokens: z.number().finite().nonnegative(), calls: z.array(cachedCall).max(100_000) });
const cacheRow = z.object({ id: z.string().max(64), revision: z.string().max(200), segments: z.array(cachedSegment).max(100_000) });
const cacheSchema = z.object({ version: z.literal(CACHE_VERSION), rows: z.array(cacheRow).max(100000) });
type CachedSegment = z.infer<typeof cachedSegment>;
const factCache = new Map<string, { revision: string; segments: CachedSegment[] }>();
let cacheLoaded = false;
let currentCacheFormat = false;
let cacheLoadFlight: Promise<boolean> | null = null;
type OverviewFlight = { controller: AbortController; promise: Promise<UsageOverview> };
let overviewFlight: OverviewFlight | null = null;
let warmupGeneration = 0;

async function loadFactCache(): Promise<boolean> {
  if (cacheLoaded) return currentCacheFormat;
  if (cacheLoadFlight) return cacheLoadFlight;
  cacheLoadFlight = (async () => {
    const saved = cacheSchema.safeParse(await readDurable('usage-cache'));
    if (saved.success) {
      for (const row of saved.data.rows) factCache.set(row.id, { revision: row.revision, segments: row.segments });
      currentCacheFormat = true;
    }
    cacheLoaded = true;
    return currentCacheFormat;
  })().finally(() => { cacheLoadFlight = null; });
  return cacheLoadFlight;
}

/** Shared calculation owns cancellation; one caller can never abort work another caller joined. */
export function usageOverview(): Promise<UsageOverview> {
  if (overviewFlight) return overviewFlight.promise;
  const controller = new AbortController();
  const promise = computeOverview(controller.signal).finally(() => {
    if (overviewFlight?.promise === promise) overviewFlight = null;
  });
  overviewFlight = { controller, promise };
  return promise;
}

/** Startup warms only a cache already stored in the current fact format; cold migrations stay demand-driven. */
export async function warmUsageOverview(): Promise<void> {
  const generation = warmupGeneration;
  if (!await loadFactCache() || generation !== warmupGeneration) return;
  await usageOverview();
}

/** Application shutdown owns the shared flight lifetime. */
export function cancelUsageOverview(): void {
  // Also invalidate a warmup still waiting on the small cache read; otherwise it could create a
  // brand-new overview flight after shutdown already cancelled the one it knew about.
  warmupGeneration++;
  overviewFlight?.controller.abort(new Error('Usage calculation cancelled during shutdown'));
}
function mergeModels(target: Map<string, UsageModelTokens>, rows: readonly UsageModelTokens[]): void {
  for (const row of rows) {
    const key = usageModelKey(row);
    const previous = target.get(key);
    target.set(key, { ...row,
      rawEstimatedTokens: (previous?.rawEstimatedTokens ?? 0) + row.rawEstimatedTokens,
      comparisonTokens: (previous?.comparisonTokens ?? 0) + row.comparisonTokens });
  }
}
type Attribution = Pick<UsageModelTokens, 'model' | 'reasoningEffort' | 'assumed'>;
const LEGACY: Attribution = { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true };
function attribution(raw: { model?: string; reasoningEffort?: string }, previous: Attribution): Attribution {
  const model = raw.model?.trim();
  const effort = raw.reasoningEffort?.trim();
  if (model) return { model, reasoningEffort: effort || (!previous.assumed && model === previous.model ? previous.reasoningEffort : null), assumed: false };
  if (effort) return { ...previous, reasoningEffort: effort };
  return previous;
}
async function computeOverview(signal: AbortSignal): Promise<UsageOverview> {
  signal.throwIfAborted();
  const started = performance.now();
  const contextCap = comparisonContextCap(getChatModels().models);
  let rebuilt = 0;
  await loadFactCache();
  signal.throwIfAborted();
  const sessions = await listUsageSessions();
  let dirty = false;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = new Map<string, Map<string, UsageModelTokens>>();
  const models = new Map<string, UsageModelTokens>();
  for (const session of sessions) {
    signal.throwIfAborted();
    const revision = `${timezone}:${session.updatedAt}:${session.events}:${session.estimatedTokens}`;
    let cached = factCache.get(session.id);
    if (cached?.revision !== revision) {
      // Startup and the Usage page share this one flight. Read only one changed
      // session at a time, giving interactive work a turn before each disk read.
      await yieldToEventLoop(undefined, { signal });
      rebuilt++;
      const segments: CachedSegment[] = [];
      let context = 0;
      let conversation: string | null = null;
      let selected = LEGACY;
      const calls: Array<{ day: string; attribution: Attribution }> = [];
      const countedCalls = new Set<string>();
      const finishSegment = () => {
        if (!calls.length) { context = 0; selected = LEGACY; return; }
        const grouped = new Map<string, z.infer<typeof cachedCall>>();
        for (const call of calls) {
          const key = `${call.day}\u0000${usageModelKey(call.attribution)}`;
          const previous = grouped.get(key);
          grouped.set(key, { day: call.day, ...call.attribution, count: (previous?.count ?? 0) + 1 });
        }
        segments.push({ contextTokens: context, calls: [...grouped.values()] });
        calls.length = 0; context = 0; selected = LEGACY;
      };
      const events = await readEvents(session.id);
      signal.throwIfAborted();
      for (const event of events) {
        if (event.kind === 'session_start') { finishSegment(); conversation = event.conversationId; }
        if (event.kind === 'tool_call') {
          if (countedCalls.has(event.call.callId)) continue;
          countedCalls.add(event.call.callId);
          if (!event.call.conversationId || (conversation && conversation !== event.call.conversationId)) finishSegment();
          conversation = event.call.conversationId;
        }
        // Recorded selection belongs to this frontend history, never a mutable
        // global picker or a worker's requested-but-unconfirmed spawn setting.
        if (event.kind === 'user_message' && !event.messageId?.startsWith('input:')) selected = LEGACY;
        if (event.kind !== 'user_message' || !event.messageId?.startsWith('input:')) selected = attribution(event, selected);
        context += eventTokens(event);
        if (event.kind !== 'tool_call') continue;
        const date = new Date(event.time);
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        calls.push({ day, attribution: attribution(event.call, selected) });
        if (!conversation) finishSegment();
      }
      finishSegment();
      dirty = true;
      cached = { revision, segments }; factCache.set(session.id, cached);
    }
    for (const segment of cached.segments) {
      const rawTokensPerCall = segment.contextTokens / 2;
      const comparisonTokensPerCall = Math.min(segment.contextTokens, contextCap) / 2;
      for (const call of segment.calls) {
        const projected: UsageModelTokens = { model: call.model, reasoningEffort: call.reasoningEffort,
          assumed: call.assumed,
          rawEstimatedTokens: rawTokensPerCall * call.count,
          comparisonTokens: comparisonTokensPerCall * call.count };
        const totals = days.get(call.day) ?? new Map<string, UsageModelTokens>();
        mergeModels(totals, [projected]); days.set(call.day, totals); mergeModels(models, [projected]);
      }
    }
  }
  const ids = new Set(sessions.map((session) => session.id));
  signal.throwIfAborted();
  for (const id of factCache.keys()) if (!ids.has(id)) { factCache.delete(id); dirty = true; }
  if (dirty) {
    currentCacheFormat = true;
    writeDurableSoon('usage-cache', { version: CACHE_VERSION, rows: [...factCache].map(([id, row]) => ({ id, revision: row.revision, segments: row.segments })) });
  }
  logInfo(`usage overview sessions=${sessions.length} reused=${sessions.length - rebuilt} rebuilt=${rebuilt} elapsed_ms=${Math.round(performance.now() - started)}`);
  return {
    comparisonContextCap: contextCap,
    limits: limits.filter((entry) => Date.now() - entry.observedAt <= FRESH_MS && (entry.resetAt === null || entry.resetAt > Date.now())).map((entry) => ({ ...entry })),
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => ({
      date,
      rawEstimatedTokens: [...rows.values()].reduce((sum, row) => sum + row.rawEstimatedTokens, 0),
      comparisonTokens: [...rows.values()].reduce((sum, row) => sum + row.comparisonTokens, 0),
      models: [...rows.values()]
    })),
    models: [...models.values()],
    rawEstimatedTokens: [...models.values()].reduce((sum, row) => sum + row.rawEstimatedTokens, 0),
    comparisonTokens: [...models.values()].reduce((sum, row) => sum + row.comparisonTokens, 0),
    sessions: sessions.length
  };
}
