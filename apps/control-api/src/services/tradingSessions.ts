/**
 * Capital.com instrument opening hours for gap classification.
 * Real Capital `/markets/{epic}` shape (Postman official sample):
 *   openingHours: {
 *     mon: ["00:00 - 22:00", "23:05 - 00:00"],
 *     tue: [...], ..., sat: [], sun: ["23:05 - 00:00"],
 *     zone: "UTC"
 *   }
 * NEVER guess from EPIC / asset class / gap length.
 * Without proven Capital hours + zone → UNKNOWN = NOT_READY.
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
  /** From Capital openingHours.zone (or instrument timezone when Capital provides it) */
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

/**
 * Capital range strings: "00:00 - 22:00" or "23:05 - 00:00".
 * Also accepts en-dash / without spaces.
 */
export function parseCapitalRangeString(
  raw: string
): { open_min: number; close_min: number; overnight: boolean } | null {
  const s = String(raw || '').trim();
  const m = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (!m) return null;
  const open_min = parseHmToMinutes(m[1]);
  const close_min = parseHmToMinutes(m[2]);
  if (open_min == null || close_min == null) return null;
  // "23:05 - 00:00" → overnight to next midnight
  const overnight = close_min <= open_min;
  return { open_min, close_min, overnight };
}

function dowFromKey(key: string): number | null {
  const k = key.trim().toLowerCase();
  if (!k) return null;
  if (k in DAY_NAME_TO_DOW) return DAY_NAME_TO_DOW[k]!;
  if (!/^\d+$/.test(k)) return null;
  const n = Number(k);
  if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
  return null;
}

function pushDaySlot(
  windows: CapitalDayWindow[],
  dow: number,
  open_min: number,
  closeRaw: number,
  overnight: boolean
): void {
  if (overnight || closeRaw <= open_min) {
    windows.push({
      open_dow: dow,
      open_min,
      close_dow: (dow + 1) % 7,
      close_min: closeRaw,
    });
    return;
  }
  // 23:59 / 23:59:59 → end of local day
  const endOfDay = closeRaw >= 23 * 60 + 59;
  if (endOfDay && open_min === 0) {
    windows.push({
      open_dow: dow,
      open_min: 0,
      close_dow: (dow + 1) % 7,
      close_min: 0,
    });
    return;
  }
  windows.push({
    open_dow: dow,
    open_min,
    close_dow: dow,
    close_min: endOfDay ? 24 * 60 : closeRaw,
  });
}

function zonedParts(
  ms: number,
  timeZone: string
): { dow: number; minutes: number } | null {
  try {
    // Capital zone is often "UTC" — Intl accepts it
    const tz = timeZone === 'UTC' || timeZone === 'GMT' ? 'UTC' : timeZone;
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
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
  if (w.close_dow === w.open_dow && w.close_min >= 1440) {
    end = w.open_dow * 1440 + 1440;
  }
  const point = dow * 1440 + minutes;
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
 * Parse Capital instrument.openingHours from real `/markets/{epic}` response.
 * Primary shape: { mon: ["00:00 - 22:00"], ..., zone: "UTC" }
 * Also accepts object slots {openTime,closeTime} and legacy marketTimes with days.
 */
export function parseCapitalOpeningHours(
  raw: unknown,
  opts?: { timezone?: string | null }
): CapitalOpeningHours | null {
  if (raw == null || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;
  // Capital puts timezone inside openingHours.zone (official Postman sample)
  const zoneFromHours = String(
    obj.zone ?? obj.Zone ?? obj.timezone ?? obj.timeZone ?? ''
  ).trim();
  const zoneFromOpts = String(opts?.timezone || '').trim();
  const timezone = zoneFromHours || zoneFromOpts;
  if (!timezone) return null; // cannot prove absolute open/closed without Capital zone
  const timezone_from_capital = true;
  const windows: CapitalDayWindow[] = [];

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
      if (openDay == null || closeDay == null || open_min == null || close_min == null) continue;
      windows.push({ open_dow: openDay, open_min, close_dow: closeDay, close_min });
    }
  }

  // Capital per-day map
  for (const [key, val] of Object.entries(obj)) {
    if (
      key === 'marketTimes' ||
      key === 'timezone' ||
      key === 'timeZone' ||
      key === 'zone' ||
      key === 'Zone'
    ) {
      continue;
    }
    const dow = dowFromKey(key);
    if (dow == null) continue;
    const slots = Array.isArray(val) ? val : [val];
    for (const slot of slots) {
      if (slot == null) continue;
      // Capital string ranges: "00:00 - 22:00"
      if (typeof slot === 'string') {
        const range = parseCapitalRangeString(slot);
        if (!range) continue;
        pushDaySlot(windows, dow, range.open_min, range.close_min, range.overnight);
        continue;
      }
      if (typeof slot !== 'object') continue;
      const s = slot as Record<string, unknown>;
      const open_min = parseHmToMinutes(String(s.openTime ?? s.open_time ?? s.open ?? ''));
      const closeRaw = parseHmToMinutes(String(s.closeTime ?? s.close_time ?? s.close ?? ''));
      if (open_min == null || closeRaw == null) continue;
      pushDaySlot(windows, dow, open_min, closeRaw, closeRaw <= open_min);
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
      ? `Capital hours 24/7 · zone ${timezone}`
      : `Capital hours ${windows.length} windows · zone ${timezone}`,
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

  if (hours.continuously_open) return 'missing';

  for (let t = prevMs + stepMs; t < nextMs; t += stepMs) {
    const open = isCapitalMarketOpenAt(t, hours);
    if (open == null) return 'unknown';
    if (open) return 'missing';
  }
  return 'session';
}

/** @deprecated Prefer classifyBarGapWithOpeningHours */
export function classifyBarGapWithSession(
  prevMs: number,
  nextMs: number,
  stepMs: number,
  hours: CapitalOpeningHours | null | undefined
): 'none' | 'session' | 'missing' | 'unknown' {
  return classifyBarGapWithOpeningHours(prevMs, nextMs, stepMs, hours);
}
