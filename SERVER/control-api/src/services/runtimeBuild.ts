import { execFileSync } from 'node:child_process';
import { TREND_LOOKBACK_MINUTES } from './entryFromRegime.js';

let cachedSha: string | null = null;

function gitShortSha(): string {
  if (cachedSha) return cachedSha;
  const env = String(process.env.BUILD_SHA || '').trim();
  if (env) {
    cachedSha = env;
    return env;
  }
  for (const cwd of [process.cwd(), `${process.cwd()}/../..`, `${process.cwd()}/..`]) {
    try {
      const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (sha) {
        cachedSha = sha;
        return sha;
      }
    } catch {
      /* try next */
    }
  }
  cachedSha = 'unknown';
  return cachedSha;
}

const STRATEGY_VERSION = 'with-trend-10s-sl020-v1';

function buildTimeIso(): string {
  const env = String(process.env.BUILD_TIME || '').trim();
  if (env) return env;
  return new Date().toISOString();
}

function packageVersion(): string {
  const env = String(process.env.VS_VERSION || process.env.npm_package_version || '').trim();
  return env || '1.0.0';
}

/** Visible proof that VS.bat actually booted this code — not a stale process. */
export function runtimeBuildInfo() {
  const git = gitShortSha();
  const serverId = String(process.env.VS_SERVER_ID || 'VS-CORE-01').trim() || 'VS-CORE-01';
  return {
    // Identity — MSI discovery must validate these (non-secret)
    service: 'VS-CORE' as const,
    server_id: serverId,
    /** Legacy MSI scripts checked `name` before server_id was canonical. */
    name: serverId,
    api_version: 'v1',
    VERSION: packageVersion(),
    GIT_COMMIT: git,
    BUILD_TIME: buildTimeIso(),
    STRATEGY_VERSION,
    version: packageVersion(),
    git_sha: git,
    build_commit: git,
    build_time: buildTimeIso(),
    strategy_version: STRATEGY_VERSION,
    status: 'ok',
    sl: '2.5%-of-price',
    trend_minutes: TREND_LOOKBACK_MINUTES,
    entry_brain: 'node-robot-desk',
    /** Proof this Node build unlocks with-trend entries when classifier says UNKNOWN. */
    unknown_bias_unlock: true,
    /** HISTORICAL STRATEGY NOT PROVEN — no .vs-build-sha for exact host runtime. */
    historical_strategy: 'NOT_PROVEN' as const,
  };
}
