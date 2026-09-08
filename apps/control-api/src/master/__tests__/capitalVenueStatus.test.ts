import { afterEach, describe, expect, it } from 'vitest';
import { createCapitalBroker } from '../capitalFactory.js';
import { PaperBroker } from '../broker.js';
import { masterRuntime } from '../runtime.js';

describe('MASTER Capital epic + status venue', () => {
  afterEach(() => {
    masterRuntime.stop();
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.setEpic('GOLD');
  });

  it('attach Capital normalizes XAUUSD → GOLD', () => {
    masterRuntime.ensurePaperBroker();
    masterRuntime.setEpic('XAUUSD');
    expect(masterRuntime.epic).toBe('XAUUSD'); // paper keeps alias
    const broker = createCapitalBroker({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'i',
      password: 'p',
    });
    masterRuntime.attachBroker(broker);
    expect(masterRuntime.epic).toBe('GOLD');
  });

  it('status reports Capital venue + attach flags', () => {
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    const paper = masterRuntime.status();
    expect(paper.primary_live_venue).toBe('capital.com_api_direct');
    expect(paper.capital_live_attached).toBe(false);

    const broker = createCapitalBroker({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'i',
      password: 'p',
    });
    masterRuntime.attachBroker(broker);
    masterRuntime.setMode('LIVE');
    const live = masterRuntime.status();
    expect(live.capital_live_attached).toBe(true);
    expect(live.broker).toBe('CAPITAL');
    // Before any equity tick — must not advertise LIVE_RUNNING / proven
    expect(live.capital_account_proven).toBe(false);
    expect(live.health).toBe('LIVE_ACCOUNT_UNPROVEN');
  });
});
