/**
 * Check- trading hours — within_trading_hours (weekday Mon=0, hard hours 0–23).
 */
export type DayHours = {
  on: boolean;
  start: number;
  end: number;
};

export type TradingHoursConfig = {
  enabled: boolean;
  /** Keys "0".."6" — Monday=0 … Sunday=6 (Check- convention) */
  hours: Record<string, DayHours>;
};

/** Default: Sat/Sun off; weekdays full day — mirrors Check- automation DEFAULTS. */
export const DEFAULT_TRADING_HOURS: TradingHoursConfig = {
  enabled: false,
  hours: {
    '0': { on: true, start: 0, end: 23 },
    '1': { on: true, start: 0, end: 23 },
    '2': { on: true, start: 0, end: 23 },
    '3': { on: true, start: 0, end: 23 },
    '4': { on: true, start: 0, end: 23 },
    '5': { on: false, start: 0, end: 23 },
    '6': { on: false, start: 0, end: 23 },
  },
};

/** Check- within_trading_hours — UTC weekday/hour. */
export function withinTradingHours(
  cfg: TradingHoursConfig | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!cfg?.enabled) return true;
  const d = new Date(nowMs);
  // JS: Sun=0 … Sat=6 → Check-: Mon=0 … Sun=6
  const jsDay = d.getUTCDay();
  const weekday = jsDay === 0 ? 6 : jsDay - 1;
  const hour = d.getUTCHours();
  const day = cfg.hours?.[String(weekday)] ?? { on: true, start: 0, end: 23 };
  if (!day.on) return false;
  const start = Math.max(0, Math.min(23, Number(day.start) || 0));
  const end = Math.max(0, Math.min(23, Number(day.end) || 23));
  if (start <= end) return hour >= start && hour <= end;
  // Wrap overnight (e.g. 22→6)
  return hour >= start || hour <= end;
}
