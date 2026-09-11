import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const projectScope = vi.hoisted(() => vi.fn());
const identityRequired = vi.hoisted(() => vi.fn());
const pinAuthority = vi.hoisted(() => vi.fn());
vi.mock('../src/main/local-projects/service.js', () => {
  class ProjectPolicyError extends Error {
    constructor(readonly code: string, message = code) { super(message); }
  }
  return {
    ProjectPolicyError,
    resolveCallerProjectScope: projectScope,
    projectCallerIdentityRequired: identityRequired,
    pinProjectAuthority: pinAuthority
  };
});

import { dispatch, fail, ok, resolveCwd } from '../src/main/mcp/kernel.js';
import { resolveDefaultSearchScopes, resolveScopedPath } from '../src/main/mcp/filesystem-scope.js';
import { downloadArtifactFile } from '../src/main/mcp/artifact-download.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { resetWorkspaces, setWorkspaceFor } from '../src/main/workspace.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { resetBlockedChatsForTests, setChatBlocked } from '../src/main/session/blocked-chats.js';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

type Binding = {
  projectId: string;
  sessionIds: readonly string[];
  conversations: readonly string[];
};

const PROJECT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const binding = (sessionId: string, conversation?: string): Binding => ({
  projectId: PROJECT_ID,
  sessionIds: [sessionId],
  conversations: conversation ? [conversation] : []
});
const authority = (generation: number, bindings: readonly Binding[]) => ({
  generation,
  bindings,
  bindingBySessionId: new Map(bindings.flatMap((row) => row.sessionIds.map((id) => [id, row] as const))),
  bindingByConversationDigest: new Map()
});

let base = '';
let currentAuthority = authority(1, []);

beforeAll(async () => {
  base = await makeTempDir();
  await writeTree(base, {
    'a/file.txt': 'a',
    'ab/file.txt': 'ab',
    'b/file.txt': 'b'
  });
  await fs.symlink(path.join(base, 'b'), path.join(base, 'a', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  initConfigPath(base);
  initDurableStore(base);
  initSessionStore(base);
  const config = defaultConfig();
  await saveConfig({
    ...config,
    roots: [{ name: 'work', path: base }],
    sessions: { ...config.sessions, record: false },
    multiAgent: { ...config.multiAgent, enabled: false }
  });
});

afterAll(async () => {
  resetBlockedChatsForTests();
  resetCorrelationRegistryForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(base);
});

beforeEach(() => {
  resetWorkspaces();
  resetBlockedChatsForTests();
  resetCorrelationRegistryForTests();
  currentAuthority = authority(1, []);
  projectScope.mockReset().mockImplementation(async (snapshot, _roots, caller) =>
    snapshot.bindingBySessionId.get(caller.sessionId ?? '')
      ? { virtual: '/work/a', real: path.join(base, 'a') }
      : null
  );
  identityRequired.mockReset().mockResolvedValue(false);
  pinAuthority.mockReset().mockImplementation(() => currentAuthority);
});

function run<T>(id: string, fn: () => T): T {
  const context: CallContext = {
    startedAt: Date.now(),
    transportKey: null,
    agent: 'prime',
    caller: { transportKey: null, requestId: null, conversationId: `chat-${id}`, sessionId: `session-${id}` },
    outcome: null,
    evidence: emptyEvidence()
  };
  return runInCallContext(context, fn);
}

const roots = () => [{ name: 'work', path: base }];

it('initializes simultaneous Prime cwd from each exact durable session project', async () => {
  const aBinding = binding('session-a');
  const bBinding = binding('session-b');
  currentAuthority = authority(2, [aBinding, bBinding]);
  identityRequired.mockResolvedValue(true);
  projectScope.mockImplementation(async (snapshot, _roots, caller) => snapshot.bindingBySessionId.has(caller.sessionId ?? '')
    ? { virtual: `/work/${caller.sessionId?.slice(-1)}`, real: path.join(base, caller.sessionId?.slice(-1) ?? '') }
    : null);

  const [a, b] = await Promise.all(['a', 'b'].map((id) => run(id, () =>
    resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined)
  )));
  expect(a?.virtual).toBe('/work/a');
  expect(b?.virtual).toBe('/work/b');
  expect((await run('a', () => resolveScopedPath(roots(), 'file.txt'))).real).toBe(path.join(base, 'a', 'file.txt'));
});

it('makes the explicit project override learned cwd and rejects every spelling outside it uniformly', async () => {
  currentAuthority = authority(2, [binding('session-a')]);
  identityRequired.mockResolvedValue(true);
  setWorkspaceFor('chat:chat-a', { virtual: '/work/b', real: path.join(base, 'b') });

  expect((await run('a', () => resolveScopedPath(roots(), 'file.txt'))).virtual).toBe('/work/a/file.txt');
  await expect(run('a', () => resolveScopedPath(roots(), '/work/b/file.txt'))).rejects.toThrow('PROJECT_BOUNDARY');
  await expect(run('a', () => resolveScopedPath(roots(), '/work/b/missing.txt'))).rejects.toThrow('PROJECT_BOUNDARY');
  await expect(run('a', () => resolveScopedPath(roots(), path.join(base, 'b', 'file.txt')))).rejects.toThrow('PROJECT_BOUNDARY');
  await expect(run('a', () => resolveScopedPath(roots(), path.join(base, 'b', 'missing.txt')))).rejects.toThrow('PROJECT_BOUNDARY');
  await expect(run('a', () => resolveScopedPath(roots(), '/work/ab/file.txt'))).rejects.toThrow('PROJECT_BOUNDARY');
  await expect(run('a', () => resolveScopedPath(roots(), '/work/a/escape/file.txt'))).rejects.toThrow('PROJECT_BOUNDARY');
  await expect(run('a', () => resolveScopedPath(roots(), '/work/a/escape/missing.txt', { allowMissing: true }))).rejects.toThrow('PROJECT_BOUNDARY');
  await expect(run('a', () => resolveScopedPath(roots(), 'file.txt', { base: '/work/b' }))).rejects.toThrow('PROJECT_BOUNDARY');
  await expect(run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, '/work/b'))).rejects.toThrow('PROJECT_BOUNDARY');
});

it('fails before path resolution when project authority cannot identify the current caller', async () => {
  currentAuthority = authority(2, [binding('session-a')]);
  identityRequired.mockResolvedValue(true);
  const context: CallContext = {
    startedAt: Date.now(),
    transportKey: null,
    agent: 'prime',
    caller: { transportKey: null, requestId: 'unproved-request', conversationId: null, sessionId: null },
    outcome: null,
    evidence: emptyEvidence()
  };
  await expect(runInCallContext(context, () => resolveScopedPath(roots(), '/work/b/file.txt'))).rejects.toThrow(
    'PROJECT_IDENTITY_REQUIRED'
  );
  expect(projectScope).not.toHaveBeenCalled();
});

it('does not let an internal path call bypass active project authority by omitting call context', async () => {
  currentAuthority = authority(2, [binding('session-a')]);
  identityRequired.mockResolvedValue(true);
  await expect(resolveScopedPath(roots(), '/work/a/file.txt')).rejects.toThrow('PROJECT_IDENTITY_REQUIRED');
  expect(projectScope).not.toHaveBeenCalled();
});

it('keeps a fresh installation browser-independent when Local Project policy is inactive', async () => {
  identityRequired.mockResolvedValue(false);
  const reply = await dispatch('read', { paths: ['/work/a/file.txt'] }, null, null, 'core', async () => {
    const resolved = await resolveScopedPath(roots(), '/work/a/file.txt');
    return ok(resolved.virtual);
  });
  expect(reply).toMatchObject({ content: [expect.objectContaining({ text: '/work/a/file.txt' })] });
  expect(pinAuthority).not.toHaveBeenCalled();
  expect(projectScope).not.toHaveBeenCalled();
});

it('does not change an already-admitted unscoped call when project policy activates mid-call', async () => {
  identityRequired.mockResolvedValue(false);
  const reply = await dispatch('read', { paths: ['/work/b/file.txt'] }, null, null, 'core', async () => {
    // Simulate another transaction adding the first Local Project after this call's admission
    // linearization point. The resolver must honor the frozen unscoped verdict rather than
    // re-reading global policy and changing authorization halfway through the request.
    identityRequired.mockResolvedValue(true);
    currentAuthority = authority(2, [binding('session-other')]);
    const resolved = await resolveScopedPath(roots(), '/work/b/file.txt');
    return ok(resolved.virtual);
  });
  expect(reply).toMatchObject({ content: [expect.objectContaining({ text: '/work/b/file.txt' })] });
  expect(identityRequired).toHaveBeenCalledTimes(1);
  expect(pinAuthority).not.toHaveBeenCalled();
  expect(projectScope).not.toHaveBeenCalled();
});

it('settles late project identity before freezing the blocked-chat admission verdict', async () => {
  currentAuthority = authority(2, [binding('session-a')]);
  identityRequired.mockResolvedValue(true);
  const conversationId = 'blocked-project-chat';
  const requestId = 'wfr-late-project-identity';
  setChatBlocked(conversationId, true);
  let ran = false;
  const result = dispatch('read', { paths: ['/work/a/file.txt'] }, null, requestId, 'core', async () => {
    ran = true;
    return ok('should not run');
  });
  queueMicrotask(() => observeRequestCorrelation({
    requestId,
    conversationId,
    sessionId: 'session-a',
    messageId: 'message-a',
    tool: 'read',
    observedAt: Date.now()
  }));
  const reply = await result;
  expect(reply).toMatchObject({ isError: true });
  expect(reply.content[0]?.type === 'text' ? reply.content[0].text : '').toContain('CHAT_BLOCKED');
  expect(ran).toBe(false);
});

async function dispatchOutsideProjectDuringLateBind(initial: ReturnType<typeof authority>): Promise<{
  reply: Awaited<ReturnType<typeof dispatch>>;
  reachedOutside: boolean;
}> {
  const requestId = `wfr-project-race-${initial.generation}`;
  const conversationId = `project-race-chat-${initial.generation}`;
  currentAuthority = initial;
  identityRequired.mockResolvedValue(true);
  let reachedOutside = false;
  const pending = dispatch('read', { paths: ['/work/b/file.txt'] }, null, requestId, 'core', async () => {
    try {
      await resolveScopedPath(roots(), '/work/b/file.txt');
      reachedOutside = true;
      return ok('outside project reached');
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });
  queueMicrotask(() => {
    currentAuthority = authority(initial.generation + 1, [...initial.bindings, binding('session-a')]);
    observeRequestCorrelation({
      requestId,
      conversationId,
      sessionId: 'session-a',
      messageId: 'message-a',
      tool: 'read',
      observedAt: Date.now()
    });
  });
  return { reply: await pending, reachedOutside };
}

it('pins the binding published during the first-ever project request, never the preflight generation', async () => {
  const { reply, reachedOutside } = await dispatchOutsideProjectDuringLateBind(authority(10, []));
  expect(reply).toMatchObject({ isError: true });
  expect(reply.content[0]?.type === 'text' ? reply.content[0].text : '').toContain('PROJECT_BOUNDARY');
  expect(reachedOutside).toBe(false);
  expect(pinAuthority).toHaveBeenCalledTimes(1);
  expect(projectScope.mock.calls.at(-1)?.[0].generation).toBe(11);
});

it('discards unrelated preflight policy and pins the caller binding published before correlation', async () => {
  const { reply, reachedOutside } = await dispatchOutsideProjectDuringLateBind(
    authority(20, [binding('session-other')])
  );
  expect(reply).toMatchObject({ isError: true });
  expect(reply.content[0]?.type === 'text' ? reply.content[0].text : '').toContain('PROJECT_BOUNDARY');
  expect(reachedOutside).toBe(false);
  expect(pinAuthority).toHaveBeenCalledTimes(1);
  expect(projectScope.mock.calls.at(-1)?.[0].generation).toBe(21);
});

it('pins one immutable generation when the exact project caller was already proven at ingress', async () => {
  const requestId = 'wfr-project-already-proven';
  const conversationId = 'project-already-proven';
  currentAuthority = authority(30, [binding('session-a')]);
  identityRequired.mockResolvedValue(true);
  observeRequestCorrelation({ requestId, conversationId, sessionId: 'session-a', messageId: 'message-a', tool: 'read', observedAt: Date.now() });
  const reply = await dispatch('read', { paths: ['/work/a/file.txt'] }, null, requestId, 'core', async () => {
    const resolved = await resolveScopedPath(roots(), '/work/a/file.txt');
    return ok(resolved.virtual);
  });
  expect(reply.isError).not.toBe(true);
  expect(pinAuthority).toHaveBeenCalledTimes(1);
  expect(projectScope).toHaveBeenCalledTimes(1);
});

it('fails closed with a stable message when runtime project authority is unavailable', async () => {
  identityRequired.mockRejectedValue(new Error('C:\\secret\\state\\local-project-authority.json is malformed'));
  let ran = false;
  const reply = await dispatch('read', { paths: ['/work/a/file.txt'] }, null, 'wfr-authority-down', 'core', async () => {
    ran = true;
    return ok('should not run');
  });
  expect(reply).toMatchObject({ isError: true });
  expect(reply.content[0]?.type === 'text' ? reply.content[0].text : '').toContain('PROJECT_AUTHORITY_UNAVAILABLE');
  expect(ran).toBe(false);
});

it('searches only the selected project when find has no path', async () => {
  currentAuthority = authority(2, [binding('session-a')]);
  identityRequired.mockResolvedValue(true);
  await expect(run('a', () => resolveDefaultSearchScopes(roots()))).resolves.toEqual([
    { virtual: '/work/a', real: path.join(base, 'a') }
  ]);
});

it('refuses an out-of-project artifact destination before starting the download', async () => {
  currentAuthority = authority(2, [binding('session-a')]);
  identityRequired.mockResolvedValue(true);
  const fetch = vi.fn() as unknown as typeof globalThis.fetch;
  await expect(run('a', () => downloadArtifactFile(
    roots(),
    '/work/b/new.bin',
    {
      download_url: 'https://files.oaiusercontent.com/file-project-boundary?se=2030&sig=test',
      file_id: 'file-project-boundary'
    },
    { maxFileBytes: 1024, fetch }
  ))).rejects.toThrow('PROJECT_BOUNDARY');
  expect(fetch).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(base, 'b', 'new.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reuses one post-identity policy generation and one project resolution throughout a call', async () => {
  currentAuthority = authority(2, [binding('session-a')]);
  identityRequired.mockResolvedValue(true);
  const callRoots = roots();
  await run('a', async () => {
    expect((await resolveScopedPath(callRoots, '/work/a/file.txt')).virtual).toBe('/work/a/file.txt');
    expect((await resolveScopedPath(callRoots, 'file.txt')).virtual).toBe('/work/a/file.txt');
  });
  expect(pinAuthority).toHaveBeenCalledTimes(1);
  expect(projectScope).toHaveBeenCalledTimes(1);
});
