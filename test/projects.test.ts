import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browserBridgeRequired } from '../src/main/browser-bridge-policy.js';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  addLocalProject,
  assignSessionProject,
  initLocalProjects,
  listLocalProjects,
  pinProjectAuthority,
  projectAuthorityStatus,
  projectIdForPrincipal,
  readLocalProjectAuthority,
  removeLocalProject,
  resetLocalProjectSecurity,
  resetLocalProjectsForTests,
  resolveSessionProjectDirectory,
  resolveCallerProjectScope,
  retainProjectBindings,
  restoreLocalProjects,
  revokeLocalProject,
  ProjectPolicyError
} from '../src/main/local-projects/service.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import {
  authorizeBrowserInput,
  bindBrowserInputProject,
  claimBrowserInput,
  enqueueInput,
  failBrowserInput,
  listInputs,
  resetInputForTests
} from '../src/main/session/input.js';
import {
  createSession,
  getSession,
  initSessionStore,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import { resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';

let directory = '';
let approved = '';

const ledgerPath = () => path.join(directory, 'state', 'local-project-authority.json');
const coordinatorPath = () => path.join(directory, 'local-project-security.json');
const legacyLedgerPath = () => path.join(directory, 'state', 'project-authority.json');
const legacyCatalogPath = () => path.join(directory, 'state', 'projects.json');
const legacyAnchorPath = () => path.join(directory, 'project-authority-anchor.json');

async function initialize(): Promise<void> {
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  initLocalProjects(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
  await restoreLocalProjects();
}

async function restartAuthority(): Promise<void> {
  resetInputForTests();
  resetSessionStoreForTests();
  resetLocalProjectsForTests();
  resetDurableForTests();
  initDurableStore(directory);
  initSessionStore(directory);
  initLocalProjects(directory);
  await restoreLocalProjects();
}

beforeEach(async () => {
  resetInputForTests();
  resetLocalProjectsForTests();
  resetCorrelationRegistryForTests();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-projects-v2-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(path.join(approved, 'first'), { recursive: true });
  await fs.mkdir(path.join(approved, 'second'), { recursive: true });
  approved = await validateNewRoot(approved, []);
  await initialize();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetInputForTests();
  resetSessionStoreForTests();
  resetLocalProjectsForTests();
  resetCorrelationRegistryForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('checkpoints an empty native baseline once instead of rescanning history forever', async () => {
  const state = await readLocalProjectAuthority();
  expect(state).toMatchObject({ epoch: 1, mode: 'native', projects: [], sessionBindings: [], conversationBindings: [] });
  expect(state.era).toMatch(/^[a-f0-9-]{36}$/i);
  expect(getConfig().projectAuthorityEra).toBe(state.era);
  expect(JSON.parse(await fs.readFile(ledgerPath(), 'utf8'))).toMatchObject({
    version: 2,
    era: state.era,
    epoch: 1,
    projects: [],
    sessionBindings: [],
    conversationBindings: [],
    unresolvedProjectSends: []
  });
  expect(JSON.parse(await fs.readFile(coordinatorPath(), 'utf8'))).toMatchObject({
    version: 1,
    committed: { era: state.era, epoch: 1, ledgerSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    pending: null,
    recovery: null
  });
  await expect(fs.stat(legacyCatalogPath())).rejects.toMatchObject({ code: 'ENOENT' });

  const config = defaultConfig();
  expect(await browserBridgeRequired({
    sessions: { ...config.sessions, record: false },
    multiAgent: { ...config.multiAgent, enabled: false }
  })).toBe(false);

  const ledgerBefore = await fs.readFile(ledgerPath(), 'utf8');
  const coordinatorBefore = await fs.readFile(coordinatorPath(), 'utf8');
  await restartAuthority();
  expect(await fs.readFile(ledgerPath(), 'utf8')).toBe(ledgerBefore);
  expect(await fs.readFile(coordinatorPath(), 'utf8')).toBe(coordinatorBefore);
});

it('uses one authority database as the complete current project catalog', async () => {
  const folder = path.join(approved, 'first');
  const [one, again] = await Promise.all([addLocalProject(folder), addLocalProject(folder)]);
  expect(again.id).toBe(one.id);
  expect(listLocalProjects()).toEqual([one]);
  expect((await readLocalProjectAuthority()).projects).toEqual([one]);
  await expect(fs.stat(legacyCatalogPath())).rejects.toMatchObject({ code: 'ENOENT' });

  const config = defaultConfig();
  expect(await browserBridgeRequired({
    sessions: { ...config.sessions, record: false },
    multiAgent: { ...config.multiAgent, enabled: false }
  })).toBe(true);

  await fs.writeFile(path.join(approved, 'file.txt'), 'x');
  await expect(addLocalProject(path.join(approved, 'file.txt'))).rejects.toThrow(/folder/i);
  await expect(addLocalProject(directory)).rejects.toThrow();
  await expect(addLocalProject('first')).rejects.toThrow(/absolute/i);
});

it('canonicalizes picker aliases without granting an escaping alias', async () => {
  const alias = path.join(directory, 'picker-alias');
  await fs.symlink(approved, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const project = await addLocalProject(path.join(alias, 'first'));
  expect(project.path).toBe(path.join(approved, 'first'));
  expect((await addLocalProject(path.join(approved, 'first'))).id).toBe(project.id);

  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  const outsideAlias = path.join(approved, 'outside-alias');
  await fs.symlink(outside, outsideAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(addLocalProject(outsideAlias)).rejects.toThrow(/folder|approved|escape|inside/i);
});

it('ungroups a project without revoking existing chat authority and restores the same identity when re-added', async () => {
  const project = await addLocalProject(path.join(approved, 'first'));
  const other = await addLocalProject(path.join(approved, 'second'));
  const session = await createSession({ title: 'Keep this chat', conversationId: 'retained-conversation' });
  await assignSessionProject(session.id, project.id);
  const file = path.join(project.path, 'keep.txt');
  await fs.writeFile(file, 'keep');

  const removed = await removeLocalProject(project.id);
  expect(removed).toEqual({ ...project, ungrouped: true });
  expect(listLocalProjects()).toEqual([{ ...project, ungrouped: true }, other]);
  expect((await getSession(session.id))?.title).toBe('Keep this chat');
  expect(await resolveSessionProjectDirectory(session.id)).toMatchObject({ virtual: '/work/first' });
  expect(projectIdForPrincipal({ sessionId: session.id, conversationId: 'retained-conversation' })).toBe(project.id);
  expect(await fs.readFile(file, 'utf8')).toBe('keep');

  await restartAuthority();
  expect(listLocalProjects()).toEqual([{ ...project, ungrouped: true }, other]);
  expect(await resolveSessionProjectDirectory(session.id)).toMatchObject({ virtual: '/work/first' });
  expect(projectIdForPrincipal({ sessionId: session.id, conversationId: 'retained-conversation' })).toBe(project.id);

  expect(await addLocalProject(project.path)).toEqual(project);
  expect(listLocalProjects()).toEqual([project, other]);
});

it('stores direct principals only in authority and projects them into session reads', async () => {
  const project = await addLocalProject(path.join(approved, 'first'));
  const session = await createSession({ conversationId: 'direct-binding-chat', title: 'Direct binding' });
  await assignSessionProject(session.id, project.id);

  const authority = await readLocalProjectAuthority();
  expect(authority.sessionBindings).toContainEqual({ sessionId: session.id, projectId: project.id });
  expect(authority.conversationBindings).toHaveLength(1);
  expect(projectIdForPrincipal({ sessionId: session.id, conversationId: 'direct-binding-chat' })).toBe(project.id);
  expect((await getSession(session.id))?.projectId).toBe(project.id);

  const rawMeta = JSON.parse(await fs.readFile(path.join(directory, 'sessions', session.id, 'meta.json'), 'utf8')) as Record<string, unknown>;
  expect(rawMeta.projectId).toBeUndefined();

  // Two independently introduced principals for the same project are authorization-compatible;
  // there is no artificial lineage-object identity conflict anymore.
  const second = await createSession({ conversationId: 'second-direct-chat' });
  await retainProjectBindings({ sessionId: second.id, conversationIds: ['direct-binding-chat', 'second-direct-chat'], requestedProjectId: project.id });
  expect(projectIdForPrincipal({ sessionId: second.id, conversationId: 'direct-binding-chat' })).toBe(project.id);
});

it('rejects exact caller principals that resolve to different projects', async () => {
  const first = await addLocalProject(path.join(approved, 'first'));
  const second = await addLocalProject(path.join(approved, 'second'));
  const one = await createSession({ conversationId: 'project-one-chat' });
  const two = await createSession({ conversationId: 'project-two-chat' });
  await assignSessionProject(one.id, first.id);
  await assignSessionProject(two.id, second.id);

  expect(() => projectIdForPrincipal({ sessionId: one.id, conversationId: 'project-two-chat' })).toThrow(ProjectPolicyError);
});

it('does zero authority writes for an ordinary message in an already-bound project chat', async () => {
  const project = await addLocalProject(path.join(approved, 'first'));
  const session = await createSession({ conversationId: 'known-project-chat' });
  await assignSessionProject(session.id, project.id);
  const before = await readLocalProjectAuthority();

  const entry = await enqueueInput({
    id: randomUUID(), projectId: project.id, sessionId: session.id, text: 'Continue here', dueAt: 0,
    mode: 'auto', model: null, reasoningEffort: null
  });
  expect(await claimBrowserInput(entry.id, 'known-owner', 'known-project-chat', true)).toMatchObject({ projectId: project.id });
  expect(await authorizeBrowserInput(entry.id, 'known-owner', 'known-project-chat')).toBe(true);
  expect((await readLocalProjectAuthority()).epoch).toBe(before.epoch);

  // A proven pre-click failure has no project fence to remove in this case.
  expect(await failBrowserInput(entry.id, 'known-owner', 'Composer changed before click')).toBe(true);
  expect((await readLocalProjectAuthority()).epoch).toBe(before.epoch);
});

it('fences only a fresh destination and settles binding plus fence removal in one commit', async () => {
  const project = await addLocalProject(path.join(approved, 'first'));
  const before = await readLocalProjectAuthority();
  const entry = await enqueueInput({
    id: randomUUID(), projectId: project.id, sessionId: null, text: 'Start here', dueAt: 0,
    mode: 'auto', model: null, reasoningEffort: null
  });
  expect(await claimBrowserInput(entry.id, 'fresh-owner', null, true)).toMatchObject({ projectId: project.id });
  expect(await authorizeBrowserInput(entry.id, 'fresh-owner', null)).toBe(true);

  const fenced = await readLocalProjectAuthority();
  expect(fenced.epoch).toBe(before.epoch + 1);
  expect(fenced.unresolvedProjectSends).toEqual([
    expect.objectContaining({ inputId: entry.id, projectId: project.id })
  ]);
  expect(await bindBrowserInputProject(entry.id, 'fresh-owner', 'fresh-conversation')).toBe(false);
  expect(await bindBrowserInputProject(entry.id, 'fresh-owner', 'fresh-conversation', 'receipt')).toBe(true);

  const settled = await readLocalProjectAuthority();
  expect(settled.epoch).toBe(fenced.epoch + 1);
  expect(settled.unresolvedProjectSends).toEqual([]);
  expect(projectIdForPrincipal({ conversationId: 'fresh-conversation' })).toBe(project.id);
  const delivered = (await listInputs()).find(row => row.id === entry.id)!;
  expect(projectIdForPrincipal({ sessionId: delivered.deliveredSessionId })).toBe(project.id);

  // Receipt replay is idempotent and performs no third authority transaction.
  expect(await bindBrowserInputProject(entry.id, 'fresh-owner', 'fresh-conversation', 'receipt')).toBe(true);
  expect((await readLocalProjectAuthority()).epoch).toBe(settled.epoch);
});

it('removes a proven pre-click fresh-send fence before publishing input failure', async () => {
  const project = await addLocalProject(path.join(approved, 'first'));
  const entry = await enqueueInput({
    id: randomUUID(), projectId: project.id, sessionId: null, text: 'Start here', dueAt: 0,
    mode: 'auto', model: null, reasoningEffort: null
  });
  await claimBrowserInput(entry.id, 'abort-owner', null, true);
  await authorizeBrowserInput(entry.id, 'abort-owner', null);
  const fenced = await readLocalProjectAuthority();
  expect(fenced.unresolvedProjectSends).toHaveLength(1);

  expect(await failBrowserInput(entry.id, 'abort-owner', 'Exact recheck proved no click occurred')).toBe(true);
  const after = await readLocalProjectAuthority();
  expect(after.epoch).toBe(fenced.epoch + 1);
  expect(after.unresolvedProjectSends).toEqual([]);
  await expect(resolveCallerProjectScope(pinProjectAuthority()!, [{ name: 'work', path: approved }], {
    sessionId: null,
    conversationId: 'unrelated-chat'
  })).resolves.toBeNull();
});

it('keeps fresh-send ambiguity durable across restart until the exact receipt lands', async () => {
  const project = await addLocalProject(path.join(approved, 'first'));
  const entry = await enqueueInput({
    id: randomUUID(), projectId: project.id, sessionId: null, text: 'Fresh restart', dueAt: 0,
    mode: 'auto', model: null, reasoningEffort: null
  });
  await claimBrowserInput(entry.id, 'restart-owner', null, true);
  await authorizeBrowserInput(entry.id, 'restart-owner', null);
  await restartAuthority();

  await expect(resolveCallerProjectScope(pinProjectAuthority()!, [{ name: 'work', path: approved }], {
    sessionId: null,
    conversationId: 'unrelated-chat'
  })).rejects.toMatchObject({ code: 'send-unresolved' });

  expect(await bindBrowserInputProject(entry.id, 'restart-owner', 'after-restart', 'receipt')).toBe(true);
  await expect(resolveCallerProjectScope(pinProjectAuthority()!, [{ name: 'work', path: approved }], {
    sessionId: null,
    conversationId: 'unrelated-chat'
  })).resolves.toBeNull();
});

it('revocation is permanent identity history while re-adding the same folder creates a new project', async () => {
  const project = await addLocalProject(path.join(approved, 'first'));
  const session = await createSession({ conversationId: 'revoked-chat' });
  await assignSessionProject(session.id, project.id);
  const admittedBeforeRevocation = pinProjectAuthority()!;

  expect(await revokeLocalProject(project.id)).toBe(true);
  expect(listLocalProjects()).toEqual([]);
  await expect(resolveCallerProjectScope(pinProjectAuthority()!, [{ name: 'work', path: approved }], {
    sessionId: session.id,
    conversationId: 'revoked-chat'
  })).rejects.toMatchObject({ code: 'project-unavailable' });

  // Calls already admitted before revocation retain their immutable security snapshot.
  await expect(resolveCallerProjectScope(admittedBeforeRevocation, [{ name: 'work', path: approved }], {
    sessionId: session.id,
    conversationId: 'revoked-chat'
  })).resolves.toMatchObject({ real: path.join(approved, 'first') });

  const replacement = await addLocalProject(path.join(approved, 'first'));
  expect(replacement.id).not.toBe(project.id);
  expect((await readLocalProjectAuthority()).revokedProjectIds).toContain(project.id);
  await expect(resolveCallerProjectScope(pinProjectAuthority()!, [{ name: 'work', path: approved }], {
    sessionId: session.id,
    conversationId: 'revoked-chat'
  })).rejects.toMatchObject({ code: 'project-unavailable' });
});

it('security reset creates a new era, clears roots and retires pre-reset browser claims', async () => {
  const project = await addLocalProject(path.join(approved, 'first'));
  const entry = await enqueueInput({
    id: randomUUID(), projectId: project.id, sessionId: null, text: 'Old era send', dueAt: 0,
    mode: 'auto', model: null, reasoningEffort: null
  });
  await claimBrowserInput(entry.id, 'old-era-owner', null, true);
  await authorizeBrowserInput(entry.id, 'old-era-owner', null);
  const old = await readLocalProjectAuthority();

  await resetLocalProjectSecurity();
  const reset = await readLocalProjectAuthority();
  expect(reset.era).not.toBe(old.era);
  expect(reset.mode).toBe('native');
  expect(reset.projects).toEqual([]);
  expect(reset.sessionBindings).toEqual([]);
  expect(reset.conversationBindings).toEqual([]);
  expect(reset.unresolvedProjectSends).toEqual([]);
  expect(getConfig().roots).toEqual([]);
  expect(getConfig().projectAuthorityEra).toBe(reset.era);

  // A receipt from the retired era is conclusively stale and may be dropped without retry loops.
  expect(await bindBrowserInputProject(entry.id, 'old-era-owner', 'old-era-conversation', 'receipt')).toBe(true);
  expect(projectIdForPrincipal({ conversationId: 'old-era-conversation' })).toBeNull();
});

it('fails closed when config and authority are restored from different security eras', async () => {
  await addLocalProject(path.join(approved, 'first'));
  await saveConfig({ ...getConfig(), projectAuthorityEra: randomUUID() });
  resetLocalProjectsForTests();
  initLocalProjects(directory);
  await expect(restoreLocalProjects()).rejects.toThrow(/different security eras/i);
  expect(projectAuthorityStatus().status).toBe('unavailable');
});

it('detects a stale valid ledger restored behind a newer coordinator', async () => {
  const staleLedger = await fs.readFile(ledgerPath(), 'utf8');
  await addLocalProject(path.join(approved, 'first'));
  await fs.writeFile(ledgerPath(), staleLedger, 'utf8');
  resetLocalProjectsForTests();
  initLocalProjects(directory);
  await expect(restoreLocalProjects()).rejects.toThrow(/does not match/i);
  expect(projectAuthorityStatus().status).toBe('unavailable');
});

it('strictly rejects a malformed recovery/coordinator file instead of treating existence as reset authority', async () => {
  await fs.writeFile(coordinatorPath(), JSON.stringify({ version: 1, recovery: { operation: 'anything' } }), 'utf8');
  resetLocalProjectsForTests();
  initLocalProjects(directory);
  await expect(restoreLocalProjects()).rejects.toThrow(/coordinator is invalid/i);
  expect(projectAuthorityStatus().status).toBe('unavailable');
});

it('migrates an exact v1 anchored authority to direct v2 bindings and retires old files', async () => {
  const projectId = randomUUID();
  const sessionId = `20260911-${randomUUID()}`;
  const conversation = 'legacy-v1-conversation';
  const digest = createHash('sha256')
    .update('chat-on-steroids:project-authority:v1\0')
    .update(conversation)
    .digest('hex');
  const legacy = {
    version: 1,
    epoch: 7,
    mode: 'native',
    projects: [{ projectId, name: 'first', canonicalPath: path.join(approved, 'first'), createdAt: 1 }],
    lineages: [{ projectId, sessionIds: [sessionId], conversationDigests: [digest] }],
    revokedProjectIds: [],
    pendingProjectInputs: []
  } as const;
  const serialized = JSON.stringify(legacy);
  const hash = createHash('sha256').update(serialized).digest('hex');

  // Replace the native baseline with the exact on-disk shape produced by the prior implementation.
  resetLocalProjectsForTests();
  await saveConfig({ ...getConfig(), projectAuthorityEra: null });
  await fs.rm(ledgerPath(), { force: true });
  await fs.rm(coordinatorPath(), { force: true });
  await fs.mkdir(path.dirname(legacyLedgerPath()), { recursive: true });
  await fs.writeFile(legacyLedgerPath(), serialized, 'utf8');
  await fs.writeFile(legacyAnchorPath(), JSON.stringify({
    version: 1,
    committed: { epoch: 7, ledgerSha256: hash },
    pending: null
  }), 'utf8');
  initLocalProjects(directory);
  await restoreLocalProjects();

  const migrated = await readLocalProjectAuthority();
  expect(migrated.epoch).toBe(8);
  expect(migrated.projects).toEqual([expect.objectContaining({ id: projectId, path: path.join(approved, 'first') })]);
  expect(projectIdForPrincipal({ sessionId, conversationId: conversation })).toBe(projectId);
  expect(getConfig().projectAuthorityEra).toBe(migrated.era);
  await expect(fs.stat(legacyLedgerPath())).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(legacyAnchorPath())).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await fs.readFile(ledgerPath(), 'utf8'))).toMatchObject({ version: 2, epoch: 8 });
});
