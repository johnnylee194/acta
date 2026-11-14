import { CalendarRecord, EventRecord, parseJsonNumberArray } from '../schema/index.js';

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface ParsedIcsResult {
  calendarName: string | null;
  events: EventRecord[];
}

function unescapeIcsText(val: string): string {
  return val
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function escapeIcsText(val: string): string {
  return val
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Resolve the UTC timestamp (ms) for a local wall-clock time in a given IANA timezone.
 */
function parseWallTimeInTimezone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tzid?: string
): number {
  const approxUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!tzid || tzid === 'Asia/Shanghai' || tzid === 'Asia/Chongqing' || tzid === 'Asia/Beijing') {
    return approxUtc - CST_OFFSET_MS;
  }
  if (tzid.toUpperCase() === 'UTC' || tzid.toUpperCase() === 'GMT') {
    return approxUtc;
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(approxUtc));
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== 'literal') {
        map[p.type] = Number(p.value);
      }
    }
    const tzHr = map.hour === 24 ? 0 : map.hour;
    const asUtcInTz = Date.UTC(map.year, map.month - 1, map.day, tzHr, map.minute, map.second);
    const offset = asUtcInTz - approxUtc;
    return approxUtc - offset;
  } catch {
    return approxUtc - CST_OFFSET_MS;
  }
}

/**
 * Parse an iCalendar date/time value (e.g. "20261109", "20261109T190000Z", "20261109T200000")
 */
export function parseIcsDateTime(
  rawValue: string,
  params: Record<string, string>
): { timestampMs: number; isAllDay: boolean } | null {
  const val = rawValue.trim();
  const isDateOnly = params.VALUE?.toUpperCase() === 'DATE' || /^\d{8}$/.test(val);

  if (isDateOnly && /^\d{8}$/.test(val)) {
    const y = Number(val.slice(0, 4));
    const m = Number(val.slice(4, 6));
    const d = Number(val.slice(6, 8));
    return {
      timestampMs: Date.UTC(y, m - 1, d, 0, 0, 0, 0),
      isAllDay: true,
    };
  }

  const dtMatch = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i);
  if (!dtMatch) return null;

  const y = Number(dtMatch[1]);
  const m = Number(dtMatch[2]);
  const d = Number(dtMatch[3]);
  const hh = Number(dtMatch[4]);
  const min = Number(dtMatch[5]);
  const ss = Number(dtMatch[6]);
  const isUtc = Boolean(dtMatch[7]);

  if (isUtc) {
    return {
      timestampMs: Date.UTC(y, m - 1, d, hh, min, ss, 0),
      isAllDay: false,
    };
  }

  const tzid = params.TZID;
  return {
    timestampMs: parseWallTimeInTimezone(y, m, d, hh, min, ss, tzid),
    isAllDay: false,
  };
}

/**
 * Parse ISO 8601 / RFC 5545 duration string like "PT2H", "PT90M", "P1D", "-PT15M" into milliseconds.
 */
export function parseIcsDurationMs(raw: string): number | null {
  const match = raw
    .trim()
    .match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const weeks = Number(match[2] || 0);
  const days = Number(match[3] || 0);
  const hours = Number(match[4] || 0);
  const minutes = Number(match[5] || 0);
  const seconds = Number(match[6] || 0);

  const totalMs =
    (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 * 1000 + seconds * 1000;
  return sign * totalMs;
}

/**
 * Unfold RFC 5545 folded lines (CRLF/LF followed by a single space or tab).
 */
export function unfoldIcsLines(icsContent: string): string[] {
  const unfolded = icsContent.replace(/\r?\n[ \t]/g, '');
  return unfolded
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function parsePropertyLine(line: string): {
  name: string;
  params: Record<string, string>;
  value: string;
} | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;

  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const segments = left.split(';');
  const name = segments[0].toUpperCase();
  const params: Record<string, string> = {};

  for (let i = 1; i < segments.length; i++) {
    const eqIdx = segments[i].indexOf('=');
    if (eqIdx !== -1) {
      const pk = segments[i].slice(0, eqIdx).toUpperCase();
      const pv = segments[i].slice(eqIdx + 1).replace(/^"|"$/g, '');
      params[pk] = pv;
    }
  }

  return { name, params, value };
}

/**
 * Parse a Google Calendar or sports subscription .ics feed into EventRecord items.
 */
export function parseIcsContent(params: {
  icsContent: string;
  calendarId: string;
  defaultReminders?: number[];
  idGenerator?: (externalUid: string) => string;
  nowMs?: number;
}): ParsedIcsResult {
  const { icsContent, calendarId } = params;
  const nowMs = params.nowMs ?? Date.now();
  const defaultReminders = params.defaultReminders ?? [15];
  const makeId =
    params.idGenerator ??
    ((uid: string) => {
      // Deterministic safe ID from calendarId + uid
      let hash = 2166136261;
      const input = `${calendarId}:${uid}`;
      for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const hex = (hash >>> 0).toString(16).padStart(8, '0');
      const safeTail = uid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
      return `ics_${hex}_${safeTail || 'ev'}`;
    });

  const lines = unfoldIcsLines(icsContent);
  let calendarName: string | null = null;

  interface RawVEvent {
    uid: string;
    summary: string;
    description: string;
    location: string;
    startTime: number;
    endTime: number;
    isAllDay: boolean;
    rrule: string | null;
    exdates: number[];
    recurrenceIdMs: number | null;
    reminders: number[];
    status: string;
  }

  const rawEvents: RawVEvent[] = [];
  let inVEvent = false;
  let inVAlarm = false;
  let current: Partial<RawVEvent> & { durationMs?: number } = {};
  let alarmTriggerMs: number | null = null;

  for (const line of lines) {
    const upper = line.toUpperCase();

    if (!inVEvent && upper.startsWith('X-WR-CALNAME:')) {
      calendarName = unescapeIcsText(line.slice('X-WR-CALNAME:'.length).trim());
      continue;
    }

    if (upper === 'BEGIN:VEVENT') {
      inVEvent = true;
      inVAlarm = false;
      current = {
        uid: '',
        summary: '未命名日程',
        description: '',
        location: '',
        rrule: null,
        exdates: [],
        recurrenceIdMs: null,
        reminders: [],
        status: 'CONFIRMED',
      };
      continue;
    }

    if (upper === 'END:VEVENT') {
      if (inVEvent && current.startTime !== undefined) {
        const isAllDay = Boolean(current.isAllDay);
        let endTime = current.endTime;
        if (endTime === undefined) {
          if (current.durationMs !== undefined && current.durationMs > 0) {
            endTime = current.startTime + current.durationMs;
          } else {
            // Sports feeds sometimes omit DTEND; default to 2 hours for timed events, 1 day for all-day
            endTime =
              current.startTime + (isAllDay ? 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000);
          }
        }
        const uid = current.uid || `${current.summary}_${current.startTime}`;
        rawEvents.push({
          uid,
          summary: current.summary || '未命名日程',
          description: current.description || '',
          location: current.location || '',
          startTime: current.startTime,
          endTime,
          isAllDay,
          rrule: current.rrule ?? null,
          exdates: current.exdates ?? [],
          recurrenceIdMs: current.recurrenceIdMs ?? null,
          reminders: current.reminders ?? [],
          status: current.status || 'CONFIRMED',
        });
      }
      inVEvent = false;
      inVAlarm = false;
      continue;
    }

    if (!inVEvent) continue;

    if (upper === 'BEGIN:VALARM') {
      inVAlarm = true;
      alarmTriggerMs = null;
      continue;
    }

    if (upper === 'END:VALARM') {
      if (inVAlarm && alarmTriggerMs !== null && alarmTriggerMs <= 0) {
        const minutesBefore = Math.round(Math.abs(alarmTriggerMs) / 60000);
        if (!current.reminders!.includes(minutesBefore)) {
          current.reminders!.push(minutesBefore);
        }
      }
      inVAlarm = false;
      continue;
    }

    const prop = parsePropertyLine(line);
    if (!prop) continue;

    if (inVAlarm) {
      if (prop.name === 'TRIGGER') {
        alarmTriggerMs = parseIcsDurationMs(prop.value);
      }
      continue;
    }

    switch (prop.name) {
      case 'UID':
        current.uid = prop.value.trim();
        break;
      case 'SUMMARY':
        current.summary = unescapeIcsText(prop.value.trim()) || '未命名日程';
        break;
      case 'DESCRIPTION':
        current.description = unescapeIcsText(prop.value.trim());
        break;
      case 'LOCATION':
        current.location = unescapeIcsText(prop.value.trim());
        break;
      case 'STATUS':
        current.status = prop.value.trim().toUpperCase();
        break;
      case 'DTSTART': {
        const parsed = parseIcsDateTime(prop.value, prop.params);
        if (parsed) {
          current.startTime = parsed.timestampMs;
          current.isAllDay = parsed.isAllDay;
        }
        break;
      }
      case 'DTEND': {
        const parsed = parseIcsDateTime(prop.value, prop.params);
        if (parsed) {
          current.endTime = parsed.timestampMs;
        }
        break;
      }
      case 'DURATION': {
        const dur = parseIcsDurationMs(prop.value);
        if (dur !== null && dur > 0) {
          current.durationMs = dur;
        }
        break;
      }
      case 'RRULE':
        current.rrule = prop.value.trim();
        break;
      case 'EXDATE': {
        const rawDates = prop.value.split(',');
        for (const token of rawDates) {
          const parsed = parseIcsDateTime(token, prop.params);
          if (parsed && !current.exdates!.includes(parsed.timestampMs)) {
            current.exdates!.push(parsed.timestampMs);
          }
        }
        break;
      }
      case 'RECURRENCE-ID': {
        const parsed = parseIcsDateTime(prop.value, prop.params);
        if (parsed) {
          current.recurrenceIdMs = parsed.timestampMs;
        }
        break;
      }
    }
  }

  // First pass: map master UIDs to internal Event IDs so exception instances can point to recurring_event_id
  const masterIdByUid = new Map<string, string>();
  for (const raw of rawEvents) {
    if (raw.recurrenceIdMs === null && raw.status !== 'CANCELLED') {
      const id = makeId(raw.uid);
      masterIdByUid.set(raw.uid, id);
    }
  }

  const events: EventRecord[] = [];
  for (const raw of rawEvents) {
    if (raw.status === 'CANCELLED' && raw.recurrenceIdMs === null) {
      continue;
    }

    const isException = raw.recurrenceIdMs !== null;
    const externalUid = isException ? `${raw.uid}__${raw.recurrenceIdMs}` : raw.uid;
    const id = makeId(externalUid);
    const masterId = isException ? masterIdByUid.get(raw.uid) ?? null : null;

    const remindersList = raw.reminders.length > 0 ? raw.reminders : defaultReminders;

    events.push({
      id,
      calendar_id: calendarId,
      external_uid: externalUid,
      title: raw.summary,
      description: raw.description,
      location: raw.location,
      color: null,
      start_time: raw.startTime,
      end_time: raw.endTime,
      is_all_day: raw.isAllDay ? 1 : 0,
      timezone: 'Asia/Shanghai',
      rrule: isException ? null : raw.rrule,
      exdates: JSON.stringify(raw.exdates.sort((a, b) => a - b)),
      recurring_event_id: masterId,
      original_start_time: raw.recurrenceIdMs,
      reminders: JSON.stringify(remindersList),
      created_at: nowMs,
      updated_at: nowMs,
      sync_version: 0,
      is_deleted: raw.status === 'CANCELLED' ? 1 : 0,
      sync_status: 'DIRTY',
    });
  }

  return {
    calendarName,
    events,
  };
}

function formatIcsDateTimeUtc(ms: number, isAllDay: boolean): string {
  const d = new Date(ms);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (isAllDay) {
    return `${yyyy}${mm}${dd}`;
  }
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${min}${ss}Z`;
}

/**
 * Export a calendar and its events into a standard RFC 5545 .ics string.
 */
export function exportEventsToIcs(calendarName: string, events: EventRecord[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Acta Personal Calendar//CN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
  ];

  const dtstamp = formatIcsDateTimeUtc(Date.now(), false);

  for (const ev of events) {
    if (ev.is_deleted !== 0) continue;
    const isAllDay = ev.is_all_day === 1;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.external_uid || `${ev.id}@acta.local`}`);
    lines.push(`DTSTAMP:${dtstamp}`);

    if (isAllDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatIcsDateTimeUtc(ev.start_time, true)}`);
      lines.push(`DTEND;VALUE=DATE:${formatIcsDateTimeUtc(ev.end_time, true)}`);
    } else {
      lines.push(`DTSTART:${formatIcsDateTimeUtc(ev.start_time, false)}`);
      lines.push(`DTEND:${formatIcsDateTimeUtc(ev.end_time, false)}`);
    }

    lines.push(`SUMMARY:${escapeIcsText(ev.title)}`);
    if (ev.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
    }
    if (ev.location) {
      lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
    }

    if (ev.rrule && !ev.rrule.toUpperCase().startsWith('LUNAR:')) {
      lines.push(`RRULE:${ev.rrule.replace(/^RRULE:/i, '')}`);
    }

    const exdates = parseJsonNumberArray(ev.exdates, []);
    if (exdates.length > 0) {
      const formattedExdates = exdates
        .map((ms) => formatIcsDateTimeUtc(ms, isAllDay))
        .join(',');
      lines.push(
        isAllDay
          ? `EXDATE;VALUE=DATE:${formattedExdates}`
          : `EXDATE:${formattedExdates}`
      );
    }

    if (ev.recurring_event_id && typeof ev.original_start_time === 'number') {
      lines.push(
        isAllDay
          ? `RECURRENCE-ID;VALUE=DATE:${formatIcsDateTimeUtc(ev.original_start_time, true)}`
          : `RECURRENCE-ID:${formatIcsDateTimeUtc(ev.original_start_time, false)}`
      );
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
