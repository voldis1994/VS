import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'RobotDeskPage.tsx'), 'utf8');

describe('RobotDesk multi-client deploy', () => {
  it('does not hijack +DEPLOY into SWITCH on the focused client', () => {
    expect(src).not.toMatch(/onClick=\{focused \? switchFocusedMarket : deploy\}/);
    expect(src).toMatch(/panelMode === 'switch'/);
    expect(src).toMatch(/pickDeployAccount/);
    expect(src).toMatch(/DEPLOY citu klientu/);
    expect(src).toMatch(/offerEurUsdShortcut/);
    expect(src).toMatch(/sessionInTrade/);
  });
});
