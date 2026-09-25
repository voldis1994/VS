/**
 * CLI entry — `npm run brain:self-improve` / BRAIN.bat
 * Continuous autonomous cycles with realtime CMD output.
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
  const intervalSec = (() => {
    const i = process.argv.indexOf('--interval');
    if (i >= 0 && process.argv[i + 1]) return Math.max(30, Number(process.argv[i + 1]) || 180);
    return Number(process.env.BRAIN_CYCLE_INTERVAL_SEC) || 180;
  })();

  brainBanner();
  const g = getBrainGenome();
  const exp = loadExperience();
  brainLog(`Genome v${g.version} · Keep=${g.peak_keep} · wait1m=${g.wait_on_1m_fight}`);
  brainLog(
    `Pieredze: cycles=${exp.cycles.length} rejected=${exp.rejected_signatures.length} accepted=${exp.accepted_signatures.length}`
  );
  brainLog(`Guards: lot/broker/security/auth — BLOĶĒTI · trading decision files — ATĻAUTI`);
  brainLog(once ? 'Mode: --once' : `Mode: loop every ${intervalSec}s`);

  let n = 0;
  for (;;) {
    n += 1;
    brainSection(`CIKLS #${n}`);
    try {
      const result = await runBrainCycle({ once });
      brainLog(`REZULTĀTS: ${result.decision} · ${result.reason}`);
    } catch (err) {
      brainLog(`CIKLA KĻŪDA: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (once) break;
    brainLog(`Gaidu ${intervalSec}s līdz nākamajam ciklam...`);
    await sleep(intervalSec * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
