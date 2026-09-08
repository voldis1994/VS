import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../broker.js';
import {
  classifyLiveSmokeBroker,
  credentialSourceFromDetail,
} from '../liveSmokeGate.js';

describe('liveSmokeGate — env + Brokers desk honesty', () => {
  it('skips when neither CAPITAL_* nor Brokers desk creds', () => {
    const paper = new PaperBroker();
    const gate = classifyLiveSmokeBroker({
      ok: false,
      broker: paper,
      mode: 'PAPER',
      detail: 'live_requested_but_CAPITAL_*_missing_and_desk_capital_no_enabled_connection',
    });
    expect(gate.action).toBe('skip');
    if (gate.action === 'skip') {
      expect(gate.detail).toMatch(/Brokers DB/i);
    }
  });

  it('proceeds for desk-connected Capital LIVE (no CAPITAL_* env)', () => {
    const gate = classifyLiveSmokeBroker({
      ok: true,
      broker: { name: 'CAPITAL', paper: false } as any,
      mode: 'LIVE',
      detail: 'capital_desk_connected:desk_db:conn=42:pool=900001',
    });
    expect(gate).toEqual({ action: 'proceed', credentialSource: 'desk' });
  });

  it('proceeds for env-connected Capital LIVE', () => {
    const gate = classifyLiveSmokeBroker({
      ok: true,
      broker: { name: 'CAPITAL', paper: false } as any,
      mode: 'LIVE',
      detail: 'capital_env_connected:pool=900001',
    });
    expect(gate).toEqual({ action: 'proceed', credentialSource: 'env' });
  });

  it('fails when Capital LIVE resolve connect failed', () => {
    const gate = classifyLiveSmokeBroker({
      ok: false,
      broker: { name: 'CAPITAL', paper: false } as any,
      mode: 'LIVE',
      detail: 'capital_connect_failed:capital_desk_connected:desk_db:conn=1:error.error.invalid.details',
    });
    expect(gate.action).toBe('fail');
  });

  it('credentialSourceFromDetail maps env vs desk', () => {
    expect(credentialSourceFromDetail('capital_env_connected:pool=1')).toBe('env');
    expect(credentialSourceFromDetail('capital_desk_connected:desk_db:conn=9')).toBe('desk');
    expect(credentialSourceFromDetail('other')).toBe('unknown');
  });
});
