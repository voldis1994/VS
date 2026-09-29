/**
 * Live control-api runner — NO tsx watch.
 * Exit code 75 = BRAIN accepted .ts patches while FLAT → restart to load new code.
 * Mid-trade file writes must NOT kill the API (that caused Failed to fetch).
 *
 * Any OTHER crash also restarts (with backoff). Previously the loop exited on the
 * first non-75 failure → permanent empty board / "Failed to fetch" until VS.bat.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRAIN_RELOAD_EXIT_CODE,
  classifyLiveLoopExit,
  planCrashRestart,
} from './control-api-live-loop-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const apiDir = path.join(root, 'apps', 'control-api');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runOnce() {
  return new Promise((resolve) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCmd, ['run', 'dev:live'], {
      cwd: apiDir,
      stdio: 'inherit',
      env: { ...process.env, CONTROL_API_LIVE_LOOP: '1' },
      shell: process.platform === 'win32',
    });
    child.on('exit', (code, signal) => {
      resolve({ code: code == null ? 1 : code, signal });
    });
  });
}

console.log(
  '[control-api-live] start (no watch) — BRAIN reload=exit 75; other crashes auto-restart'
);

let crashTimesMs = [];

for (;;) {
  const result = await runOnce();
  const kind = classifyLiveLoopExit(result);

  if (kind === 'brain_reload') {
    console.log(
      `[control-api-live] BRAIN code reload (exit ${BRAIN_RELOAD_EXIT_CODE}) — restarting API…`
    );
    crashTimesMs = [];
    continue;
  }

  if (kind === 'clean_stop') {
    console.log('[control-api-live] clean exit 0 — stopping');
    process.exit(0);
  }

  if (kind === 'signal_stop') {
    console.log(`[control-api-live] killed by ${result.signal}`);
    process.exit(0);
  }

  const plan = planCrashRestart(crashTimesMs);
  crashTimesMs = plan.crashTimesMs;
  console.error(
    `[control-api-live] unexpected exit ${result.code}` +
      (result.signal ? ` (signal ${result.signal})` : '') +
      ` · crash ${plan.crashesInWindow} in window`
  );

  if (plan.giveUp) {
    console.error(
      '[control-api-live] too many crashes — stopping. Fix MR-ControlAPI error, then re-run VS.bat'
    );
    process.exit(result.code || 1);
  }

  console.log(`[control-api-live] restarting API in ${plan.delayMs}ms…`);
  await sleep(plan.delayMs);
}
