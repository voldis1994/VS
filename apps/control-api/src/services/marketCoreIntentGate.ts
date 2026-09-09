/**
 * Market Core EntryReady vs MASTER owns — single authoritative entry gate.
 * When MASTER owns the pipeline, C++ Market Core must not open Client books.
 */
import { masterOwnsPipeline } from '../master/deskBridge.js';

/**
 * Allow Market Core `/api/pipeline/intents` EntryReady fanout.
 * Default: blocked while MASTER owns_pipeline.
 * Escape hatch: MASTER_ALLOW_MARKET_CORE_INTENTS=true (emergency / dual-brain lab only).
 */
export function marketCoreEntryIntentsAllowed(): boolean {
  if ((process.env.MASTER_ALLOW_MARKET_CORE_INTENTS || '').trim() === 'true') {
    return true;
  }
  return !masterOwnsPipeline();
}

export function marketCoreEntryIntentRefusal(): {
  refused: true;
  error: string;
  message: string;
  owns_pipeline: boolean;
  allow_env: boolean;
} {
  return {
    refused: true,
    error: 'MASTER_OWNS_PIPELINE',
    message:
      'Market Core EntryReady refused — MASTER owns the authoritative pipeline (use MASTER OPEN fanout). Set MASTER_ALLOW_MARKET_CORE_INTENTS=true only for emergency dual-brain.',
    owns_pipeline: masterOwnsPipeline(),
    allow_env:
      (process.env.MASTER_ALLOW_MARKET_CORE_INTENTS || '').trim() === 'true',
  };
}
