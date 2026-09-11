import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import {
  addLocalProject,
  assignSessionProject,
  initLocalProjects,
  revokeLocalProject,
  resetLocalProjectsForTests,
  restoreLocalProjects
} from '../src/main/local-projects/service.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { createSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { resetExecOwnershipForTests } from '../src/main/codex/ownership.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { makeTempDir, removeTempDir } from './helpers.js';

describe('MCP Local Project patch boundary', () => {
  let directory = '';
  let projectDir = '';
  let siblingDir = '';
  let endpoint: McpEndpoint | null = null;
  let requestId = '';
  let projectId = '';
  let sessionId = '';
  let conversationId = '';

  const callTool = async (name: string, args: Record<string, unknown>, callRequestId = requestId): Promise<any> => {
    const response = await fetch(endpoint!.urls.core, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-request-id': `${callRequestId}/tool`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: `${name}-test`, method: 'tools/call', params: { name, arguments: args } })
    });
    const raw = await response.text();
    return JSON.parse(raw.startsWith('event:') || raw.startsWith('data:')
      ? raw.split('\n').find(line => line.startsWith('data:'))!.slice(5)
      : raw);
  };

  const call = async (patch: string): Promise<any> => {
    return callTool('apply_patch', { patch });
  };

  beforeEach(async () => {
    directory = await makeTempDir('clf-project-patch-');
    projectDir = path.join(directory, 'a');
    siblingDir = path.join(directory, 'b');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'inside.txt'), 'inside\n');
    await fs.writeFile(path.join(projectDir, 'move.txt'), 'move\n');
    await fs.writeFile(path.join(siblingDir, 'outside.txt'), 'outside\n');

    initConfigPath(directory);
    initDurableStore(directory);
    initSessionStore(directory);
    initLocalProjects(directory);
    const config = defaultConfig();
    await saveConfig({ ...config, roots: [{ name: 'work', path: directory }], readOnly: false });
    await restoreLocalProjects();
    const project = await addLocalProject(projectDir);
    projectId = project.id;
    conversationId = '11111111-2222-4333-8444-555555555555';
    const session = await createSession({ conversationId, title: 'Project patch boundary' });
    sessionId = session.id;
    await assignSessionProject(session.id, project.id);
    requestId = 'wfr_project_patch_boundary';
    observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: 'patch-message', tool: 'apply_patch', observedAt: Date.now() });
    endpoint = await startMcpServer(() => ({
      roots: [{ name: 'work', path: directory }],
      caps: { ...config.capabilities, create: true, edit: true, move: true, deleteFile: true, command: true },
      readOnly: false,
      sessionTools: false,
      agentTools: false
    }));
  });

  afterEach(async () => {
    await endpoint?.stop();
    endpoint = null;
    await unifiedExecManager.terminateAllProcesses();
    resetExecOwnershipForTests();
    resetCorrelationRegistryForTests();
    resetLocalProjectsForTests();
    resetSessionStoreForTests();
    resetDurableForTests();
    await removeTempDir(directory);
  });

  it('rejects the whole multi-file patch before an inside hunk can land when another hunk escapes', async () => {
    const reply = await call([
      '*** Begin Patch',
      '*** Update File: inside.txt',
      '@@',
      '-inside',
      '+changed-inside',
      '*** Update File: /work/b/outside.txt',
      '@@',
      '-outside',
      '+changed-outside',
      '*** End Patch'
    ].join('\n'));
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toContain('PROJECT_BOUNDARY');
    await expect(fs.readFile(path.join(projectDir, 'inside.txt'), 'utf8')).resolves.toBe('inside\n');
    await expect(fs.readFile(path.join(siblingDir, 'outside.txt'), 'utf8')).resolves.toBe('outside\n');
  });

  it('rejects an inside-to-outside move before creating the destination', async () => {
    const destination = path.join(siblingDir, 'moved.txt');
    const reply = await call([
      '*** Begin Patch',
      '*** Update File: move.txt',
      '*** Move to: /work/b/moved.txt',
      '@@',
      ' move',
      '*** End Patch'
    ].join('\n'));
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toContain('PROJECT_BOUNDARY');
    await expect(fs.readFile(path.join(projectDir, 'move.txt'), 'utf8')).resolves.toBe('move\n');
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an absolute outside add before creating a file', async () => {
    const destination = path.join(siblingDir, 'new.txt');
    const reply = await call([
      '*** Begin Patch',
      '*** Add File: /work/b/new.txt',
      '+nope',
      '*** End Patch'
    ].join('\n'));
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toContain('PROJECT_BOUNDARY');
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revocation fences write_stdin before bytes can reach a process opened by that project principal', async () => {
    const marker = path.join(projectDir, 'stdin-reached.txt');
    await fs.writeFile(
      path.join(projectDir, 'stdin-guard.cjs'),
      "const fs=require('node:fs'); const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on('line',(line)=>fs.writeFileSync('stdin-reached.txt',line)); setInterval(()=>{},1000);\n",
      'utf8'
    );
    const execRequestId = 'wfr_project_exec_owner';
    observeRequestCorrelation({
      requestId: execRequestId,
      conversationId,
      sessionId,
      messageId: 'exec-owner-message',
      tool: 'exec_command',
      observedAt: Date.now()
    });
    const started = await callTool('exec_command', {
      cmd: 'node stdin-guard.cjs',
      workdir: '/work/a',
      tty: true,
      yield_time_ms: 25
    }, execRequestId);
    expect(started.result?.isError).not.toBe(true);
    const startedText = started.result?.content?.map((row: { text?: string }) => row.text ?? '').join('\n') ?? '';
    const processId = Number(startedText.match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(processId), startedText).toBe(true);

    expect(await revokeLocalProject(projectId)).toBe(true);
    const stdinRequestId = 'wfr_project_exec_after_revoke';
    observeRequestCorrelation({
      requestId: stdinRequestId,
      conversationId,
      sessionId,
      messageId: 'stdin-after-revoke-message',
      tool: 'write_stdin',
      observedAt: Date.now()
    });
    const refused = await callTool('write_stdin', {
      session_id: processId,
      chars: 'must-not-arrive\r',
      yield_time_ms: 250
    }, stdinRequestId);
    expect(refused.result?.isError).toBe(true);
    const refusedText = refused.result?.content?.map((row: { text?: string }) => row.text ?? '').join('\n') ?? '';
    expect(refusedText).toContain('PROJECT_UNAVAILABLE');
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
