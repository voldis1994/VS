import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { masterRuntime } from '../master/runtime.js';
import {
  deskSessionStartPolicy,
  robotBoardMeta,
} from './robotDesk.js';

describe('desk owns-pipeline bridge honesty', () => {
  it('forces MASTER BRIDGE + entry OFF when owns_pipeline ON', () => {
    const prevPref = masterRuntime.owns_pipeline_pref;
    const prevEnv = process.env.MASTER_OWNS_PIPELINE;
    try {
      masterRuntime.owns_pipeline_pref = null;
      delete process.env.MASTER_OWNS_PIPELINE;
      const off = deskSessionStartPolicy(true);
      expect(off.owns_pipeline).toBe(false);
      expect(off.entry_enabled).toBe(true);
      expect(off.brain_label).toBe('OWN BRAIN');
      expect(off.rules_detail).toMatch(/BEST OUTCOME/);

      masterRuntime.setOwnsPipeline(true);
      const on = deskSessionStartPolicy(true);
      expect(on.owns_pipeline).toBe(true);
      expect(on.entry_enabled).toBe(false);
      expect(on.brain_label).toBe('MASTER BRIDGE');
      expect(on.rules_detail).toMatch(/entry OFF/);
      expect(on.rules_detail).not.toMatch(/BEST OUTCOME · never shared/);

      // Even if caller requests entry, owns forces OFF
      expect(deskSessionStartPolicy(true).entry_enabled).toBe(false);
    } finally {
      masterRuntime.owns_pipeline_pref = prevPref;
      if (prevEnv === undefined) delete process.env.MASTER_OWNS_PIPELINE;
      else process.env.MASTER_OWNS_PIPELINE = prevEnv;
    }
  });

  it('robotBoardMeta exposes owns + manage_owner and drops OWN BRAIN chain when owns ON', () => {
    const prevPref = masterRuntime.owns_pipeline_pref;
    const prevEnv = process.env.MASTER_OWNS_PIPELINE;
    try {
      masterRuntime.setOwnsPipeline(false);
      const legacy = robotBoardMeta([]);
      expect(legacy.owns_pipeline).toBe(false);
      expect(legacy.kicker).toMatch(/OWN BRAIN/);
      expect(legacy.chain).toMatch(/BEST OUTCOME/);

      masterRuntime.setOwnsPipeline(true);
      masterRuntime.setDeskManageOwnerHint('DESK_DEFERRED_HARD');
      const bridge = robotBoardMeta([]);
      expect(bridge.owns_pipeline).toBe(true);
      expect(bridge.manage_owner).toBe('DESK_DEFERRED_HARD');
      expect(bridge.kicker).toMatch(/MASTER PIPELINE BRIDGE/);
      expect(bridge.chain).toMatch(/MASTER pipeline/);
      expect(bridge.chain).not.toMatch(/BEST OUTCOME/);
      expect(bridge.note).toMatch(/entry OFF/);
    } finally {
      masterRuntime.owns_pipeline_pref = prevPref;
      if (prevEnv === undefined) delete process.env.MASTER_OWNS_PIPELINE;
      else process.env.MASTER_OWNS_PIPELINE = prevEnv;
      masterRuntime.setDeskManageOwnerHint('MASTER');
    }
  });

  it('startRobotSession wires deskSessionStartPolicy (source)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./robotDesk.ts', import.meta.url)),
      'utf8'
    );
    expect(src).toMatch(/deskSessionStartPolicy/);
    expect(src).toMatch(/startPolicy\.brain_label/);
    expect(src).toMatch(/startPolicy\.entry_enabled/);
    expect(src).toMatch(/MASTER BRIDGE/);
  });
});
