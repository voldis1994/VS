import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import {
  clearRobotResume,
  consumeRobotResume,
  loadRobotResume,
  robotResumePath,
  saveRobotResume,
} from './robotResume.js';

describe('robotResume — persist across BRAIN exit 75', () => {
  beforeEach(() => clearRobotResume());
  afterEach(() => clearRobotResume());

  it('saves and consumes running robots one-shot', () => {
    saveRobotResume(
      [
        {
          account_id: 1,
          epic: 'GOLD',
          lot_size: 0.2,
          display_name: 'Gold',
          trading_enabled: true,
          entry_enabled: true,
        },
      ],
      'unit'
    );
    expect(fs.existsSync(robotResumePath())).toBe(true);
    expect(loadRobotResume()).toHaveLength(1);
    const once = consumeRobotResume();
    expect(once).toEqual([
      {
        account_id: 1,
        epic: 'GOLD',
        lot_size: 0.2,
        display_name: 'Gold',
        trading_enabled: true,
        entry_enabled: true,
      },
    ]);
    expect(loadRobotResume()).toHaveLength(0);
    expect(fs.existsSync(robotResumePath())).toBe(false);
  });

  it('rejects garbage entries', () => {
    const p = robotResumePath();
    fs.mkdirSync(pathDir(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        robots: [{ account_id: 0, epic: '', lot_size: -1 }],
      })
    );
    expect(loadRobotResume()).toHaveLength(0);
  });
});

function pathDir(p: string): string {
  return p.replace(/[/\\][^/\\]+$/, '');
}
