import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { LocalProject } from '../../shared/projects.js';

export const LOCAL_PROJECT_AUTHORITY_VERSION = 2;
export const MAX_ACTIVE_PROJECTS = 200;
const MAX_PROJECT_IDENTITIES = 2_000;
const MAX_SESSION_BINDINGS = 20_000;
const MAX_CONVERSATION_BINDINGS = 20_000;
const MAX_UNRESOLVED_SENDS = 256;
const MAX_BINDINGS_PER_OPERATION = 1_000;

const projectIdSchema = z.string().uuid();
const inputIdSchema = z.string().uuid();
const sessionIdSchema = z.string().regex(/^[0-9a-z-]{8,64}$/i);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const eraSchema = z.string().uuid();
const epochSchema = z.number().int().safe().positive();
const modeSchema = z.enum(['native', 'legacy-ambiguous']);

const projectSchema = z.object({
  id: projectIdSchema,
  canonicalPath: z.string().min(1).max(32768).refine(path.isAbsolute, 'Project authority path must be absolute'),
  createdAt: z.number().finite().nonnegative(),
  ungrouped: z.boolean().optional(),
  revokedAt: z.number().finite().nonnegative().nullable()
}).strict();
const sessionBindingSchema = z.object({ sessionId: sessionIdSchema, projectId: projectIdSchema }).strict();
const conversationBindingSchema = z.object({ digest: digestSchema, projectId: projectIdSchema }).strict();
const unresolvedSendSchema = z.object({
  inputId: inputIdSchema,
  projectId: projectIdSchema,
  authorizedAt: z.number().finite().nonnegative()
}).strict();

export const authorityV2Schema = z.object({
  version: z.literal(LOCAL_PROJECT_AUTHORITY_VERSION),
  era: eraSchema,
  epoch: epochSchema,
  mode: modeSchema,
  projects: z.array(projectSchema).max(MAX_PROJECT_IDENTITIES),
  sessionBindings: z.array(sessionBindingSchema).max(MAX_SESSION_BINDINGS),
  conversationBindings: z.array(conversationBindingSchema).max(MAX_CONVERSATION_BINDINGS),
  unresolvedProjectSends: z.array(unresolvedSendSchema).max(MAX_UNRESOLVED_SENDS)
}).strict();

// Exact v1 shape, retained only to migrate the already-written development/release state safely.
const legacyProjectSchema = z.object({
  projectId: projectIdSchema,
  name: z.string().min(1).max(160),
  canonicalPath: z.string().min(1).max(32768).refine(path.isAbsolute),
  createdAt: z.number().finite().nonnegative()
}).strict();
const legacyLineageSchema = z.object({
  projectId: projectIdSchema,
  sessionIds: z.array(sessionIdSchema).min(1).max(1_000),
  conversationDigests: z.array(digestSchema).max(1_000)
}).strict();
const legacyPendingSchema = z.object({
  inputId: inputIdSchema,
  projectId: projectIdSchema,
  authorizedAt: z.number().finite().nonnegative()
}).strict();
export const authorityV1Schema = z.object({
  version: z.literal(1),
  epoch: epochSchema,
  mode: modeSchema,
  projects: z.array(legacyProjectSchema).max(10_200),
  lineages: z.array(legacyLineageSchema).max(10_000),
  revokedProjectIds: z.array(projectIdSchema).max(10_000),
  pendingProjectInputs: z.array(legacyPendingSchema).max(1_000)
}).strict();

export type ProjectPolicyErrorCode =
  | 'authority-unavailable'
  | 'project-unavailable'
  | 'identity-conflict'
  | 'send-unresolved'
  | 'legacy-ambiguous'
  | 'authority-era-retired';

export class ProjectPolicyError extends Error {
  constructor(readonly code: ProjectPolicyErrorCode, message: string) {
    super(message);
    this.name = 'ProjectPolicyError';
  }
}

export interface ProjectRecord {
  id: string;
  canonicalPath: string;
  createdAt: number;
  ungrouped?: boolean;
  revokedAt: number | null;
}
export interface SessionProjectBinding { sessionId: string; projectId: string }
export interface ConversationProjectBinding { digest: string; projectId: string }
export interface UnresolvedProjectSend { inputId: string; projectId: string; authorizedAt: number }

export interface AuthorityState {
  era: string;
  epoch: number;
  mode: 'native' | 'legacy-ambiguous';
  projects: readonly ProjectRecord[];
  projectById: ReadonlyMap<string, ProjectRecord>;
  sessionBindings: readonly SessionProjectBinding[];
  projectBySessionId: ReadonlyMap<string, string>;
  conversationBindings: readonly ConversationProjectBinding[];
  projectByConversationDigest: ReadonlyMap<string, string>;
  unresolvedProjectSends: readonly UnresolvedProjectSend[];
  unresolvedProjectSendById: ReadonlyMap<string, UnresolvedProjectSend>;
}

export interface AuthorityPrincipal {
  sessionId?: string | null;
  conversationId?: string | null;
}

const compareCanonical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export const sameCanonicalPath = (left: string, right: string): boolean => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;

export function conversationDigest(conversationId: string): string {
  const parsed = z.string().min(1).max(300).parse(conversationId);
  return createHash('sha256')
    .update('chat-on-steroids:project-authority:v1\0')
    .update(parsed)
    .digest('hex');
}

export function makeAuthorityState(input: {
  era: string;
  epoch: number;
  mode: AuthorityState['mode'];
  projects?: readonly ProjectRecord[];
  sessionBindings?: readonly SessionProjectBinding[];
  conversationBindings?: readonly ConversationProjectBinding[];
  unresolvedProjectSends?: readonly UnresolvedProjectSend[];
}): AuthorityState {
  const era = eraSchema.parse(input.era);
  const epoch = epochSchema.parse(input.epoch);
  const mode = modeSchema.parse(input.mode);
  const projects = Object.freeze((input.projects ?? []).map(project => Object.freeze(projectSchema.parse(project)))
    .sort((a, b) => compareCanonical(a.id, b.id)));
  if (projects.length > MAX_PROJECT_IDENTITIES) throw new Error('Local Project identity limit reached');
  const projectById = new Map<string, ProjectRecord>();
  const activePaths = new Set<string>();
  let activeCount = 0;
  for (const project of projects) {
    if (projectById.has(project.id)) throw new Error('Local Project authority contains a duplicate project id');
    projectById.set(project.id, project);
    if (project.revokedAt !== null) continue;
    activeCount += 1;
    const key = process.platform === 'win32' ? project.canonicalPath.toLowerCase() : project.canonicalPath;
    if (activePaths.has(key)) throw new Error('Local Project authority contains duplicate active paths');
    activePaths.add(key);
  }
  if (activeCount > MAX_ACTIVE_PROJECTS) throw new Error('Local Project active-project limit reached');

  const sessionBindings = Object.freeze((input.sessionBindings ?? [])
    .map(binding => Object.freeze(sessionBindingSchema.parse(binding)))
    .sort((a, b) => compareCanonical(a.sessionId, b.sessionId)));
  if (sessionBindings.length > MAX_SESSION_BINDINGS) throw new Error('Local Project session-binding limit reached');
  const projectBySessionId = new Map<string, string>();
  for (const binding of sessionBindings) {
    if (!projectById.has(binding.projectId)) throw new Error('Session binding references an unknown project');
    if (projectBySessionId.has(binding.sessionId)) throw new Error('Local Project authority contains a duplicate session binding');
    projectBySessionId.set(binding.sessionId, binding.projectId);
  }

  const conversationBindings = Object.freeze((input.conversationBindings ?? [])
    .map(binding => Object.freeze(conversationBindingSchema.parse(binding)))
    .sort((a, b) => compareCanonical(a.digest, b.digest)));
  if (conversationBindings.length > MAX_CONVERSATION_BINDINGS) throw new Error('Local Project conversation-binding limit reached');
  const projectByConversationDigest = new Map<string, string>();
  for (const binding of conversationBindings) {
    if (!projectById.has(binding.projectId)) throw new Error('Conversation binding references an unknown project');
    if (projectByConversationDigest.has(binding.digest)) throw new Error('Local Project authority contains a duplicate conversation binding');
    projectByConversationDigest.set(binding.digest, binding.projectId);
  }

  const unresolvedProjectSends = Object.freeze((input.unresolvedProjectSends ?? [])
    .map(send => Object.freeze(unresolvedSendSchema.parse(send)))
    .sort((a, b) => compareCanonical(a.inputId, b.inputId)));
  if (unresolvedProjectSends.length > MAX_UNRESOLVED_SENDS) throw new Error('Unresolved Local Project send limit reached');
  const unresolvedProjectSendById = new Map<string, UnresolvedProjectSend>();
  for (const send of unresolvedProjectSends) {
    if (!projectById.has(send.projectId)) throw new Error('Unresolved project send references an unknown project');
    if (unresolvedProjectSendById.has(send.inputId)) throw new Error('Local Project authority contains a duplicate unresolved send');
    unresolvedProjectSendById.set(send.inputId, send);
  }

  return {
    era,
    epoch,
    mode,
    projects,
    projectById,
    sessionBindings,
    projectBySessionId,
    conversationBindings,
    projectByConversationDigest,
    unresolvedProjectSends,
    unresolvedProjectSendById
  };
}

export function withEpoch(state: AuthorityState, epoch: number): AuthorityState {
  return makeAuthorityState({ ...state, epoch });
}

export function persistedAuthority(state: AuthorityState): z.infer<typeof authorityV2Schema> {
  return {
    version: LOCAL_PROJECT_AUTHORITY_VERSION,
    era: state.era,
    epoch: state.epoch,
    mode: state.mode,
    projects: state.projects.map(project => ({ ...project })),
    sessionBindings: state.sessionBindings.map(binding => ({ ...binding })),
    conversationBindings: state.conversationBindings.map(binding => ({ ...binding })),
    unresolvedProjectSends: state.unresolvedProjectSends.map(send => ({ ...send }))
  };
}

export function stateFromPersisted(value: unknown): AuthorityState {
  const data = authorityV2Schema.parse(value);
  return makeAuthorityState(data);
}

export function serializeAuthority(state: AuthorityState): string {
  return JSON.stringify(persistedAuthority(state));
}

export function projectIdForPrincipal(state: AuthorityState, principal: AuthorityPrincipal): string | null {
  const bySession = principal.sessionId ? state.projectBySessionId.get(principal.sessionId) ?? null : null;
  const digest = principal.conversationId ? conversationDigest(principal.conversationId) : null;
  const byConversation = digest ? state.projectByConversationDigest.get(digest) ?? null : null;
  if (bySession && byConversation && bySession !== byConversation) {
    throw new ProjectPolicyError('identity-conflict', 'Exact caller identities belong to different Local Projects');
  }
  return bySession ?? byConversation;
}

export function bindProjectPrincipals(
  state: AuthorityState,
  input: {
    sessionId?: string | null;
    conversationIds?: readonly string[];
    requestedProjectId?: string;
    allowRevokedProject?: boolean;
    requireExistingPrincipal?: boolean;
  }
): { state: AuthorityState; projectId: string | null; changed: boolean } {
  const sessionId = input.sessionId ? sessionIdSchema.parse(input.sessionId) : null;
  const conversationIds = input.conversationIds ?? [];
  if (conversationIds.length > MAX_BINDINGS_PER_OPERATION) throw new Error('Local Project binding operation is too large');
  const digests = [...new Set(conversationIds.map(conversationDigest))];
  const requestedProjectId = input.requestedProjectId ? projectIdSchema.parse(input.requestedProjectId) : null;
  const existingProjects = new Set<string>();
  if (sessionId) {
    const project = state.projectBySessionId.get(sessionId);
    if (project) existingProjects.add(project);
  }
  for (const digest of digests) {
    const project = state.projectByConversationDigest.get(digest);
    if (project) existingProjects.add(project);
  }
  if (existingProjects.size > 1 || (requestedProjectId && [...existingProjects].some(id => id !== requestedProjectId))) {
    throw new ProjectPolicyError('identity-conflict', 'Local Project principal already belongs to another project');
  }
  if (input.requireExistingPrincipal && existingProjects.size === 0) {
    throw new ProjectPolicyError('identity-conflict', 'No supplied principal proves the completed Local Project binding');
  }
  const projectId = requestedProjectId ?? existingProjects.values().next().value ?? null;
  if (!projectId) return { state, projectId: null, changed: false };
  const project = state.projectById.get(projectId);
  if (!project) throw new ProjectPolicyError('authority-unavailable', 'Local Project identity is missing from authority state');

  const missingSession = !!sessionId && !state.projectBySessionId.has(sessionId);
  const missingDigests = digests.filter(digest => !state.projectByConversationDigest.has(digest));
  const changed = missingSession || missingDigests.length > 0;
  if (!changed) return { state, projectId, changed: false };
  if (project.revokedAt !== null && !input.allowRevokedProject) {
    throw new ProjectPolicyError('project-unavailable', 'Local Project has been removed');
  }
  if (state.sessionBindings.length + (missingSession ? 1 : 0) > MAX_SESSION_BINDINGS ||
      state.conversationBindings.length + missingDigests.length > MAX_CONVERSATION_BINDINGS) {
    throw new Error('Local Project binding limit reached');
  }
  return {
    state: makeAuthorityState({
      ...state,
      sessionBindings: missingSession
        ? [...state.sessionBindings, { sessionId: sessionId!, projectId }]
        : state.sessionBindings,
      conversationBindings: missingDigests.length
        ? [...state.conversationBindings, ...missingDigests.map(digest => ({ digest, projectId }))]
        : state.conversationBindings
    }),
    projectId,
    changed: true
  };
}

export function fenceProjectSend(state: AuthorityState, inputId: string, projectId: string): { state: AuthorityState; changed: boolean } {
  const id = inputIdSchema.parse(inputId);
  const project = projectIdSchema.parse(projectId);
  const existing = state.unresolvedProjectSendById.get(id);
  if (existing) {
    if (existing.projectId !== project) throw new ProjectPolicyError('identity-conflict', 'Unresolved Local Project send changed projects');
    return { state, changed: false };
  }
  const identity = state.projectById.get(project);
  if (!identity || identity.revokedAt !== null) throw new ProjectPolicyError('project-unavailable', 'Local Project is unavailable');
  if (state.unresolvedProjectSends.length >= MAX_UNRESOLVED_SENDS) throw new Error('Unresolved Local Project send limit reached');
  return {
    state: makeAuthorityState({
      ...state,
      unresolvedProjectSends: [...state.unresolvedProjectSends, { inputId: id, projectId: project, authorizedAt: Date.now() }]
    }),
    changed: true
  };
}

export function abortProjectSend(state: AuthorityState, inputId: string): { state: AuthorityState; changed: boolean } {
  const id = inputIdSchema.parse(inputId);
  if (!state.unresolvedProjectSendById.has(id)) return { state, changed: false };
  return {
    state: makeAuthorityState({
      ...state,
      unresolvedProjectSends: state.unresolvedProjectSends.filter(send => send.inputId !== id)
    }),
    changed: true
  };
}

export function settleProjectSend(state: AuthorityState, input: {
  inputId: string;
  projectId: string;
  sessionId: string;
  conversationIds: readonly string[];
}): { state: AuthorityState; changed: boolean } {
  const id = inputIdSchema.parse(input.inputId);
  const projectId = projectIdSchema.parse(input.projectId);
  const pending = state.unresolvedProjectSendById.get(id);
  if (pending && pending.projectId !== projectId) {
    throw new ProjectPolicyError('identity-conflict', 'Local Project receipt does not match its authorized send');
  }
  const bound = bindProjectPrincipals(state, {
    sessionId: input.sessionId,
    conversationIds: input.conversationIds,
    requestedProjectId: projectId,
    allowRevokedProject: !!pending,
    requireExistingPrincipal: !pending
  });
  if (!pending) return { state: bound.state, changed: bound.changed };
  return {
    state: makeAuthorityState({
      ...bound.state,
      unresolvedProjectSends: bound.state.unresolvedProjectSends.filter(send => send.inputId !== id)
    }),
    changed: true
  };
}

export function addProjectRecord(state: AuthorityState, project: ProjectRecord): { state: AuthorityState; project: ProjectRecord; changed: boolean } {
  const existing = state.projects.find(candidate => candidate.revokedAt === null && sameCanonicalPath(candidate.canonicalPath, project.canonicalPath));
  if (existing) {
    if (!existing.ungrouped) return { state, project: existing, changed: false };
    const restored = { ...existing, ungrouped: false };
    return {
      state: makeAuthorityState({
        ...state,
        projects: state.projects.map(candidate => candidate.id === existing.id ? restored : candidate)
      }),
      project: restored,
      changed: true
    };
  }
  const activeCount = state.projects.filter(candidate => candidate.revokedAt === null).length;
  if (activeCount >= MAX_ACTIVE_PROJECTS || state.projects.length >= MAX_PROJECT_IDENTITIES) {
    throw new Error('Local Project limit reached');
  }
  const parsed = projectSchema.parse(project);
  return {
    state: makeAuthorityState({ ...state, projects: [...state.projects, parsed] }),
    project: parsed,
    changed: true
  };
}

export function ungroupProjectRecord(state: AuthorityState, projectId: string): { state: AuthorityState; changed: boolean } {
  const id = projectIdSchema.parse(projectId);
  const project = state.projectById.get(id);
  if (!project || project.revokedAt !== null) throw new ProjectPolicyError('project-unavailable', 'Local Project is unavailable');
  if (project.ungrouped) return { state, changed: false };
  return {
    state: makeAuthorityState({
      ...state,
      projects: state.projects.map(candidate => candidate.id === id ? { ...candidate, ungrouped: true } : candidate)
    }),
    changed: true
  };
}

export function revokeProjectRecord(state: AuthorityState, projectId: string, revokedAt = Date.now()): { state: AuthorityState; changed: boolean } {
  const id = projectIdSchema.parse(projectId);
  const project = state.projectById.get(id);
  if (!project || project.revokedAt !== null) return { state, changed: false };
  return {
    state: makeAuthorityState({
      ...state,
      projects: state.projects.map(candidate => candidate.id === id ? { ...candidate, revokedAt } : candidate)
    }),
    changed: true
  };
}

export function activeProjects(state: AuthorityState): LocalProject[] {
  return state.projects
    .filter(project => project.revokedAt === null)
    .map(project => ({
      id: project.id,
      name: (path.basename(project.canonicalPath) || project.canonicalPath).slice(0, 160),
      path: project.canonicalPath,
      createdAt: project.createdAt,
      ...(project.ungrouped ? { ungrouped: true } : {})
    }))
    .sort((a, b) => a.createdAt - b.createdAt || compareCanonical(a.id, b.id));
}

export function projectCallerIdentityRequired(state: AuthorityState): boolean {
  return state.mode === 'legacy-ambiguous' || state.sessionBindings.length > 0 ||
    state.conversationBindings.length > 0 || state.unresolvedProjectSends.length > 0;
}

export function projectBrowserBridgeRequired(state: AuthorityState): boolean {
  return projectCallerIdentityRequired(state) || state.projects.some(project => project.revokedAt === null);
}

export function migrateAuthorityV1(raw: z.infer<typeof authorityV1Schema>, era: string): AuthorityState {
  const revoked = new Set(raw.revokedProjectIds);
  const sessionBindings: SessionProjectBinding[] = [];
  const conversationBindings: ConversationProjectBinding[] = [];
  for (const lineage of raw.lineages) {
    for (const sessionId of lineage.sessionIds) sessionBindings.push({ sessionId, projectId: lineage.projectId });
    for (const digest of lineage.conversationDigests) conversationBindings.push({ digest, projectId: lineage.projectId });
  }
  if (raw.epoch >= Number.MAX_SAFE_INTEGER) throw new Error('Local Project authority epoch is exhausted');
  return makeAuthorityState({
    era,
    epoch: raw.epoch + 1,
    mode: raw.mode,
    projects: raw.projects.map(project => ({
      id: project.projectId,
      canonicalPath: project.canonicalPath,
      createdAt: project.createdAt,
      ungrouped: false,
      revokedAt: revoked.has(project.projectId) ? 0 : null
    })),
    sessionBindings,
    conversationBindings,
    unresolvedProjectSends: raw.pendingProjectInputs
  });
}
