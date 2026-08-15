/**
 * VS CORE version pins — never conflate software vs strategy vs config vs DB.
 * STRATEGY_BASELINE_STATUS remains HISTORICAL_STRATEGY_NOT_PROVEN until host SHA proof.
 */

export const CORE_VERSION = '0.1.0-vs-core';
export const STRATEGY_VERSION = 'node-robot-desk-main-c123101';
export const CONFIG_VERSION = '1';
export const DB_SCHEMA_VERSION = '010';

/** Runtime proof status for the overnight historical strategy. */
export const STRATEGY_BASELINE_STATUS = 'HISTORICAL_STRATEGY_NOT_PROVEN' as const;
export const STRATEGY_BASELINE_CANDIDATE_SHA = 'e0e479a';
export const FREEZE_COMMIT = 'c123101478126b23df4d87751680dd53f8c204ec';

export type VersionBundle = {
  core_version: string;
  strategy_version: string;
  config_version: string;
  db_schema_version: string;
  strategy_baseline_status: typeof STRATEGY_BASELINE_STATUS;
  strategy_baseline_candidate_sha: string;
  freeze_commit: string;
  git_commit?: string;
};

export function versionBundle(gitCommit?: string): VersionBundle {
  return {
    core_version: CORE_VERSION,
    strategy_version: STRATEGY_VERSION,
    config_version: CONFIG_VERSION,
    db_schema_version: DB_SCHEMA_VERSION,
    strategy_baseline_status: STRATEGY_BASELINE_STATUS,
    strategy_baseline_candidate_sha: STRATEGY_BASELINE_CANDIDATE_SHA,
    freeze_commit: FREEZE_COMMIT,
    git_commit: gitCommit,
  };
}
