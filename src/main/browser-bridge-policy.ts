import type { Config } from '../shared/types.js';
import { configuredBrowserBridgeRequired } from '../shared/types.js';
import { projectBrowserBridgeRequired } from './local-projects/service.js';

/**
 * One main-process answer for whether the companion extension must be available. Config owns the
 * ordinary browser-backed features; Local Project authority adds a durable runtime requirement.
 * If project authority is unavailable, keep the bridge up rather than changing browser identity
 * availability as a side effect of the security failure.
 */
export async function browserBridgeRequired(config: Pick<Config, 'sessions' | 'multiAgent'>): Promise<boolean> {
  if (configuredBrowserBridgeRequired(config)) return true;
  try {
    return await projectBrowserBridgeRequired();
  } catch {
    return true;
  }
}
