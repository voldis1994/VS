/**
 * Realtime CMD console for the brain self-improve agent.
 */
export function brainLog(line: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${line}`);
}

export function brainBanner(): void {
  console.log('');
  console.log('============================================================');
  console.log('  VS BRAIN SELF-IMPROVE  —  autonomas trading smadzenes');
  console.log('  NEAIZVER SO LOGU  ·  ACCEPTED/REJECTED katra cikla beigas');
  console.log('  Galvena sistema = VS.bat (API/UI/robot); sis logs = masanas');
  console.log('============================================================');
  console.log('');
}

export function brainSection(title: string): void {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
}

export function brainDecision(
  decision: 'ACCEPTED' | 'REJECTED' | 'SKIPPED',
  detail: string
): void {
  const bar = '='.repeat(58);
  console.log('');
  console.log(bar);
  console.log(`  ★ ${decision}`);
  console.log(`  ${detail.slice(0, 200)}`);
  console.log(bar);
  console.log('');
}
