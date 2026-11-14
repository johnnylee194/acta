import * as rruleNs from 'rrule';
import {
  CalendarRecord,
  EventRecord,
  ExpandedEventInstance,
  RecurrenceEditScope,
  parseJsonNumberArray,
} from '../schema/index.js';
import {
  createLunarRRuleFromTimestamp,
  expandLunarOccurrences,
  formatLunarRRule,
  isLunarRRule,
  parseLunarRRule,
} from '../lunar/index.js';

const RRule =
  rruleNs.RRule ?? (rruleNs as unknown as { default: typeof rruleNs }).default.RRule;
const rrulestr =
  rruleNs.rrulestr ??
  (rruleNs as unknown as { default: typeof rruleNs }).default.rrulestr;

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Format a UTC millisecond timestamp into RFC 5545 UNTIL UTC string: YYYYMMDDTHHMMSSZ
 */
export function formatUtcUntilString(utcMs: number): string {
  const d = new Date(Math.floor(utcMs));
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${min}${ss}Z`;
}

/**
 * Parse an UNTIL token from an RFC 5545 rrule string into UTC milliseconds.
 */
export function parseRRuleUntilMs(rruleStr: string): number | undefined {
  if (isLunarRRule(rruleStr)) {
    return parseLunarRRule(rruleStr)?.until;
  }
  const match = rruleStr.match(/(?:^|;)UNTIL=([^;]+)/i);
  if (!match) return undefined;
  const raw = match[1].trim();
  if (/^\d{10,}$/.test(raw)) {
    return Number(raw);
  }
  if (/^\d{8}T\d{6}Z?$/i.test(raw)) {
    const y = Number(raw.slice(0, 4));
    const m = Number(raw.slice(4, 6));
    const d = Number(raw.slice(6, 8));
    const hh = Number(raw.slice(9, 11));
    const min = Number(raw.slice(11, 13));
    const ss = Number(raw.slice(13, 15));
    const isUtc = raw.toUpperCase().endsWith('Z');
    return isUtc
      ? Date.UTC(y, m - 1, d, hh, min, ss)
      : Date.UTC(y, m - 1, d, hh, min, ss) - CST_OFFSET_MS;
  }
  if (/^\d{8}$/.test(raw)) {
    const y = Number(raw.slice(0, 4));
    const m = Number(raw.slice(4, 6));
    const d = Number(raw.slice(6, 8));
    return Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  }
  return undefined;
}

/**
 * Add or update the UNTIL parameter on either a standard RFC 5545 rrule or a LUNAR: rrule.
 */
export function setRRuleUntil(rruleStr: string, untilUtcMs: number): string {
  if (isLunarRRule(rruleStr)) {
    const parsed = parseLunarRRule(rruleStr);
    if (!parsed) return rruleStr;
    return formatLunarRRule({
      ...parsed,
      until: Math.floor(untilUtcMs),
    });
  }

  const parts = rruleStr
    .replace(/^RRULE:/i, '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.toUpperCase().startsWith('UNTIL=') && !p.toUpperCase().startsWith('COUNT='));

  parts.push(`UNTIL=${formatUtcUntilString(untilUtcMs)}`);
  return parts.join(';');
}

/**
 * Strip UNTIL=... from an RFC 5545 rrule string so we can evaluate UNTIL in exact UTC ms.
 */
function stripUntilFromRRule(rruleStr: string): string {
  return rruleStr
    .replace(/^RRULE:/i, '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.toUpperCase().startsWith('UNTIL='))
    .join(';');
}

/**
 * Expand standard RFC 5545 rrule occurrences within [windowStartMs, windowEndMs].
 * Evaluates wall-clock recurrence in Asia/Shanghai (UTC+8) for timed events, and UTC 00:00 for all-day events.
 */
export function expandStandardRRuleOccurrences(
  masterStartTimeMs: number,
  isAllDay: boolean,
  rruleStr: string,
  windowStartMs: number,
  windowEndMs: number
): number[] {
  const untilMs = parseRRuleUntilMs(rruleStr);
  const effectiveWindowEndMs =
    typeof untilMs === 'number' ? Math.min(windowEndMs, untilMs) : windowEndMs;

  if (effectiveWindowEndMs < masterStartTimeMs || effectiveWindowEndMs < windowStartMs) {
    return [];
  }

  const cleanRuleBody = stripUntilFromRRule(rruleStr);
  if (!cleanRuleBody) return [];

  const offsetMs = isAllDay ? 0 : CST_OFFSET_MS;
  const shiftedDtStart = new Date(masterStartTimeMs + offsetMs);
  const shiftedWindowStart = new Date(Math.max(masterStartTimeMs, windowStartMs) + offsetMs);
  const shiftedWindowEnd = new Date(effectiveWindowEndMs + offsetMs);

  try {
    const parsedOptions = RRule.parseString(cleanRuleBody);
    parsedOptions.dtstart = shiftedDtStart;
    const rule = new RRule(parsedOptions);
    const dates = rule.between(shiftedWindowStart, shiftedWindowEnd, true);
    return dates.map((d) => d.getTime() - offsetMs);
  } catch {
    try {
      const rule = rrulestr(cleanRuleBody, { dtstart: shiftedDtStart });
      const dates = rule.between(shiftedWindowStart, shiftedWindowEnd, true);
      return dates.map((d) => d.getTime() - offsetMs);
    } catch {
      return [];
    }
  }
}

/**
 * Expand all events (standalone, recurring master events, and exception instances)
 * into sorted ExpandedEventInstance items overlapping [windowStartMs, windowEndMs].
 */
export function expandEventsInWindow(
  events: EventRecord[],
  windowStartMs: number,
  windowEndMs: number,
  calendars?: CalendarRecord[]
): ExpandedEventInstance[] {
  const calendarMap = new Map<string, CalendarRecord>();
  if (calendars) {
    for (const cal of calendars) {
      if (cal.is_deleted === 0) {
        calendarMap.set(cal.id, cal);
      }
    }
  }

  const activeEvents = events.filter((e) => {
    if (e.is_deleted !== 0) return false;
    if (calendars && calendarMap.size > 0) {
      const cal = calendarMap.get(e.calendar_id);
      if (!cal || cal.is_visible === 0) return false;
    }
    return true;
  });

  const standaloneEvents: EventRecord[] = [];
  const masterEvents: EventRecord[] = [];
  const exceptionsByMaster = new Map<string, Map<number, EventRecord>>();

  for (const ev of activeEvents) {
    if (ev.recurring_event_id) {
      let map = exceptionsByMaster.get(ev.recurring_event_id);
      if (!map) {
        map = new Map<number, EventRecord>();
        exceptionsByMaster.set(ev.recurring_event_id, map);
      }
      if (typeof ev.original_start_time === 'number') {
        map.set(ev.original_start_time, ev);
      }
    } else if (ev.rrule && ev.rrule.trim().length > 0) {
      masterEvents.push(ev);
    } else {
      standaloneEvents.push(ev);
    }
  }

  const results: ExpandedEventInstance[] = [];
  const emittedExceptionIds = new Set<string>();

  const resolveInstanceProps = (ev: EventRecord) => {
    const cal = calendarMap.get(ev.calendar_id);
    const color = ev.color || cal?.color || '#3B82F6';
    const eventReminders = parseJsonNumberArray(ev.reminders, []);
    const calDefaultReminders = cal ? parseJsonNumberArray(cal.default_reminders, []) : [];
    const reminders = eventReminders.length > 0 ? eventReminders : calDefaultReminders;
    const isReadonly = cal?.is_readonly === 1;
    return { color, reminders, isReadonly };
  };

  // 1. Standalone non-recurring events overlapping [windowStartMs, windowEndMs]
  for (const ev of standaloneEvents) {
    if (ev.end_time >= windowStartMs && ev.start_time <= windowEndMs) {
      const { color, reminders, isReadonly } = resolveInstanceProps(ev);
      results.push({
        instanceId: ev.id,
        eventId: ev.id,
        masterEventId: null,
        calendarId: ev.calendar_id,
        title: ev.title,
        description: ev.description || '',
        location: ev.location || '',
        color,
        startTime: ev.start_time,
        endTime: ev.end_time,
        isAllDay: ev.is_all_day === 1,
        timezone: ev.timezone || 'Asia/Shanghai',
        isRecurring: false,
        isLunarRecurring: false,
        isException: false,
        rrule: null,
        originalStartTime: ev.start_time,
        reminders,
        isReadonly,
      });
    }
  }

  // 2. Master recurring events & their exceptions
  for (const master of masterEvents) {
    const duration = Math.max(0, master.end_time - master.start_time);
    // Search slightly before windowStartMs so multi-hour/multi-day occurrences starting before windowStartMs but ending inside window are included
    const searchStartMs = Math.max(master.start_time, windowStartMs - duration);
    if (master.start_time > windowEndMs) continue;

    const rruleStr = master.rrule!;
    const isLunar = isLunarRRule(rruleStr);
    const exdatesSet = new Set<number>(parseJsonNumberArray(master.exdates, []));
    const exceptionMap = exceptionsByMaster.get(master.id) ?? new Map<number, EventRecord>();

    const occurrenceStarts = isLunar
      ? expandLunarOccurrences(
          master.start_time,
          master.is_all_day === 1,
          rruleStr,
          searchStartMs,
          windowEndMs
        )
      : expandStandardRRuleOccurrences(
          master.start_time,
          master.is_all_day === 1,
          rruleStr,
          searchStartMs,
          windowEndMs
        );

    const { color: masterColor, reminders: masterReminders, isReadonly } =
      resolveInstanceProps(master);

    for (const occStart of occurrenceStarts) {
      // Skip if in exdates
      if (exdatesSet.has(occStart)) {
        continue;
      }

      // Check if overridden by an exception instance
      const exceptionEv = exceptionMap.get(occStart);
      if (exceptionEv) {
        emittedExceptionIds.add(exceptionEv.id);
        if (exceptionEv.end_time >= windowStartMs && exceptionEv.start_time <= windowEndMs) {
          const { color: exColor, reminders: exReminders } = resolveInstanceProps(exceptionEv);
          results.push({
            instanceId: exceptionEv.id,
            eventId: exceptionEv.id,
            masterEventId: master.id,
            calendarId: exceptionEv.calendar_id,
            title: exceptionEv.title,
            description: exceptionEv.description || '',
            location: exceptionEv.location || '',
            color: exColor,
            startTime: exceptionEv.start_time,
            endTime: exceptionEv.end_time,
            isAllDay: exceptionEv.is_all_day === 1,
            timezone: exceptionEv.timezone || master.timezone || 'Asia/Shanghai',
            isRecurring: true,
            isLunarRecurring: isLunar,
            isException: true,
            rrule: master.rrule ?? null,
            originalStartTime: occStart,
            reminders: exReminders,
            isReadonly,
          });
        }
        continue;
      }

      const occEnd = occStart + duration;
      if (occEnd >= windowStartMs && occStart <= windowEndMs) {
        results.push({
          instanceId: `${master.id}_${occStart}`,
          eventId: master.id,
          masterEventId: master.id,
          calendarId: master.calendar_id,
          title: master.title,
          description: master.description || '',
          location: master.location || '',
          color: masterColor,
          startTime: occStart,
          endTime: occEnd,
          isAllDay: master.is_all_day === 1,
          timezone: master.timezone || 'Asia/Shanghai',
          isRecurring: true,
          isLunarRecurring: isLunar,
          isException: false,
          rrule: master.rrule ?? null,
          originalStartTime: occStart,
          reminders: masterReminders,
          isReadonly,
        });
      }
    }

    // Also check if any exception instance was moved INTO [windowStartMs, windowEndMs]
    // from an original_start_time that was outside [searchStartMs, windowEndMs]
    for (const [origStart, exceptionEv] of exceptionMap.entries()) {
      if (emittedExceptionIds.has(exceptionEv.id)) continue;
      if (exdatesSet.has(origStart)) continue;
      if (exceptionEv.end_time >= windowStartMs && exceptionEv.start_time <= windowEndMs) {
        const { color: exColor, reminders: exReminders } = resolveInstanceProps(exceptionEv);
        results.push({
          instanceId: exceptionEv.id,
          eventId: exceptionEv.id,
          masterEventId: master.id,
          calendarId: exceptionEv.calendar_id,
          title: exceptionEv.title,
          description: exceptionEv.description || '',
          location: exceptionEv.location || '',
          color: exColor,
          startTime: exceptionEv.start_time,
          endTime: exceptionEv.end_time,
          isAllDay: exceptionEv.is_all_day === 1,
          timezone: exceptionEv.timezone || master.timezone || 'Asia/Shanghai',
          isRecurring: true,
          isLunarRecurring: isLunar,
          isException: true,
          rrule: master.rrule ?? null,
          originalStartTime: origStart,
          reminders: exReminders,
          isReadonly,
        });
      }
    }
  }

  results.sort((a, b) => {
    if (a.startTime !== b.startTime) return a.startTime - b.startTime;
    if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  return results;
}

export interface RecurrenceMutationResult {
  /** Existing records that were modified (including soft-deleted) */
  updatedRecords: EventRecord[];
  /** Newly created records (e.g. exception instance or split new master event) */
  createdRecords: EventRecord[];
}

/**
 * Pure function to delete a recurring event instance under one of the 3 scopes:
 * - 'THIS': Only this occurrence
 * - 'THIS_AND_FOLLOWING': This and all following occurrences
 * - 'ALL': The entire recurring series and all its exceptions
 */
export function deleteRecurringEvent(params: {
  masterEvent: EventRecord;
  existingExceptions: EventRecord[];
  instanceStartTime: number;
  scope: RecurrenceEditScope;
  nowMs?: number;
}): RecurrenceMutationResult {
  const { masterEvent, existingExceptions, instanceStartTime, scope } = params;
  const nowMs = params.nowMs ?? Date.now();

  if (scope === 'ALL' || (scope === 'THIS_AND_FOLLOWING' && instanceStartTime <= masterEvent.start_time)) {
    const updatedMaster: EventRecord = {
      ...masterEvent,
      is_deleted: 1,
      updated_at: nowMs,
      sync_status: 'DIRTY',
    };
    const updatedExceptions = existingExceptions
      .filter((ex) => ex.is_deleted === 0)
      .map((ex) => ({
        ...ex,
        is_deleted: 1,
        updated_at: nowMs,
        sync_status: 'DIRTY' as const,
      }));
    return {
      updatedRecords: [updatedMaster, ...updatedExceptions],
      createdRecords: [],
    };
  }

  if (scope === 'THIS') {
    const exdates = parseJsonNumberArray(masterEvent.exdates, []);
    if (!exdates.includes(instanceStartTime)) {
      exdates.push(instanceStartTime);
      exdates.sort((a, b) => a - b);
    }
    const updatedMaster: EventRecord = {
      ...masterEvent,
      exdates: JSON.stringify(exdates),
      updated_at: nowMs,
      sync_status: 'DIRTY',
    };

    const matchingExceptions = existingExceptions
      .filter((ex) => ex.is_deleted === 0 && ex.original_start_time === instanceStartTime)
      .map((ex) => ({
        ...ex,
        is_deleted: 1,
        updated_at: nowMs,
        sync_status: 'DIRTY' as const,
      }));

    return {
      updatedRecords: [updatedMaster, ...matchingExceptions],
      createdRecords: [],
    };
  }

  // scope === 'THIS_AND_FOLLOWING' (with instanceStartTime > masterEvent.start_time)
  const truncatedRRule = masterEvent.rrule
    ? setRRuleUntil(masterEvent.rrule, instanceStartTime - 1)
    : null;

  const updatedMaster: EventRecord = {
    ...masterEvent,
    rrule: truncatedRRule,
    updated_at: nowMs,
    sync_status: 'DIRTY',
  };

  const deletedFutureExceptions = existingExceptions
    .filter(
      (ex) =>
        ex.is_deleted === 0 &&
        typeof ex.original_start_time === 'number' &&
        ex.original_start_time >= instanceStartTime
    )
    .map((ex) => ({
      ...ex,
      is_deleted: 1,
      updated_at: nowMs,
      sync_status: 'DIRTY' as const,
    }));

  return {
    updatedRecords: [updatedMaster, ...deletedFutureExceptions],
    createdRecords: [],
  };
}

export interface RecurringEventChanges {
  title?: string;
  description?: string;
  location?: string;
  color?: string | null;
  calendar_id?: string;
  start_time?: number;
  end_time?: number;
  is_all_day?: number;
  rrule?: string | null;
  reminders?: string;
}

/**
 * Pure function to edit a recurring event instance under one of the 3 scopes:
 * - 'THIS': Creates or updates an exception instance linked via recurring_event_id
 * - 'THIS_AND_FOLLOWING': Truncates original master event UNTIL = instanceStartTime - 1 and creates a new master event
 * - 'ALL': Updates the master event directly
 */
export function editRecurringEvent(params: {
  masterEvent: EventRecord;
  existingExceptions: EventRecord[];
  instanceStartTime: number;
  scope: RecurrenceEditScope;
  changes: RecurringEventChanges;
  newRecordId: string;
  nowMs?: number;
}): RecurrenceMutationResult {
  const {
    masterEvent,
    existingExceptions,
    instanceStartTime,
    scope,
    changes,
    newRecordId,
  } = params;
  const nowMs = params.nowMs ?? Date.now();
  const masterDuration = Math.max(0, masterEvent.end_time - masterEvent.start_time);

  if (scope === 'THIS') {
    const existingEx = existingExceptions.find(
      (ex) => ex.is_deleted === 0 && ex.original_start_time === instanceStartTime
    );

    const nextStart = changes.start_time ?? existingEx?.start_time ?? instanceStartTime;
    const nextEnd =
      changes.end_time ??
      (changes.start_time !== undefined
        ? changes.start_time + masterDuration
        : existingEx?.end_time ?? instanceStartTime + masterDuration);

    if (existingEx) {
      const updatedEx: EventRecord = {
        ...existingEx,
        title: changes.title ?? existingEx.title,
        description: changes.description ?? existingEx.description,
        location: changes.location ?? existingEx.location,
        color: changes.color !== undefined ? changes.color : existingEx.color,
        calendar_id: changes.calendar_id ?? existingEx.calendar_id,
        start_time: nextStart,
        end_time: nextEnd,
        is_all_day: changes.is_all_day ?? existingEx.is_all_day,
        reminders: changes.reminders ?? existingEx.reminders,
        updated_at: nowMs,
        sync_status: 'DIRTY',
      };
      return {
        updatedRecords: [updatedEx],
        createdRecords: [],
      };
    }

    const newException: EventRecord = {
      id: newRecordId,
      calendar_id: changes.calendar_id ?? masterEvent.calendar_id,
      external_uid: null,
      title: changes.title ?? masterEvent.title,
      description: changes.description ?? masterEvent.description,
      location: changes.location ?? masterEvent.location,
      color: changes.color !== undefined ? changes.color : masterEvent.color,
      start_time: nextStart,
      end_time: nextEnd,
      is_all_day: changes.is_all_day ?? masterEvent.is_all_day,
      timezone: masterEvent.timezone,
      rrule: null,
      exdates: '[]',
      recurring_event_id: masterEvent.id,
      original_start_time: instanceStartTime,
      reminders: changes.reminders ?? masterEvent.reminders,
      created_at: nowMs,
      updated_at: nowMs,
      sync_version: 0,
      is_deleted: 0,
      sync_status: 'DIRTY',
    };

    return {
      updatedRecords: [],
      createdRecords: [newException],
    };
  }

  if (scope === 'ALL' || (scope === 'THIS_AND_FOLLOWING' && instanceStartTime <= masterEvent.start_time)) {
    const startDelta =
      changes.start_time !== undefined ? changes.start_time - instanceStartTime : 0;
    const newDuration =
      changes.start_time !== undefined && changes.end_time !== undefined
        ? Math.max(0, changes.end_time - changes.start_time)
        : masterDuration;

    const nextMasterStart = masterEvent.start_time + startDelta;
    const nextMasterEnd = nextMasterStart + newDuration;

    let nextRRule = changes.rrule !== undefined ? changes.rrule : masterEvent.rrule;
    if (
      changes.rrule === undefined &&
      nextRRule &&
      isLunarRRule(nextRRule) &&
      startDelta !== 0
    ) {
      const parsedLunar = parseLunarRRule(nextRRule);
      if (parsedLunar) {
        nextRRule = createLunarRRuleFromTimestamp(
          nextMasterStart,
          parsedLunar.freq,
          parsedLunar.until
        );
      }
    }

    const updatedMaster: EventRecord = {
      ...masterEvent,
      calendar_id: changes.calendar_id ?? masterEvent.calendar_id,
      title: changes.title ?? masterEvent.title,
      description: changes.description ?? masterEvent.description,
      location: changes.location ?? masterEvent.location,
      color: changes.color !== undefined ? changes.color : masterEvent.color,
      start_time: nextMasterStart,
      end_time: nextMasterEnd,
      is_all_day: changes.is_all_day ?? masterEvent.is_all_day,
      rrule: nextRRule,
      reminders: changes.reminders ?? masterEvent.reminders,
      updated_at: nowMs,
      sync_status: 'DIRTY',
    };

    return {
      updatedRecords: [updatedMaster],
      createdRecords: [],
    };
  }

  // scope === 'THIS_AND_FOLLOWING' (with instanceStartTime > masterEvent.start_time)
  const truncatedRRule = masterEvent.rrule
    ? setRRuleUntil(masterEvent.rrule, instanceStartTime - 1)
    : null;

  const updatedMaster: EventRecord = {
    ...masterEvent,
    rrule: truncatedRRule,
    updated_at: nowMs,
    sync_status: 'DIRTY',
  };

  // Delete any exceptions of the old master that were on or after instanceStartTime
  const deletedFutureExceptions = existingExceptions
    .filter(
      (ex) =>
        ex.is_deleted === 0 &&
        typeof ex.original_start_time === 'number' &&
        ex.original_start_time >= instanceStartTime
    )
    .map((ex) => ({
      ...ex,
      is_deleted: 1,
      updated_at: nowMs,
      sync_status: 'DIRTY' as const,
    }));

  const newStart = changes.start_time ?? instanceStartTime;
  const newEnd =
    changes.end_time ??
    (changes.start_time !== undefined
      ? changes.start_time + masterDuration
      : instanceStartTime + masterDuration);

  let newMasterRRule = changes.rrule !== undefined ? changes.rrule : masterEvent.rrule;
  if (changes.rrule === undefined && newMasterRRule && isLunarRRule(newMasterRRule)) {
    const parsedLunar = parseLunarRRule(newMasterRRule);
    if (parsedLunar) {
      newMasterRRule = createLunarRRuleFromTimestamp(
        newStart,
        parsedLunar.freq,
        parsedLunar.until
      );
    }
  }

  const newMaster: EventRecord = {
    id: newRecordId,
    calendar_id: changes.calendar_id ?? masterEvent.calendar_id,
    external_uid: null,
    title: changes.title ?? masterEvent.title,
    description: changes.description ?? masterEvent.description,
    location: changes.location ?? masterEvent.location,
    color: changes.color !== undefined ? changes.color : masterEvent.color,
    start_time: newStart,
    end_time: newEnd,
    is_all_day: changes.is_all_day ?? masterEvent.is_all_day,
    timezone: masterEvent.timezone,
    rrule: newMasterRRule,
    exdates: '[]',
    recurring_event_id: null,
    original_start_time: null,
    reminders: changes.reminders ?? masterEvent.reminders,
    created_at: nowMs,
    updated_at: nowMs,
    sync_version: 0,
    is_deleted: 0,
    sync_status: 'DIRTY',
  };

  return {
    updatedRecords: [updatedMaster, ...deletedFutureExceptions],
    createdRecords: [newMaster],
  };
}
