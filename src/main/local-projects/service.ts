import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Root } from '../../shared/types.js';
import type { LocalProject } from '../../shared/projects.js';
import { getConfig, LEGACY_PROJECT_AUTHORITY_ERA, updateConfig } from '../config.js';
import { resolvePath } from '../sandbox.js';
import { resetWorkspaces } from '../workspace.js';
import {
  bindSessionProject,
  configureSessionProjectAuthority,
  indexedSessions
} from '../session/store.js';
import { readLegacyProjectCatalog } from './legacy.js';
import {
  abortProjectSend as abortProjectSendState,
  activeProjects,
  addProjectRecord,
  bindProjectPrincipals,
  fenceProjectSend,
  makeAuthorityState,
  migrateAuthorityV1,
  projectBrowserBridgeRequired as stateBrowserBridgeRequired,
  projectCallerIdentityRequired as stateCallerIdentityRequired,
  projectIdForPrincipal as stateProjectIdForPrincipal,
  ProjectPolicyError,
  revokeProjectRecord,
  sameCanonicalPath,
  settleProjectSend as settleProjectSendState,
  ungroupProjectRecord,
  withEpoch,
  type AuthorityPrincipal,
  type AuthorityState
} from './model.js';
import {
  clearRecoveryIntent,
  commitAuthority,
  initLocalProjectStore,
  installInitialAuthority,
  installResetAuthority,
  readLegacyAuthorityV1,
  readLegacyResetIntent,
  resetLocalProjectStoreForTests,
  restoreNativeAuthority,
  retireLegacyProjectSecurityFiles,
  salvageAuthorityEpoch,
  writeResetIntent,
  type RecoveryIntent
} from './store.js';

export { ProjectPolicyError } from './model.js';
export type { ProjectPolicyErrorCode } from './model.js';

export interface ProjectAuthoritySnapshot {
  readonly era: string;
  readonly epoch: number;
}

export interface ProjectAuthorityStatus {
  status: 'ready' | 'degraded' | 'unavailable';
  detail: string | null;
}

type RuntimeAuthority =
  | { status: 'absent' }
  | { status: 'uninitialized' }
  | { status: 'unavailable'; error: Error }
  | { status: 'ready'; state: AuthorityState; snapshot: ProjectAuthoritySnapshot };

let runtime: RuntimeAuthority = { status: 'absent' };
let pinned = new WeakMap<object, AuthorityState>();
let mutationQueue: Promise<void> = Promise.resolve();

function currentState(): AuthorityState {
  if (runtime.status === 'ready') return runtime.state;
  if (runtime.status === 'unavailable') {
    throw new ProjectPolicyError('authority-unavailable', runtime.error.message);
  }
  if (runtime.status === 'uninitialized') {
    throw new ProjectPolicyError('authority-unavailable', 'Local Project authority has not been restored');
  }
  throw new ProjectPolicyError('authority-unavailable', 'Local Project authority is not part of this runtime');
}

function publish(state: AuthorityState): void {
  const snapshot = Object.freeze({ era: state.era, epoch: state.epoch });
  pinned.set(snapshot, state);
  runtime = { status: 'ready', state, snapshot };
}

function markUnavailable(error: unknown): never {
  const cause = error instanceof Error ? error : new Error(String(error));
  runtime = { status: 'unavailable', error: cause };
  throw cause;
}

function withMutation<T>(operation: () => Promise<T> | T): Promise<T> {
  const run = mutationQueue.then(operation);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function commitCandidate(previous: AuthorityState, candidate: AuthorityState): Promise<AuthorityState> {
  if (candidate === previous) return previous;
  if (previous.epoch >= Number.MAX_SAFE_INTEGER) throw new Error('Local Project authority epoch is exhausted');
  const next = withEpoch(candidate, previous.epoch + 1);
  try {
    await commitAuthority(previous, next);
  } catch (error) {
    return markUnavailable(error);
  }
  publish(next);
  return next;
}

function activeProject(state: AuthorityState, projectId: string) {
  const project = state.projectById.get(projectId);
  if (!project) throw new ProjectPolicyError('authority-unavailable', 'Local Project identity is missing from authority state');
  if (project.revokedAt !== null) throw new ProjectPolicyError('project-unavailable', 'Local Project has been removed');
  return project;
}

async function resolveProjectDirectory(
  project: { canonicalPath: string },
  roots: readonly Root[]
): Promise<{ virtual: string; real: string }> {
  try {
    const resolved = await resolvePath(roots, project.canonicalPath);
    if (!sameCanonicalPath(resolved.real, project.canonicalPath) || !(await fs.stat(resolved.real)).isDirectory()) {
      throw new Error('not the same directory');
    }
    return { virtual: resolved.virtual, real: resolved.real };
  } catch {
    throw new ProjectPolicyError('project-unavailable', 'Local Project folder is unavailable');
  }
}

async function ensureConfigEra(era: string, clearRoots = false, replaceExistingEra = false): Promise<void> {
  const current = getConfig();
  if (!replaceExistingEra && current.projectAuthorityEra !== null && current.projectAuthorityEra !== era) {
    throw new Error('Config and Local Project authority belong to different security eras');
  }
  if (current.projectAuthorityEra === era && (!clearRoots || current.roots.length === 0)) return;
  await updateConfig(config => ({
    ...config,
    ...(clearRoots ? { roots: [] } : {}),
    projectAuthorityEra: era
  }));
}

async function finishRecovery(intent: RecoveryIntent, restored?: AuthorityState): Promise<AuthorityState> {
  if (intent.operation === 'activate-local-project-authority') {
    if (!restored || restored.era !== intent.targetEra || restored.epoch !== intent.targetEpoch) {
      throw new Error('Interrupted Local Project activation has no exact committed target');
    }
    await ensureConfigEra(intent.targetEra);
    await clearRecoveryIntent(intent);
    return restored;
  }

  await ensureConfigEra(intent.targetEra, true, true);
  resetWorkspaces();
  const target = restored?.era === intent.targetEra && restored.epoch === intent.targetEpoch
    ? restored
    : makeAuthorityState({ era: intent.targetEra, epoch: intent.targetEpoch, mode: 'native' });
  if (target !== restored) await installResetAuthority(target, intent);
  await clearRecoveryIntent(intent);
  return target;
}

async function activateInitialState(state: AuthorityState): Promise<void> {
  const intent: RecoveryIntent = {
    operation: 'activate-local-project-authority',
    targetEra: state.era,
    targetEpoch: state.epoch
  };
  await installInitialAuthority(state);
  await ensureConfigEra(state.era);
  await clearRecoveryIntent(intent);
  publish(state);
}

async function migrateLegacyCatalog(): Promise<AuthorityState> {
  const catalog = await readLegacyProjectCatalog();
  if (catalog.format === 'current-v1') {
    throw new Error('Current Local Project catalog exists but its authority records are missing');
  }
  const summaries = await indexedSessions();
  const hasProjectedProject = summaries.some(summary => !!summary.projectId);
  const ambiguous = catalog.projects.length > 0 || hasProjectedProject;
  let state = makeAuthorityState({
    era: randomUUID(),
    epoch: 1,
    mode: ambiguous ? 'legacy-ambiguous' : 'native',
    projects: catalog.projects.map(project => ({
      id: project.id,
      canonicalPath: project.path,
      createdAt: project.createdAt,
      ...(project.ungrouped ? { ungrouped: true } : {}),
      revokedAt: null
    }))
  });
  for (const summary of summaries) {
    if (!summary.projectId || !state.projectById.has(summary.projectId)) continue;
    const bound = bindProjectPrincipals(state, {
      sessionId: summary.id,
      conversationIds: summary.chatIds,
      requestedProjectId: summary.projectId
    });
    state = bound.state;
  }
  return state;
}

export function initLocalProjects(userDataDir: string): void {
  initLocalProjectStore(userDataDir);
  runtime = { status: 'uninitialized' };
  configureSessionProjectAuthority({
    projectForPrincipal: principal => projectIdForPrincipal(principal),
    retainLineage: input => retainProjectBindings(input)
  });
}

export function restoreLocalProjects(): Promise<void> {
  return withMutation(async () => {
    if (runtime.status === 'ready') return;
    try {
      if (await readLegacyResetIntent()) {
        const intent: RecoveryIntent = {
          operation: 'reset-local-project-security',
          targetEra: randomUUID(),
          targetEpoch: (await salvageAuthorityEpoch()) + 1
        };
        await writeResetIntent(intent);
        publish(await finishRecovery(intent));
        await retireLegacyProjectSecurityFiles();
        return;
      }

      const native = await restoreNativeAuthority();
      if (native) {
        const state = native.recovery ? await finishRecovery(native.recovery, native.state) : native.state;
        if (!native.recovery) {
          if (getConfig().projectAuthorityEra !== state.era) {
            throw new Error('Config and Local Project authority belong to different security eras');
          }
        }
        publish(state);
        return;
      }

      const legacy = await readLegacyAuthorityV1();
      if (legacy) {
        const configuredEra = getConfig().projectAuthorityEra;
        if (configuredEra && configuredEra !== LEGACY_PROJECT_AUTHORITY_ERA) {
          throw new Error('Legacy Local Project authority conflicts with the configured security era');
        }
        const state = migrateAuthorityV1(legacy, configuredEra ?? LEGACY_PROJECT_AUTHORITY_ERA);
        await activateInitialState(state);
        await retireLegacyProjectSecurityFiles();
        return;
      }

      if (getConfig().projectAuthorityEra !== null) {
        throw new Error('Previously initialized Local Project security records are missing');
      }

      const initial = await migrateLegacyCatalog();
      await activateInitialState(initial);
      await retireLegacyProjectSecurityFiles();
    } catch (error) {
      markUnavailable(error);
    }
  });
}

export function projectAuthorityStatus(): ProjectAuthorityStatus {
  if (runtime.status === 'absent') return { status: 'ready', detail: null };
  if (runtime.status === 'ready') {
    if (runtime.state.mode === 'legacy-ambiguous') {
      return {
        status: 'degraded',
        detail: 'Legacy Local Project history cannot prove which older chats were unbound. Known project chats remain narrowed; other filesystem calls stay blocked until Local Project security is reset.'
      };
    }
    if (runtime.state.unresolvedProjectSends.length > 0) {
      return {
        status: 'degraded',
        detail: 'A Local Project message is awaiting exact browser conversation binding. Reconnect the companion; if the send cannot be recovered, reset Local Project security.'
      };
    }
    return { status: 'ready', detail: null };
  }
  return {
    status: 'unavailable',
    detail: runtime.status === 'unavailable'
      ? 'Local Project authorization could not be restored safely.'
      : 'Local Project authorization has not finished initializing.'
  };
}

export async function readLocalProjectAuthority(): Promise<{
  era: string;
  epoch: number;
  mode: AuthorityState['mode'];
  projects: readonly LocalProject[];
  sessionBindings: AuthorityState['sessionBindings'];
  conversationBindings: AuthorityState['conversationBindings'];
  revokedProjectIds: readonly string[];
  unresolvedProjectSends: AuthorityState['unresolvedProjectSends'];
}> {
  const state = currentState();
  return {
    era: state.era,
    epoch: state.epoch,
    mode: state.mode,
    projects: activeProjects(state),
    sessionBindings: state.sessionBindings,
    conversationBindings: state.conversationBindings,
    revokedProjectIds: state.projects.filter(project => project.revokedAt !== null).map(project => project.id),
    unresolvedProjectSends: state.unresolvedProjectSends
  };
}

export async function projectCallerIdentityRequired(): Promise<boolean> {
  if (runtime.status === 'absent') return false;
  return stateCallerIdentityRequired(currentState());
}

export async function projectBrowserBridgeRequired(): Promise<boolean> {
  if (runtime.status === 'absent') return false;
  return stateBrowserBridgeRequired(currentState());
}

export function pinProjectAuthority(): ProjectAuthoritySnapshot | null {
  if (runtime.status === 'absent') return null;
  if (runtime.status !== 'ready') currentState();
  return runtime.status === 'ready' ? runtime.snapshot : null;
}

export function projectIdForPrincipal(principal: AuthorityPrincipal): string | null {
  if (runtime.status === 'absent') return null;
  return stateProjectIdForPrincipal(currentState(), principal);
}

export function currentProjectAuthorityEra(): string | null {
  return runtime.status === 'ready' ? runtime.state.era : null;
}

export function retainProjectBindings(input: {
  sessionId: string;
  conversationIds: readonly string[];
  requestedProjectId?: string;
}): Promise<string | null> {
  return withMutation(async () => {
    const previous = currentState();
    const bound = bindProjectPrincipals(previous, input);
    if (bound.changed) await commitCandidate(previous, bound.state);
    return bound.projectId;
  });
}

export async function assignSessionProject(sessionId: string, projectId: string): Promise<void> {
  const state = currentState();
  await resolveProjectDirectory(activeProject(state, projectId), getConfig().roots);
  await bindSessionProject(sessionId, projectId);
}

/**
 * Existing destinations are bound before Send with no unresolved fence. Only a fresh ChatGPT chat
 * whose native conversation id does not exist yet creates global ambiguity.
 */
export function authorizeProjectSend(input: {
  inputId: string;
  projectId: string;
  authorityEra?: string | null;
  sessionId?: string | null;
  conversationId: string | null;
}): Promise<void> {
  return withMutation(async () => {
    const previous = currentState();
    if (input.authorityEra && input.authorityEra !== previous.era) {
      throw new ProjectPolicyError('authority-era-retired', 'Local Project message belongs to a retired security era');
    }
    const project = activeProject(previous, input.projectId);
    await resolveProjectDirectory(project, getConfig().roots);
    if (input.conversationId) {
      const bound = bindProjectPrincipals(previous, {
        sessionId: input.sessionId,
        conversationIds: [input.conversationId],
        requestedProjectId: input.projectId
      });
      if (bound.changed) await commitCandidate(previous, bound.state);
      return;
    }
    const fenced = fenceProjectSend(previous, input.inputId, input.projectId);
    if (fenced.changed) await commitCandidate(previous, fenced.state);
  });
}

/** Exact proof that Send was never attempted removes only that fresh-send ambiguity. */
export function abortProjectSend(inputId: string, authorityEra?: string | null): Promise<void> {
  return withMutation(async () => {
    const previous = currentState();
    if (authorityEra && authorityEra !== previous.era) return;
    const aborted = abortProjectSendState(previous, inputId);
    if (aborted.changed) await commitCandidate(previous, aborted.state);
  });
}

/** Exact receipt transition: bind destination principals and retire its fence in one ledger epoch. */
export function settleProjectSend(input: {
  inputId: string;
  projectId: string;
  authorityEra?: string | null;
  sessionId: string;
  conversationIds: readonly string[];
}): Promise<void> {
  return withMutation(async () => {
    const previous = currentState();
    if (input.authorityEra && input.authorityEra !== previous.era) {
      throw new ProjectPolicyError('authority-era-retired', 'Local Project receipt belongs to a retired security era');
    }
    const settled = settleProjectSendState(previous, input);
    if (settled.changed) await commitCandidate(previous, settled.state);
  });
}

export async function resolveAvailableProjectDirectory(projectId: string): Promise<{ virtual: string; real: string }> {
  const state = currentState();
  return resolveProjectDirectory(activeProject(state, projectId), getConfig().roots);
}

export function listLocalProjects(): LocalProject[] {
  return activeProjects(currentState());
}

export function addLocalProject(folderPath: string): Promise<LocalProject> {
  return withMutation(async () => {
    if (!path.isAbsolute(folderPath)) throw new Error('Choose an absolute project folder');
    const resolved = await resolvePath(getConfig().roots, folderPath);
    if (!(await fs.stat(resolved.real)).isDirectory()) throw new Error('Choose a project folder, not a file');
    const previous = currentState();
    const added = addProjectRecord(previous, {
      id: randomUUID(),
      canonicalPath: resolved.real,
      createdAt: Date.now(),
      ungrouped: false,
      revokedAt: null
    });
    if (added.changed) await commitCandidate(previous, added.state);
    return activeProjects(added.changed ? currentState() : previous).find(project => project.id === added.project.id)!;
  });
}

/** Hide the sidebar grouping without changing the narrower authority of existing chats. */
export function removeLocalProject(projectId: string): Promise<LocalProject> {
  return withMutation(async () => {
    const previous = currentState();
    const removed = ungroupProjectRecord(previous, projectId);
    if (removed.changed) await commitCandidate(previous, removed.state);
    const state = removed.changed ? currentState() : previous;
    return activeProjects(state).find(project => project.id === projectId)!;
  });
}

export function revokeLocalProject(projectId: string): Promise<boolean> {
  return withMutation(async () => {
    const previous = currentState();
    if (!previous.projectById.has(projectId)) return false;
    const revoked = revokeProjectRecord(previous, projectId);
    if (revoked.changed) await commitCandidate(previous, revoked.state);
    return true;
  });
}

export function resetLocalProjectSecurity(): Promise<void> {
  return withMutation(async () => {
    try {
      const epoch = await salvageAuthorityEpoch();
      if (epoch >= Number.MAX_SAFE_INTEGER) throw new Error('Local Project authority epoch is exhausted');
      const intent: RecoveryIntent = {
        operation: 'reset-local-project-security',
        targetEra: randomUUID(),
        targetEpoch: epoch + 1
      };
      await writeResetIntent(intent);
      publish(await finishRecovery(intent));
      await retireLegacyProjectSecurityFiles();
    } catch (error) {
      markUnavailable(error);
    }
  });
}

export async function resolveCallerProjectScope(
  snapshot: ProjectAuthoritySnapshot,
  roots: readonly Root[],
  caller: { sessionId?: string | null; conversationId: string | null }
): Promise<{ virtual: string; real: string } | null> {
  const state = pinned.get(snapshot as object);
  if (!state) throw new ProjectPolicyError('authority-unavailable', 'Local Project authority snapshot is invalid');
  const projectId = stateProjectIdForPrincipal(state, caller);
  if (!projectId) {
    if (state.mode === 'legacy-ambiguous') {
      throw new ProjectPolicyError('legacy-ambiguous', 'Legacy Local Project history cannot prove that this caller was unbound');
    }
    if (state.unresolvedProjectSends.length > 0) {
      throw new ProjectPolicyError('send-unresolved', 'A project-bearing browser send is awaiting exact conversation binding');
    }
    return null;
  }
  return resolveProjectDirectory(activeProject(state, projectId), roots);
}

export async function resolveSessionProjectDirectory(sessionId: string): Promise<{ virtual: string; real: string } | null> {
  const snapshot = pinProjectAuthority();
  if (!snapshot || !projectIdForPrincipal({ sessionId })) return null;
  return resolveCallerProjectScope(snapshot, getConfig().roots, { sessionId, conversationId: null });
}

export function resetLocalProjectsForTests(): void {
  runtime = { status: 'absent' };
  pinned = new WeakMap<object, AuthorityState>();
  mutationQueue = Promise.resolve();
  configureSessionProjectAuthority(null);
  resetLocalProjectStoreForTests();
}
