import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Mirrors master:verify artifacts_present honesty gates for manage_owner /
 * desk bridge — fails fast in unit tests without running full verify.
 */
describe('manage_owner verify-gate honesty', () => {
  const masterRoot = join(__dirname, '..');
  const dashboardPages = join(__dirname, '../../../../dashboard/src/pages');

  it('runtime status emits manage_owner + DESK_DEFERRED_HARD', () => {
    const body = readFileSync(join(masterRoot, 'runtime.ts'), 'utf8');
    expect(body).toMatch(/manage_owner:/);
    expect(body).toMatch(/resolveManageOwnerStatus/);
    expect(body).toMatch(/DESK_DEFERRED_HARD/);
  });

  it('MasterPage renders Manage owner card', () => {
    const page = join(dashboardPages, 'MasterPage.tsx');
    expect(existsSync(page)).toBe(true);
    const body = readFileSync(page, 'utf8');
    expect(body).toMatch(/manage_owner/);
    expect(body).toMatch(/Manage owner/);
  });

  it('RobotDeskPage renders MANAGE OWNER banner from board.manage_owner', () => {
    const page = join(dashboardPages, 'RobotDeskPage.tsx');
    expect(existsSync(page)).toBe(true);
    const body = readFileSync(page, 'utf8');
    expect(body).toMatch(/manage_owner/);
    expect(body).toMatch(/MANAGE OWNER/);
  });

  it('robotDesk board meta + MASTER BRIDGE start policy present', () => {
    const body = readFileSync(
      join(__dirname, '../../services/robotDesk.ts'),
      'utf8'
    );
    expect(body).toMatch(/manage_owner:/);
    expect(body).toMatch(/MASTER BRIDGE/);
    expect(body).toMatch(/deskSessionStartPolicy/);
  });
});
