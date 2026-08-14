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

/** Visible proof that VS.bat actually booted this code — not a stale process. */
export function runtimeBuildInfo() {
  return {
    git_sha: gitShortSha(),
    sl: '0.20%-of-price',
    trend_minutes: TREND_LOOKBACK_MINUTES,
    entry_brain: 'node-robot-desk',
    /** Proof this Node build unlocks with-trend entries when classifier says UNKNOWN. */
    unknown_bias_unlock: true,
  };
}
