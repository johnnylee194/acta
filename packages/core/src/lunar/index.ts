import { Solar, Lunar, LunarMonth } from 'lunar-typescript';

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface LunarDayInfo {
  solarDateStr: string; // YYYY-MM-DD in Asia/Shanghai
  lunarYear: number;
  lunarYearInGanZhi: string;
  lunarMonth: number; // positive 1..12
  isLeapMonth: boolean;
  lunarDay: number; // 1..30
  lunarMonthInChinese: string; // e.g. "十月" or "闰六月"
  lunarDayInChinese: string; // e.g. "初一"
  solarTerm: string | null; // e.g. "立冬"
  festivals: string[]; // e.g. ["春节"]
  shortLabel: string; // Display text for calendar cell
  isHighlight: boolean; // True if festival or solar term
}

/**
 * Convert a UTC timestamp (or Date) into China Standard Time (UTC+8) Year/Month/Day/Time components.
 */
export function toCstComponents(input: Date | number) {
  const ms = typeof input === 'number' ? input : input.getTime();
  const cstDate = new Date(ms + CST_OFFSET_MS);
  return {
    year: cstDate.getUTCFullYear(),
    month: cstDate.getUTCMonth() + 1,
    day: cstDate.getUTCDate(),
    hour: cstDate.getUTCHours(),
    minute: cstDate.getUTCMinutes(),
    second: cstDate.getUTCSeconds(),
    millisecond: cstDate.getUTCMilliseconds(),
  };
}

/**
 * Convert China Standard Time (UTC+8) components back to UTC timestamp in ms.
 */
export function fromCstComponents(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - CST_OFFSET_MS;
}

/**
 * Pure offline calculation of Lunar date, 24 solar terms, and traditional festivals.
 */
export function getLunarDayInfo(input: Date | number): LunarDayInfo {
  const { year, month, day } = toCstComponents(input);
  const solar = Solar.fromYmd(year, month, day);
  const lunar = solar.getLunar();

  const rawMonth = lunar.getMonth();
  const isLeapMonth = rawMonth < 0;
  const lunarMonth = Math.abs(rawMonth);
  const lunarDay = lunar.getDay();

  const monthChinese = `${isLeapMonth ? '闰' : ''}${lunar.getMonthInChinese()}月`;
  const dayChinese = lunar.getDayInChinese();
  const jieQi = lunar.getJieQi() || null;

  const lunarFestivals = lunar.getFestivals();
  const solarFestivals = solar.getFestivals();
  const festivals = [...lunarFestivals, ...solarFestivals];

  let shortLabel = dayChinese;
  let isHighlight = false;

  if (festivals.length > 0) {
    shortLabel = festivals[0];
    isHighlight = true;
  } else if (jieQi) {
    shortLabel = jieQi;
    isHighlight = true;
  } else if (lunarDay === 1) {
    shortLabel = monthChinese;
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');

  return {
    solarDateStr: `${year}-${mm}-${dd}`,
    lunarYear: lunar.getYear(),
    lunarYearInGanZhi: lunar.getYearInGanZhi(),
    lunarMonth,
    isLeapMonth,
    lunarDay,
    lunarMonthInChinese: monthChinese,
    lunarDayInChinese: dayChinese,
    solarTerm: jieQi,
    festivals,
    shortLabel,
    isHighlight,
  };
}

export interface ParsedLunarRRule {
  freq: 'YEARLY' | 'MONTHLY';
  month?: number; // 1..12 (required for YEARLY)
  day: number; // 1..30
  isLeapMonth?: boolean;
  until?: number; // UTC ms timestamp
}

/**
 * Check if an rrule string is a Lunar recurrence rule (prefixed with "LUNAR:").
 */
export function isLunarRRule(rrule: string | null | undefined): boolean {
  return typeof rrule === 'string' && rrule.trim().toUpperCase().startsWith('LUNAR:');
}

/**
 * Parse a Lunar rrule string such as:
 * "LUNAR:FREQ=YEARLY;MONTH=8;DAY=15"
 * "LUNAR:FREQ=MONTHLY;DAY=1;UNTIL=1798761600000"
 */
export function parseLunarRRule(rrule: string): ParsedLunarRRule | null {
  if (!isLunarRRule(rrule)) return null;
  const body = rrule.trim().slice('LUNAR:'.length);
  const parts = body.split(';').map((s) => s.trim()).filter(Boolean);
  const kv: Record<string, string> = {};
  for (const part of parts) {
    const [k, v] = part.split('=');
    if (k && v) {
      kv[k.toUpperCase()] = v.toUpperCase();
    }
  }

  const freq = kv.FREQ === 'MONTHLY' ? 'MONTHLY' : kv.FREQ === 'YEARLY' ? 'YEARLY' : null;
  if (!freq) return null;

  const day = Number(kv.DAY);
  if (!Number.isInteger(day) || day < 1 || day > 30) return null;

  const month = kv.MONTH ? Number(kv.MONTH) : undefined;
  if (freq === 'YEARLY' && (!month || !Number.isInteger(month) || month < 1 || month > 12)) {
    return null;
  }

  const isLeapMonth = kv.LEAP === '1' || kv.LEAP === 'TRUE';
  let until: number | undefined;
  if (kv.UNTIL) {
    const parsedNum = Number(kv.UNTIL);
    if (Number.isFinite(parsedNum) && parsedNum > 0 && kv.UNTIL.length >= 10) {
      // If it looks like a 13-digit ms timestamp vs YYYYMMDDTHHMMSSZ
      if (/^\d{8}T\d{6}Z?$/.test(kv.UNTIL)) {
        const y = Number(kv.UNTIL.slice(0, 4));
        const m = Number(kv.UNTIL.slice(4, 6));
        const d = Number(kv.UNTIL.slice(6, 8));
        const hh = Number(kv.UNTIL.slice(9, 11));
        const mm = Number(kv.UNTIL.slice(11, 13));
        const ss = Number(kv.UNTIL.slice(13, 15));
        until = Date.UTC(y, m - 1, d, hh, mm, ss);
      } else {
        until = parsedNum;
      }
    }
  }

  return {
    freq,
    month,
    day,
    isLeapMonth,
    until,
  };
}

/**
 * Format a ParsedLunarRRule back into a standardized "LUNAR:..." string.
 */
export function formatLunarRRule(rule: ParsedLunarRRule): string {
  const segments: string[] = [`FREQ=${rule.freq}`];
  if (rule.freq === 'YEARLY' && rule.month) {
    segments.push(`MONTH=${rule.month}`);
  }
  segments.push(`DAY=${rule.day}`);
  if (rule.isLeapMonth) {
    segments.push('LEAP=1');
  }
  if (typeof rule.until === 'number' && Number.isFinite(rule.until)) {
    segments.push(`UNTIL=${Math.floor(rule.until)}`);
  }
  return `LUNAR:${segments.join(';')}`;
}

/**
 * Helper to create a LUNAR: rrule directly from an event's start_time timestamp.
 */
export function createLunarRRuleFromTimestamp(
  startTimeMs: number,
  freq: 'YEARLY' | 'MONTHLY',
  untilMs?: number
): string {
  const info = getLunarDayInfo(startTimeMs);
  return formatLunarRRule({
    freq,
    month: freq === 'YEARLY' ? info.lunarMonth : undefined,
    day: info.lunarDay,
    isLeapMonth: info.isLeapMonth,
    until: untilMs,
  });
}

/**
 * Expand a LUNAR: recurrence rule into UTC start timestamps within [windowStartMs, windowEndMs].
 * Handles 30th day fallback in 29-day lunar months and leap-month rules accurately.
 */
export function expandLunarOccurrences(
  masterStartTimeMs: number,
  isAllDay: boolean,
  rruleStr: string,
  windowStartMs: number,
  windowEndMs: number
): number[] {
  const parsed = parseLunarRRule(rruleStr);
  if (!parsed) return [];

  const effectiveEndMs =
    typeof parsed.until === 'number' ? Math.min(windowEndMs, parsed.until) : windowEndMs;
  if (effectiveEndMs < masterStartTimeMs || effectiveEndMs < windowStartMs) {
    return [];
  }

  const masterCst = toCstComponents(masterStartTimeMs);
  const startSearchMs = Math.max(masterStartTimeMs, windowStartMs) - 24 * 60 * 60 * 1000;
  const startCst = toCstComponents(startSearchMs);
  const endCst = toCstComponents(effectiveEndMs + 24 * 60 * 60 * 1000);

  // Iterate day by day in CST from startCst to endCst
  const cursor = new Date(Date.UTC(startCst.year, startCst.month - 1, startCst.day));
  const endLimit = new Date(Date.UTC(endCst.year, endCst.month - 1, endCst.day));

  const results: number[] = [];

  while (cursor.getTime() <= endLimit.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();

    const solar = Solar.fromYmd(y, m, d);
    const lunar = solar.getLunar();
    const lYear = lunar.getYear();
    const rawLMonth = lunar.getMonth(); // negative if leap month
    const absLMonth = Math.abs(rawLMonth);
    const lDay = lunar.getDay();

    let monthMatches = false;
    if (parsed.freq === 'MONTHLY') {
      monthMatches = true;
    } else if (parsed.freq === 'YEARLY' && parsed.month === absLMonth) {
      // Check if this lunar year has a leap month for parsed.month
      const leapMonthInYear = LunarMonth.fromYm(lYear, -absLMonth);
      if (parsed.isLeapMonth && leapMonthInYear) {
        // Year has this leap month and rule specifically asked for leap month
        monthMatches = rawLMonth < 0;
      } else {
        // Trigger on the normal (non-leap) month
        monthMatches = rawLMonth > 0;
      }
    }

    if (monthMatches) {
      const lunarMonthObj = LunarMonth.fromYm(lYear, rawLMonth);
      const maxDaysInLunarMonth = lunarMonthObj ? lunarMonthObj.getDayCount() : 30;
      const targetDayInThisMonth = Math.min(parsed.day, maxDaysInLunarMonth);

      if (lDay === targetDayInThisMonth) {
        const occurrenceMs = isAllDay
          ? Date.UTC(y, m - 1, d, 0, 0, 0, 0)
          : fromCstComponents(
              y,
              m,
              d,
              masterCst.hour,
              masterCst.minute,
              masterCst.second,
              masterCst.millisecond
            );

        if (
          occurrenceMs >= masterStartTimeMs &&
          occurrenceMs >= windowStartMs &&
          occurrenceMs <= effectiveEndMs
        ) {
          results.push(occurrenceMs);
        }
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return results;
}
