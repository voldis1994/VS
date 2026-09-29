import {
  BRAIN_RELOAD_EXIT_CODE,
  MAX_CRASH_BURST,
  classifyLiveLoopExit,
  planCrashRestart,
} from './control-api-live-loop-policy.mjs';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg);
    process.exit(1);
  }
}

assert(classifyLiveLoopExit({ code: BRAIN_RELOAD_EXIT_CODE, signal: null }) === 'brain_reload', '75=reload');
assert(classifyLiveLoopExit({ code: 0, signal: null }) === 'clean_stop', '0=clean');
assert(classifyLiveLoopExit({ code: 1, signal: 'SIGINT' }) === 'signal_stop', 'SIGINT stop');
assert(classifyLiveLoopExit({ code: 1, signal: null }) === 'crash_restart', '1=crash');
assert(classifyLiveLoopExit({ code: 137, signal: null }) === 'crash_restart', '137=crash');

const t0 = 1_000_000;
let plan = planCrashRestart([], t0);
assert(!plan.giveUp, 'first crash keeps going');
assert(plan.delayMs > 0, 'first crash has backoff');
assert(plan.crashesInWindow === 1, 'count=1');

let times = plan.crashTimesMs;
for (let i = 1; i < MAX_CRASH_BURST - 1; i++) {
  plan = planCrashRestart(times, t0 + i * 1000);
  times = plan.crashTimesMs;
  assert(!plan.giveUp, `crash ${i + 1} still ok`);
}
plan = planCrashRestart(times, t0 + MAX_CRASH_BURST * 1000);
assert(plan.giveUp, 'burst gives up');
assert(plan.crashesInWindow === MAX_CRASH_BURST, 'burst count');

// Old crashes outside window do not count
plan = planCrashRestart([t0 - 200_000], t0);
assert(plan.crashesInWindow === 1, 'stale crash dropped');
assert(!plan.giveUp, 'stale does not give up');

console.log('OK control-api-live-loop-policy');
