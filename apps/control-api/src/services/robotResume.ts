/**
 * Persist running robots across BRAIN soft-reload (exit 75).
 *
 * Without this, live-loop restart wipes in-memory sessions → dashboard ghost
 * "ARMED …" + "Robot session not found" + LIVE LOG stale forever.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../');
}

export function robotResumePath(): string {
  return path.join(repoRoot(), 'data', 'brain-self-improve', 'robot-resume.json');
}

export type RobotResumeEntry = {
  account_id: number;
  epic: string;
  lot_size: number;
  display_name?: string;
  trading_enabled: boolean;
  entry_enabled: boolean;
};

export type RobotResumeFile = {
  at: string;
  reason: string;
  robots: RobotResumeEntry[];
};

export function saveRobotResume(
  robots: RobotResumeEntry[],
  reason = 'BRAIN code reload (exit 75)'
): void {
  if (!robots.length) {
    clearRobotResume();
    return;
  }
  const p = robotResumePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body: RobotResumeFile = {
    at: new Date().toISOString(),
    reason,
    robots,
  };
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

export function clearRobotResume(): void {
  const p = robotResumePath();
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

export function loadRobotResume(): RobotResumeEntry[] {
  const p = robotResumePath();
  try {
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<RobotResumeFile>;
    const list = Array.isArray(raw.robots) ? raw.robots : [];
    return list
      .map((r) => ({
        account_id: Number(r.account_id),
        epic: String(r.epic || '').trim(),
        lot_size: Number(r.lot_size),
        display_name: r.display_name ? String(r.display_name) : undefined,
        trading_enabled: r.trading_enabled !== false,
        entry_enabled: r.entry_enabled !== false,
      }))
      .filter(
        (r) =>
          Number.isFinite(r.account_id) &&
          r.account_id > 0 &&
          r.epic &&
          Number.isFinite(r.lot_size) &&
          r.lot_size > 0
      );
  } catch {
    return [];
  }
}

/** Load snapshot then delete file (one-shot after live-loop restart). */
export function consumeRobotResume(): RobotResumeEntry[] {
  const robots = loadRobotResume();
  clearRobotResume();
  return robots;
}
