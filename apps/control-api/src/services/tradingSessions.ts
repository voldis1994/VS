/**
 * Capital.com instrument opening hours for gap classification.
 * NEVER guess from EPIC name, asset type, or gap length.
 * Without proven Capital hours → UNKNOWN = NOT_READY.
 */

export type CapitalDayWindow = {
  /** 0=Sun … 6=Sat in `timezone` */
  open_dow: number;
  /** Minutes from local midnight */
  open_min: number;
  close_dow: number;
  close_min: number;
};

export type CapitalOpeningHours = {
  /** IANA / UTC — from Capital when present, else UTC wire default */
  timezone: string;
  timezone_from_capital: boolean;
  windows: CapitalDayWindow[];
  /** Every weekday fully covered 00:00–24:00 */
  continuously_open: boolean;
  detail: string;
};

const DAY_NAME_TO_DOW: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/** Parse "HH:mm" or "HH:mm:ss" → minutes from midnight. null if invalid. */
export function parseHmToMinutes(raw: string | null | undefined): number | null {
  const s = String(raw || '').trim();
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

function dowFromKey(key: string): number | null {
  const k = key.trim().toLowerCase();
  if (!k) return null;
  if (k in DAY_NAME_TO_DOW) return DAY_NAME_TO_DOW[k]!;
  // Reject bare '' / non-numeric — Number('') === 0 would falsely map to Sunday
  if (!/^\d+$/.test(k)) return null;
  const n = Number(k);
  if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
  return null;
}

/**
 * Parts helpers for a timezone. Uses Intl — invalid TZ throws → caller treats UNKNOWN.
 */
function zonedParts(
  ms: number,
  timeZone: string
): { dow: number; minutes: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = fmt.formatToParts(new Date(ms));
    const wd = parts.find((p) => p.type === 'weekday')?.value?.toLowerCase() ?? '';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    const map: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };
    const dow = map[wd.slice(0, 3)];
    if (dow == null || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { dow, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

function pointInWindow(dow: number, minutes: number, w: CapitalDayWindow): boolean {
  const start = w.open_dow * 1440 + w.open_min;
  let end = w.close_dow * 1440 + Math.min(w.close_min, 1440);
  // Same-day exclusive midnight end encoded as close_min=1440
  if (w.close_dow === w.open_dow && w.close_min >= 1440) {
    end = w.open_dow * 1440 + 1440;
  }
  const point = dow * 1440 + minutes;
  // Window that wraps week (e.g. Fri 22:00 → Sun 22:00)
  if (end <= start) {
    end += 7 * 1440;
    const p2 = point < start ? point + 7 * 1440 : point;
    return p2 >= start && p2 < end;
  }
  return point >= start && point < end;
}

/** true = expected open, false = expected closed, null = cannot evaluate */
export function isCapitalMarketOpenAt(
  ms: number,
  hours: CapitalOpeningHours | null | undefined
): boolean | null {
  if (!hours || !hours.windows.length) return null;
  if (hours.continuously_open) return true;
  const parts = zonedParts(ms, hours.timezone);
  if (!parts) return null;
  for (const w of hours.windows) {
    if (pointInWindow(parts.dow, parts.minutes, w)) return true;
  }
  return false;
}

function coverageMinutesPerDow(windows: CapitalDayWindow[]): number[] {
  const cov = Array.from({ length: 7 }, () => new Set<number>());
  for (const w of windows) {
    let t = w.open_dow * 1440 + w.open_min;
    let end = w.close_dow * 1440 + w.close_min;
    if (end <= t) end += 7 * 1440;
    for (let m = t; m < end; m++) {
      const mod = ((m % (7 * 1440)) + 7 * 1440) % (7 * 1440);
      const dow = Math.floor(mod / 1440);
      cov[dow]!.add(mod % 1440);
    }
  }
  return cov.map((s) => s.size);
}

/**
 * Parse Capital instrument.openingHours.
 * Capital shape (capital-api-client): { monday: [{openTime,closeTime}], ... }
 * Also accepts legacy { marketTimes: [...] } when days are explicit.
 * Returns null when hours cannot be proven.
 */
export function parseCapitalOpeningHours(
  raw: unknown,
  opts?: { timezone?: string | null }
): CapitalOpeningHours | null {
  if (raw == null || typeof raw !== 'object') return null;

  // Capital timezone required — without it absolute open/closed cannot be proven
  const tzFromCapital = String(opts?.timezone || '').trim();
  if (!tzFromCapital) return null;
  const timezone = tzFromCapital;
  const timezone_from_capital = true;
  const windows: CapitalDayWindow[] = [];

  const obj = raw as Record<string, unknown>;

  // Legacy IG-style marketTimes with explicit days
  const marketTimes = obj.marketTimes;
  if (Array.isArray(marketTimes)) {
    for (const row of marketTimes) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const openDay = dowFromKey(String(r.openDay || r.open_day || ''));
      const closeDay = dowFromKey(String(r.closeDay ?? r.close_day ?? openDay ?? ''));
      const open_min = parseHmToMinutes(String(r.openTime ?? r.open_time ?? ''));
      const close_min = parseHmToMinutes(String(r.closeTime ?? r.close_time ?? ''));
      if (openDay == null || closeDay == null || open_min == null || close_min == null) {
        // Incomplete row without days → cannot prove
        continue;
      }
      windows.push({ open_dow: openDay, open_min, close_dow: closeDay, close_min });
    }
  }

  // Capital per-day map: { monday: [{openTime,closeTime}], ... }
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'marketTimes' || key === 'timezone' || key === 'timeZone') continue;
    const dow = dowFromKey(key);
    if (dow == null) continue;
    const slots = Array.isArray(val) ? val : [val];
    for (const slot of slots) {
      if (!slot || typeof slot !== 'object') continue;
      const s = slot as Record<string, unknown>;
      const open_min = parseHmToMinutes(String(s.openTime ?? s.open_time ?? s.open ?? ''));
      const closeRaw = parseHmToMinutes(String(s.closeTime ?? s.close_time ?? s.close ?? ''));
      if (open_min == null || closeRaw == null) continue;
      // 23:59 / 23:59:59 → end of local day (exclusive next midnight)
      const endOfDay = closeRaw >= 23 * 60 + 59;
      if (endOfDay && open_min === 0) {
        windows.push({
          open_dow: dow,
          open_min: 0,
          close_dow: (dow + 1) % 7,
          close_min: 0,
        });
        continue;
      }
      if (closeRaw <= open_min) {
        // Overnight session into next weekday
        windows.push({
          open_dow: dow,
          open_min,
          close_dow: (dow + 1) % 7,
          close_min: closeRaw,
        });
        continue;
      }
      windows.push({
        open_dow: dow,
        open_min,
        close_dow: dow,
        close_min: endOfDay ? 24 * 60 : closeRaw,
      });
    }
  }

  if (!windows.length) return null;

  const cov = coverageMinutesPerDow(windows);
  const continuously_open = cov.every((n) => n >= 1440);

  return {
    timezone,
    timezone_from_capital,
    windows,
    continuously_open,
    detail: continuously_open
      ? `Capital hours 24/7 · TZ ${timezone}`
      : `Capital hours ${windows.length} windows · TZ ${timezone}`,
  };
}

/**
 * Classify bar gap using Capital opening hours only.
 * Excess gap + no hours → unknown (NOT_READY).
 * Excess gap while Capital says open → missing data.
 * Excess gap while Capital says closed throughout → session.
 */
export function classifyBarGapWithOpeningHours(
  prevMs: number,
  nextMs: number,
  stepMs: number,
  hours: CapitalOpeningHours | null | undefined
): 'none' | 'session' | 'missing' | 'unknown' {
  const delta = nextMs - prevMs;
  if (!(delta > 0) || !(stepMs > 0)) return 'unknown';
  if (delta <= stepMs * 1.5) return 'none';

  if (!hours || !hours.windows.length) return 'unknown';

  // Continuously open markets: any excess gap is missing data
  if (hours.continuously_open) return 'missing';

  // Sample expected bar opens on the TF grid — open slot without a bar = missing data
  for (let t = prevMs + stepMs; t < nextMs; t += stepMs) {
    const open = isCapitalMarketOpenAt(t, hours);
    if (open == null) return 'unknown';
    if (open) return 'missing';
  }
  return 'session';
}

/** @deprecated Use classifyBarGapWithOpeningHours — kept name for call-site clarity */
export function classifyBarGapWithSession(
  prevMs: number,
  nextMs: number,
  stepMs: number,
  hours: CapitalOpeningHours | null | undefined
): 'none' | 'session' | 'missing' | 'unknown' {
  return classifyBarGapWithOpeningHours(prevMs, nextMs, stepMs, hours);
}
