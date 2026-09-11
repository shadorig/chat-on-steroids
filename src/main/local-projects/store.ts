import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicRemoveFile, atomicWriteJson } from '../atomic-file.js';
import { readDurableStrictText, writeDurableStrictSerializedNow } from '../durable.js';
import { logWarn } from '../logger.js';
import {
  authorityV1Schema,
  serializeAuthority,
  stateFromPersisted,
  type AuthorityState
} from './model.js';

const AUTHORITY_STATE = 'local-project-authority';
const LEGACY_AUTHORITY_STATE = 'project-authority';
const LEGACY_PROJECTS_STATE = 'projects';
const COORDINATOR_VERSION = 1;
const LEGACY_ANCHOR_VERSION = 1;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const eraSchema = z.string().uuid();
const epochSchema = z.number().int().safe().positive();

const descriptorSchema = z.object({
  era: eraSchema,
  epoch: epochSchema,
  ledgerSha256: digestSchema
}).strict();
const recoverySchema = z.object({
  operation: z.enum(['activate-local-project-authority', 'reset-local-project-security']),
  targetEra: eraSchema,
  targetEpoch: epochSchema
}).strict();
const coordinatorSchema = z.object({
  version: z.literal(COORDINATOR_VERSION),
  committed: descriptorSchema.nullable(),
  pending: descriptorSchema.nullable(),
  recovery: recoverySchema.nullable()
}).strict().superRefine((value, context) => {
  if (!value.committed && !value.pending && !value.recovery) {
    context.addIssue({ code: 'custom', message: 'Local Project security coordinator is empty' });
  }
  if (value.committed && value.pending && value.pending.epoch !== value.committed.epoch + 1) {
    context.addIssue({ code: 'custom', message: 'Local Project security transition has an impossible epoch shape' });
  }
  if (value.recovery && value.pending &&
      (value.pending.era !== value.recovery.targetEra || value.pending.epoch !== value.recovery.targetEpoch)) {
    context.addIssue({ code: 'custom', message: 'Local Project recovery target does not match pending state' });
  }
});

const legacyDescriptorSchema = z.object({ epoch: epochSchema, ledgerSha256: digestSchema }).strict();
const legacyAnchorSchema = z.object({
  version: z.literal(LEGACY_ANCHOR_VERSION),
  committed: legacyDescriptorSchema.nullable(),
  pending: legacyDescriptorSchema.nullable()
}).strict().refine(value => value.committed !== null || value.pending !== null, 'Legacy Local Project anchor is empty');
const legacyRecoverySchema = z.object({ version: z.literal(1), operation: z.literal('reset-project-security') }).strict();

export type RecoveryIntent = z.infer<typeof recoverySchema>;
type Descriptor = z.infer<typeof descriptorSchema>;
type Coordinator = z.infer<typeof coordinatorSchema>;

let coordinatorPath = '';
let legacyAnchorPath = '';
let legacyRecoveryPath = '';

export function initLocalProjectStore(userDataDir: string): void {
  coordinatorPath = path.join(userDataDir, 'local-project-security.json');
  legacyAnchorPath = path.join(userDataDir, 'project-authority-anchor.json');
  legacyRecoveryPath = path.join(userDataDir, 'project-security-recovery.json');
}

function requireInitialized(): void {
  if (!coordinatorPath) throw new Error('Local Project store has not been initialized');
}

function sha256(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex');
}

function descriptor(state: AuthorityState, serialized: string): Descriptor {
  return { era: state.era, epoch: state.epoch, ledgerSha256: sha256(serialized) };
}

function sameDescriptor(left: Descriptor | null, right: Descriptor): boolean {
  return !!left && left.era === right.era && left.epoch === right.epoch && left.ledgerSha256 === right.ledgerSha256;
}

async function readJsonFile<T>(target: string, schema: z.ZodType<T>, label: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(target, 'utf8');
    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`${label} is invalid`);
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readCoordinator(): Promise<Coordinator | null> {
  requireInitialized();
  return readJsonFile(coordinatorPath, coordinatorSchema, 'Local Project security coordinator');
}

async function writeCoordinator(value: Coordinator): Promise<void> {
  requireInitialized();
  await atomicWriteJson(coordinatorPath, coordinatorSchema.parse(value));
}

export async function readLegacyResetIntent(): Promise<boolean> {
  requireInitialized();
  const marker = await readJsonFile(legacyRecoveryPath, legacyRecoverySchema, 'Legacy Local Project recovery marker');
  return marker !== null;
}

export async function restoreNativeAuthority(): Promise<{ state: AuthorityState; recovery: RecoveryIntent | null } | null> {
  requireInitialized();
  const [coordinator, serialized] = await Promise.all([
    readCoordinator(),
    readDurableStrictText(AUTHORITY_STATE)
  ]);
  if (!coordinator && serialized === null) return null;
  if (!coordinator || serialized === null) throw new Error('Local Project authority state is incomplete');

  let parsed: unknown;
  try { parsed = JSON.parse(serialized); }
  catch { throw new Error('Local Project authority ledger is malformed'); }
  const state = stateFromPersisted(parsed);
  const actual = descriptor(state, serialized);

  if (sameDescriptor(coordinator.pending, actual)) {
    // The exact intended ledger landed but the final coordinator write did not. Completing this
    // descriptor is the only recovery promotion allowed; epoch comparisons alone are never proof.
    await writeCoordinator({
      version: COORDINATOR_VERSION,
      committed: actual,
      pending: null,
      recovery: coordinator.recovery
    });
  } else if (sameDescriptor(coordinator.committed, actual)) {
    if (coordinator.pending) {
      // Intent landed but the ledger did not. The committed file is still authoritative; retire
      // the abandoned intent rather than accepting a different syntactically-valid future file.
      await writeCoordinator({
        version: COORDINATOR_VERSION,
        committed: coordinator.committed,
        pending: null,
        recovery: coordinator.recovery
      });
    }
  } else {
    throw new Error('Local Project authority ledger does not match its security coordinator');
  }
  return { state, recovery: coordinator.recovery };
}

export async function readLegacyAuthorityV1(): Promise<z.infer<typeof authorityV1Schema> | null> {
  requireInitialized();
  const [serialized, anchor] = await Promise.all([
    readDurableStrictText(LEGACY_AUTHORITY_STATE),
    readJsonFile(legacyAnchorPath, legacyAnchorSchema, 'Legacy Local Project authority anchor')
  ]);
  if (serialized === null && !anchor) return null;
  if (serialized === null || !anchor) throw new Error('Legacy Local Project authority state is incomplete');
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); }
  catch { throw new Error('Legacy Local Project authority ledger is malformed'); }
  const authority = authorityV1Schema.parse(parsed);
  const actual = { epoch: authority.epoch, ledgerSha256: sha256(serialized) };
  const matches = (candidate: z.infer<typeof legacyDescriptorSchema> | null) =>
    !!candidate && candidate.epoch === actual.epoch && candidate.ledgerSha256 === actual.ledgerSha256;
  if (!matches(anchor.committed) && !matches(anchor.pending)) {
    throw new Error('Legacy Local Project authority ledger does not match its anchor');
  }
  return authority;
}

/** Three-phase exact-snapshot commit for normal same-era mutations. */
export async function commitAuthority(previous: AuthorityState, next: AuthorityState): Promise<void> {
  requireInitialized();
  if (next.era !== previous.era || next.epoch !== previous.epoch + 1) {
    throw new Error('Invalid Local Project authority transition');
  }
  const serialized = serializeAuthority(next);
  const nextDescriptor = descriptor(next, serialized);
  const coordinator = await readCoordinator();
  if (!coordinator?.committed || coordinator.pending || coordinator.recovery) {
    throw new Error('Local Project security coordinator is not ready for mutation');
  }
  const previousSerialized = serializeAuthority(previous);
  if (!sameDescriptor(coordinator.committed, descriptor(previous, previousSerialized))) {
    throw new Error('Local Project runtime authority is not the committed durable generation');
  }
  await writeCoordinator({ version: COORDINATOR_VERSION, committed: coordinator.committed, pending: nextDescriptor, recovery: null });
  await writeDurableStrictSerializedNow(AUTHORITY_STATE, serialized);
  await writeCoordinator({ version: COORDINATOR_VERSION, committed: nextDescriptor, pending: null, recovery: null });
}

/**
 * Installs the first v2 snapshot. The activation recovery tag stays until config carries the same
 * era, so a crash cannot make a partially-established authority look like first use.
 */
export async function installInitialAuthority(state: AuthorityState): Promise<void> {
  requireInitialized();
  const serialized = serializeAuthority(state);
  const next = descriptor(state, serialized);
  const recovery: RecoveryIntent = {
    operation: 'activate-local-project-authority',
    targetEra: state.era,
    targetEpoch: state.epoch
  };
  await writeCoordinator({ version: COORDINATOR_VERSION, committed: null, pending: next, recovery });
  await writeDurableStrictSerializedNow(AUTHORITY_STATE, serialized);
  await writeCoordinator({ version: COORDINATOR_VERSION, committed: next, pending: null, recovery });
}

export async function clearRecoveryIntent(expected: RecoveryIntent): Promise<void> {
  const coordinator = await readCoordinator();
  if (!coordinator?.recovery || coordinator.recovery.operation !== expected.operation ||
      coordinator.recovery.targetEra !== expected.targetEra || coordinator.recovery.targetEpoch !== expected.targetEpoch) {
    throw new Error('Local Project recovery intent changed before retirement');
  }
  await writeCoordinator({ ...coordinator, recovery: null });
}

/** Explicit user-authorized reset may replace even a damaged previous coordinator. */
export async function writeResetIntent(intent: RecoveryIntent): Promise<void> {
  requireInitialized();
  if (intent.operation !== 'reset-local-project-security') throw new Error('Invalid Local Project reset intent');
  let committed: Descriptor | null = null;
  try { committed = (await readCoordinator())?.committed ?? null; }
  catch { /* reset is the recovery authority; do not trust malformed prior coordinator state */ }
  await writeCoordinator({ version: COORDINATOR_VERSION, committed, pending: null, recovery: intent });
}

/** Writes the reset target even when the previous authority is unavailable or from another era. */
export async function installResetAuthority(state: AuthorityState, intent: RecoveryIntent): Promise<void> {
  if (intent.operation !== 'reset-local-project-security' || state.era !== intent.targetEra || state.epoch !== intent.targetEpoch) {
    throw new Error('Local Project reset target does not match its recovery intent');
  }
  const serialized = serializeAuthority(state);
  const next = descriptor(state, serialized);
  const current = await readCoordinator();
  const committed = current?.committed ?? null;
  await writeCoordinator({ version: COORDINATOR_VERSION, committed, pending: next, recovery: intent });
  await writeDurableStrictSerializedNow(AUTHORITY_STATE, serialized);
  await writeCoordinator({ version: COORDINATOR_VERSION, committed: next, pending: null, recovery: intent });
}

export async function salvageAuthorityEpoch(): Promise<number> {
  let epoch = 0;
  try {
    const coordinator = await readCoordinator();
    epoch = Math.max(epoch, coordinator?.committed?.epoch ?? 0, coordinator?.pending?.epoch ?? 0, coordinator?.recovery?.targetEpoch ?? 0);
  } catch { /* explicit reset may replace damaged coordinator state */ }
  for (const name of [AUTHORITY_STATE, LEGACY_AUTHORITY_STATE]) {
    try {
      const raw = await readDurableStrictText(name);
      if (!raw) continue;
      const value = JSON.parse(raw) as { epoch?: unknown };
      if (typeof value.epoch === 'number' && Number.isSafeInteger(value.epoch) && value.epoch > 0) epoch = Math.max(epoch, value.epoch);
    } catch { /* salvage only independently valid scalar evidence */ }
  }
  return epoch;
}

export async function retireLegacyProjectSecurityFiles(): Promise<void> {
  requireInitialized();
  await Promise.all([
    writeDurableStrictSerializedNow(LEGACY_AUTHORITY_STATE, null).catch(error => logWarn(`could not retire legacy Local Project authority: ${(error as Error).message}`)),
    writeDurableStrictSerializedNow(LEGACY_PROJECTS_STATE, null).catch(error => logWarn(`could not retire legacy Local Project catalog: ${(error as Error).message}`)),
    atomicRemoveFile(legacyAnchorPath).catch(error => logWarn(`could not retire legacy Local Project anchor: ${(error as Error).message}`)),
    atomicRemoveFile(legacyRecoveryPath).catch(error => logWarn(`could not retire legacy Local Project recovery marker: ${(error as Error).message}`))
  ]);
}

export function resetLocalProjectStoreForTests(): void {
  coordinatorPath = '';
  legacyAnchorPath = '';
  legacyRecoveryPath = '';
}
