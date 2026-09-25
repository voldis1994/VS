/**
 * CLI entry — `npm run brain:self-improve` / BRAIN.bat
 * Continuous autonomous cycles — no idle wait between learns (default).
 */
import { brainBanner, brainLog, brainSection } from './consoleUi.js';
import { runBrainCycle } from './loop.js';
import { loadExperience } from './experience.js';
import { getBrainGenome } from './brainGenome.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  /** 0 = continuous (default). Optional --interval N for throttle. */
  const intervalSec = (() => {
    const i = process.argv.indexOf('--interval');
    if (i >= 0 && process.argv[i + 1] != null) {
      return Math.max(0, Number(process.argv[i + 1]) || 0);
    }
    if (process.env.BRAIN_CYCLE_INTERVAL_SEC != null && process.env.BRAIN_CYCLE_INTERVAL_SEC !== '') {
      return Math.max(0, Number(process.env.BRAIN_CYCLE_INTERVAL_SEC) || 0);
    }
    return 0;
  })();

  brainBanner();
  const g = getBrainGenome();
  const exp = loadExperience();
  brainLog(`Genome v${g.version} · Keep=${g.peak_keep} · wait1m=${g.wait_on_1m_fight}`);
  brainLog(
    `Pieredze: cycles=${exp.cycles.length} rejected=${exp.rejected_signatures.length} accepted=${exp.accepted_signatures.length}`
  );
  brainLog(
    `Guards: LOT + broker/security/auth/core — BLOĶĒTI · visa trading loģika (režīmi/likumi/entry/exit/manage) — ATĻAUTA`
  );
  brainLog(
    once
      ? 'Mode: --once'
      : intervalSec > 0
        ? `Mode: loop every ${intervalSec}s`
        : 'Mode: CONTINUOUS — mācās uzreiz, bez pauzes starp cikliem'
  );

  let n = 0;
  for (;;) {
    n += 1;
    brainSection(`CIKLS #${n}`);
    try {
      const result = await runBrainCycle({ once });
      brainLog(`REZULTĀTS: ${result.decision} · ${result.reason}`);
    } catch (err) {
      brainLog(`CIKLA KĻŪDA: ${err instanceof Error ? err.message : String(err)}`);
      // Brief backoff only on hard errors so we don't spin a tight crash loop
      if (!once) await sleep(1000);
    }
    if (once) break;
    if (intervalSec > 0) {
      brainLog(`Gaidu ${intervalSec}s līdz nākamajam ciklam...`);
      await sleep(intervalSec * 1000);
    } else {
      // Tiny yield so CMD stays responsive; next cycle starts immediately
      await sleep(50);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
