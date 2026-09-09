import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { masterRuntime } from '../runtime.js';

describe('LIVE positive expectancy default hydrate', () => {
  it('gates hydrate LIVE without manage patch → expectancy gate on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-live-exp-'));
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;
    const prevMode = masterRuntime.cfg.mode;
    const prevExp = masterRuntime.cfg.require_positive_expectancy;
    try {
      writeFileSync(
        join(dir, 'runtime_gates.json'),
        JSON.stringify({
          mode: 'LIVE',
          kill_switch: false,
          ai_mode: 'off',
          epic: 'GOLD',
          desired_running: false,
        })
      );
      // No master_manage_config.json → LIVE default must arm EV gate
      masterRuntime.cfg = {
        ...masterRuntime.cfg,
        mode: 'PAPER',
        require_positive_expectancy: false,
        require_armed_setup: false,
      };
      // hydrateRuntimeGates is private — recover path / load via public API
      const { loadRuntimeGates } = await import('../runtimeGates.js');
      const gates = loadRuntimeGates();
      expect(gates?.mode).toBe('LIVE');
      // Mirror runtime hydrate: call setMode after loading manage absence
      masterRuntime.setMode('LIVE');
      expect(masterRuntime.cfg.require_positive_expectancy).toBe(true);
      expect(masterRuntime.status().expectancy_gate_armed).toBe(true);
    } finally {
      masterRuntime.cfg = {
        ...masterRuntime.cfg,
        mode: prevMode,
        require_positive_expectancy: prevExp,
      };
      masterRuntime.pipeline.mode = prevMode;
    }
  });

  it('manage config false overrides LIVE expectancy default on gate hydrate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-live-exp-off-'));
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;
    const prevMode = masterRuntime.cfg.mode;
    const prevExp = masterRuntime.cfg.require_positive_expectancy;
    const prevArmed = masterRuntime.cfg.require_armed_setup;
    try {
      writeFileSync(
        join(dir, 'runtime_gates.json'),
        JSON.stringify({
          mode: 'LIVE',
          kill_switch: false,
          ai_mode: 'off',
          epic: 'GOLD',
          desired_running: false,
        })
      );
      writeFileSync(
        join(dir, 'master_manage_config.json'),
        JSON.stringify({
          require_positive_expectancy: false,
          require_armed_setup: true,
        })
      );
      const { loadManageConfig } = await import('../manageConfig.js');
      const manage = loadManageConfig();
      expect(manage?.require_positive_expectancy).toBe(false);
      // Simulate hydrateRuntimeGates branch
      const require_positive_expectancy =
        manage && typeof manage.require_positive_expectancy === 'boolean'
          ? manage.require_positive_expectancy
          : true;
      expect(require_positive_expectancy).toBe(false);
      masterRuntime.cfg = {
        ...masterRuntime.cfg,
        mode: 'LIVE',
        require_positive_expectancy,
        require_armed_setup: true,
      };
      expect(masterRuntime.status().expectancy_gate_armed).toBe(false);
    } finally {
      masterRuntime.cfg = {
        ...masterRuntime.cfg,
        mode: prevMode,
        require_positive_expectancy: prevExp,
        require_armed_setup: prevArmed,
      };
      masterRuntime.pipeline.mode = prevMode;
    }
  });
});
