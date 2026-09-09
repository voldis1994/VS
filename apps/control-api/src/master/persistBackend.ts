/**
 * Honest persist backend label for MASTER status / dashboard.
 */
import { DualPersist } from './dualPersist.js';
import { FilePersist } from './filePersist.js';
import { getPersistClient, MemoryPersist } from './persist.js';

export type PersistBackendKind = 'dual' | 'file' | 'memory' | 'pool' | 'unknown';

export function resolvePersistBackend(
  c = getPersistClient()
): PersistBackendKind {
  try {
    if (c instanceof DualPersist) return 'dual';
    if (c instanceof FilePersist) return 'file';
    if (c instanceof MemoryPersist) return 'memory';
    if (c && typeof (c as { query?: unknown }).query === 'function') {
      return 'pool';
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}
