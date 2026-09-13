import path from 'node:path';
import { z } from 'zod';
import { sessionsRoot } from './store.js';

/**
 * Physical store shared by authored input attachments and derived image projections.
 *
 * The directory name predates projections and stays stable for compatibility. Semantic ownership
 * remains in input-attachments.ts and input-image-projection.ts; this module owns only path safety
 * and serialization against pruning/writes.
 */
function directory(): string {
  const root = sessionsRoot();
  if (!root) throw new Error('Session storage is not ready');
  return path.join(path.dirname(root), 'input-attachments');
}

export function inputBlobDirectory(): string { return directory(); }

export function inputBlobFile(id: string): string {
  return path.join(directory(), z.string().uuid().parse(id));
}

let writes: Promise<unknown> = Promise.resolve();

export function serializeInputBlobStore<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work, work);
  writes = next.then(() => undefined, () => undefined);
  return next;
}
