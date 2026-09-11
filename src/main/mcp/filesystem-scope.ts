/**
 * Filesystem policy layered on top of approved roots.
 *
 * Approved roots are the installation's maximum authority. A Local Project is an optional,
 * durable narrowing owned by the exact caller principal; a learned workspace is only relative-
 * path convenience for an unbound chat. Identity may improve before policy is frozen; policy
 * must not drift after admission.
 */

import { rawPromises as fs } from '../rawfs.js';
import type { Root } from '../../shared/types.js';
import {
  SandboxError,
  ScopeBoundaryError,
  isAbsoluteVirtualPath,
  isNativeWindowsPath,
  resolvePath,
  type Resolved
} from '../sandbox.js';
import { currentWorkspace, learnWorkspace } from '../workspace.js';
import {
  pinProjectAuthority,
  projectCallerIdentityRequired,
  resolveCallerProjectScope,
  ProjectPolicyError,
  type ProjectAuthoritySnapshot
} from '../local-projects/service.js';
import { currentCall, type CallContext } from './call-context.js';

export const PROJECT_IDENTITY_REQUIRED =
  'PROJECT_IDENTITY_REQUIRED: this installation has Local Project authority, but the connector could not prove which conversation made this call. No local operation was run; retry after the browser extension reconnects.';
export const PROJECT_BINDING_UNRESOLVED =
  'PROJECT_BINDING_UNRESOLVED: a Local Project message was authorized for native Send but its exact destination conversation is still unresolved. No local operation was run; reconnect the companion to finish that receipt, or use Local Project security recovery if the send cannot be recovered.';
export const PROJECT_LEGACY_AMBIGUOUS =
  'PROJECT_LEGACY_AMBIGUOUS: this profile was upgraded from the legacy Local Project model, whose retained history cannot prove that this older conversation was genuinely unbound. No local operation was run; known project chats remain narrowed. Use Local Project security recovery to establish a new authority baseline before broad-root access resumes.';
export const PROJECT_AUTHORITY_UNAVAILABLE =
  'PROJECT_AUTHORITY_UNAVAILABLE: Local Project authorization is unavailable. No local operation was run.';
export const PROJECT_UNAVAILABLE =
  'PROJECT_UNAVAILABLE: this chat is bound to a Local Project whose folder or catalog entry is unavailable. No local operation was run.';
export const PROJECT_IDENTITY_CONFLICT =
  'PROJECT_IDENTITY_CONFLICT: the exact caller identities disagree about Local Project ownership. No local operation was run.';

function authorityError(error: unknown): SandboxError {
  if (error instanceof ProjectPolicyError) {
    if (error.code === 'project-unavailable') return new SandboxError(PROJECT_UNAVAILABLE);
    if (error.code === 'send-unresolved') return new SandboxError(PROJECT_BINDING_UNRESOLVED);
    if (error.code === 'legacy-ambiguous') return new SandboxError(PROJECT_LEGACY_AMBIGUOUS);
    if (error.code === 'identity-conflict') return new SandboxError(PROJECT_IDENTITY_CONFLICT);
  }
  return new SandboxError(PROJECT_AUTHORITY_UNAVAILABLE);
}

/**
 * Preflight only: tells the dispatcher whether exact request identity must settle before policy is
 * pinned. This deliberately does not cache an epoch. A project-bearing browser send normally
 * commits its binding before publishing request correlation; if its document dies in the narrow
 * post-Send window, the pre-Send authority fence remains durable and makes an unbound resolution
 * fail closed. Either way a call must pin the post-identity epoch rather than reuse preflight.
 */
export async function requiresProjectCallerIdentity(): Promise<boolean> {
  try {
    return await projectCallerIdentityRequired();
  } catch (error) {
    throw authorityError(error);
  }
}

function freezeRoots(roots: readonly Root[]): readonly Root[] {
  return Object.freeze(roots.map(root => Object.freeze({ ...root })));
}

/**
 * Freezes the complete filesystem authorization snapshot after exact identity has settled.
 * There is intentionally no await between reading approved roots and pinning project authority:
 * JavaScript cannot interleave a config/security mutation and create a policy that never existed.
 */
export function pinFilesystemPolicy(call: CallContext, roots: readonly Root[], projectAware: boolean): void {
  try {
    const approvedRoots = freezeRoots(roots);
    const authority = projectAware ? pinProjectAuthority() : null;
    if (projectAware && !authority) throw new Error('Local Project authority is not available');
    call.filesystemPolicy = { roots: approvedRoots, authority };
  } catch (error) {
    throw authorityError(error);
  }
}

async function policyForCall(call: CallContext | null, roots: readonly Root[]): Promise<{
  roots: readonly Root[];
  authority: ProjectAuthoritySnapshot | null;
  project?: Promise<{ virtual: string; real: string } | null>;
}> {
  if (call?.filesystemPolicy) return call.filesystemPolicy;
  // Direct internal/tests may reach a resolver without dispatch. They may pin lazily only when
  // identity is already exact; a resolver never waits for or mutates caller identity itself.
  let required: boolean;
  try {
    required = await projectCallerIdentityRequired();
  } catch (error) {
    throw authorityError(error);
  }
  if (required && !call?.caller.conversationId && !call?.caller.sessionId) {
    throw new SandboxError(PROJECT_IDENTITY_REQUIRED);
  }
  let authority: ProjectAuthoritySnapshot | null = null;
  try {
    if (required) authority = pinProjectAuthority();
  } catch (error) {
    throw authorityError(error);
  }
  const policy = { roots: freezeRoots(roots), authority };
  if (call) call.filesystemPolicy = policy;
  return policy;
}

async function projectDirectoryForCall(
  roots: readonly Root[]
): Promise<{ roots: readonly Root[]; project: { virtual: string; real: string } | null }> {
  const call = currentCall();
  const policy = await policyForCall(call, roots);
  if (!policy.authority) return { roots: policy.roots, project: null };
  const caller = call?.caller ?? { conversationId: null, sessionId: null };
  if (!policy.project) policy.project = resolveCallerProjectScope(policy.authority, policy.roots, caller).catch((error) => {
    throw authorityError(error);
  });
  return { roots: policy.roots, project: await policy.project };
}

async function filesystemContextForCall(roots: readonly Root[]): Promise<{
  roots: readonly Root[];
  workspace: { virtual: string; real: string } | null;
  project: { virtual: string; real: string } | null;
}> {
  const policy = await projectDirectoryForCall(roots);
  if (policy.project) return { roots: policy.roots, workspace: policy.project, project: policy.project };
  return { roots: policy.roots, workspace: currentWorkspace(), project: null };
}

/** Project-sensitive actions with no pathname still obey revocation/unresolved-caller policy. */
export async function assertProjectPrincipalAllowed(call: CallContext): Promise<void> {
  const policy = call.filesystemPolicy;
  if (!policy?.authority) return;
  try {
    await resolveCallerProjectScope(policy.authority, policy.roots, call.caller);
  } catch (error) {
    throw authorityError(error);
  }
}

/** Resolves one tool path against project authority or this chat's learned workspace. */
export async function resolveScopedPath(
  roots: readonly Root[],
  requested: string,
  options: { allowMissing?: boolean; base?: string | null } = {}
): Promise<Resolved> {
  const { roots: policyRoots, workspace, project } = await filesystemContextForCall(roots);
  const base = options.base !== undefined ? options.base : (workspace?.virtual ?? null);
  let resolved: Resolved;
  try {
    resolved = await resolvePath(policyRoots, requested, {
      ...(options.allowMissing === undefined ? {} : { allowMissing: options.allowMissing }),
      base,
      ...(project ? { within: project } : {})
    });
  } catch (error) {
    if (project && error instanceof ScopeBoundaryError) {
      throw new SandboxError(
        `PROJECT_BOUNDARY: this chat is bound to ${project.virtual}. Use a path inside that project. The request was refused before the target was read or changed.`
      );
    }
    throw error;
  }
  // Absolute only: a workspace learned from a relative path would let one loose resolution
  // decide where the next loose resolution points. Project-bound calls never learn alternatives.
  if (!project && (isAbsoluteVirtualPath(requested) || isNativeWindowsPath(requested))) {
    await learnWorkspace(resolved);
  }
  return resolved;
}

/** Search scopes for an omitted find path, narrowed to the exact durable project when bound. */
export async function resolveDefaultSearchScopes(
  roots: readonly Root[]
): Promise<Array<{ real: string; virtual: string }>> {
  const { roots: policyRoots, project } = await filesystemContextForCall(roots);
  if (project) return [project];
  return Promise.all(
    policyRoots.map(async (root) => {
      const resolved = await resolvePath(policyRoots, `/${root.name}`);
      return { real: resolved.real, virtual: resolved.virtual };
    })
  );
}

export interface ResolvedCwd {
  real: string;
  virtual: string;
  /** True when the caller named no folder, so its proven workspace/project was used. */
  defaulted: boolean;
}

/** Resolves a command/patch starting directory; caller policy decides whether root fallback is safe. */
export async function resolveScopedCwd(
  roots: readonly Root[],
  virtualPath: string | undefined,
  options: { workspaceRequiredMessage?: string } = {}
): Promise<ResolvedCwd> {
  const { workspace } = await filesystemContextForCall(roots);
  const provided = virtualPath !== undefined && virtualPath !== '';
  if (!provided && !workspace) {
    throw new SandboxError(
      options.workspaceRequiredMessage ??
      'WORKSPACE_REQUIRED: this call has no proven workspace. Supply an explicit approved folder before running it.'
    );
  }
  const target = provided ? virtualPath : workspace!.virtual;
  const resolved = await resolveScopedPath(roots, target);
  if (!(await fs.stat(resolved.real)).isDirectory()) throw new SandboxError('workdir must be a folder');
  return { real: resolved.real, virtual: resolved.virtual, defaulted: !provided };
}
