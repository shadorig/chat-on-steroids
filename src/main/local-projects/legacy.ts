import path from 'node:path';
import { z } from 'zod';
import type { LocalProject } from '../../shared/projects.js';
import { readDurableStrict } from '../durable.js';

const LEGACY_PROJECTS_STATE = 'projects';
const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(160),
  path: z.string().min(1).max(32768).refine(path.isAbsolute),
  createdAt: z.number().finite().nonnegative(),
  ungrouped: z.boolean().optional()
}).strict();
const projectsSchema = z.array(projectSchema).max(200);
const currentCatalogSchema = z.object({ version: z.literal(1), projects: projectsSchema }).strict();

export type LegacyProjectCatalog =
  | { format: 'absent'; projects: readonly LocalProject[] }
  | { format: 'legacy'; projects: readonly LocalProject[] }
  | { format: 'current-v1'; projects: readonly LocalProject[] };

/**
 * `projects.json` is migration input only. No post-v2 code writes it or consults it for current
 * project state, so a stale/rolled-back catalog can never widen or disable live authority.
 */
export async function readLegacyProjectCatalog(): Promise<LegacyProjectCatalog> {
  const raw = await readDurableStrict<unknown>(LEGACY_PROJECTS_STATE);
  if (raw === null) return { format: 'absent', projects: [] };
  const legacy = projectsSchema.safeParse(raw);
  if (legacy.success) return { format: 'legacy', projects: legacy.data };
  const current = currentCatalogSchema.safeParse(raw);
  if (current.success) return { format: 'current-v1', projects: current.data.projects };
  throw new Error('Legacy Local Project catalog is invalid');
}
