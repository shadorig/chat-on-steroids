import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Flushes directory metadata where Node exposes a useful directory fsync contract. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Replaces one file atomically after flushing the replacement bytes.
 *
 * The caller owns transaction semantics. This primitive performs no retry, coalescing or
 * publication: security code can therefore know that a rejected write will never appear later.
 */
export async function atomicWriteFile(target: string, contents: string | Uint8Array): Promise<void> {
  const directory = path.dirname(target);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  try {
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
    await syncDirectory(directory);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function atomicWriteJson(target: string, value: unknown, pretty = false): Promise<void> {
  return atomicWriteFile(target, JSON.stringify(value, null, pretty ? 2 : undefined));
}

/** Removes a file and durably records the directory entry removal where supported. */
export async function atomicRemoveFile(target: string): Promise<void> {
  await fs.rm(target, { force: true });
  await syncDirectory(path.dirname(target));
}
