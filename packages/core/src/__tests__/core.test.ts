import { describe, expect, it } from 'vitest';
import {
  CalendarRecord,
  EventRecord,
  computeUpcomingReminderTriggers,
  createLunarRRuleFromTimestamp,
  deleteRecurringEvent,
  editRecurringEvent,
  expandEventsInWindow,
  exportEventsToIcs,
  fromCstComponents,
  getLunarDayInfo,
  parseIcsContent,
} from '../index.js';

function makeBaseMasterEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  // 2026-11-09 09:00:00 Asia/Shanghai (Monday)
  const start = fromCstComponents(2026, 11, 9, 9, 0, 0);
  const end = fromCstComponents(2026, 11, 9, 10, 0, 0);
  return {
    id: 'master-1',
    calendar_id: 'cal-1',
    external_uid: null,
    title: '晨会',
    description: '团队每日对齐',
    location: '会议室A',
    color: null,
    start_time: start,
    end_time: end,
    is_all_day: 0,
    timezone: 'Asia/Shanghai',
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    exdates: '[]',
    recurring_event_id: null,
    original_start_time: null,
    reminders: '[15]',
    created_at: start,
    updated_at: start,
    sync_version: 1,
    is_deleted: 0,
    ...overrides,
  };
}

describe('@acta/core recurrence, lunar, ICS & reminder engine', () => {
  it('expands Gregorian weekly RRULE accurately in Asia/Shanghai wall-clock time (including 06:00 CST early morning)', () => {
    // 2026-11-09 is Monday in Asia/Shanghai. At 06:00 CST, UTC is Sunday 22:00Z!
    const earlyMonStart = fromCstComponents(2026, 11, 9, 6, 0, 0);
    const earlyMonEnd = fromCstComponents(2026, 11, 9, 7, 0, 0);
    const master = makeBaseMasterEvent({
      start_time: earlyMonStart,
      end_time: earlyMonEnd,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    });

    const winStart = fromCstComponents(2026, 11, 9, 0, 0, 0);
    const winEnd = fromCstComponents(2026, 11, 15, 23, 59, 59);

    const instances = expandEventsInWindow([master], winStart, winEnd);
    expect(instances).toHaveLength(3);
    expect(instances.map((i) => i.startTime)).toEqual([
      fromCstComponents(2026, 11, 9, 6, 0, 0), // Mon
      fromCstComponents(2026, 11, 11, 6, 0, 0), // Wed
      fromCstComponents(2026, 11, 13, 6, 0, 0), // Fri
    ]);
  });

  it('handles THIS, THIS_AND_FOLLOWING, and ALL scopes when editing and deleting recurring events', () => {
    const master = makeBaseMasterEvent();
    const monStart = fromCstComponents(2026, 11, 9, 9, 0, 0);
    const wedStart = fromCstComponents(2026, 11, 11, 9, 0, 0);
    const friStart = fromCstComponents(2026, 11, 13, 9, 0, 0);
    const nextMonStart = fromCstComponents(2026, 11, 16, 9, 0, 0);

    // 1. Delete Wednesday only ('THIS')
    const delThis = deleteRecurringEvent({
      masterEvent: master,
      existingExceptions: [],
      instanceStartTime: wedStart,
      scope: 'THIS',
      nowMs: 2000,
    });
    const masterAfterDel = delThis.updatedRecords[0];
    expect(JSON.parse(masterAfterDel.exdates)).toEqual([wedStart]);

    // 2. Edit Friday only ('THIS') -> move to 14:00 and rename
    const friNewStart = fromCstComponents(2026, 11, 13, 14, 0, 0);
    const editThis = editRecurringEvent({
      masterEvent: masterAfterDel,
      existingExceptions: [],
      instanceStartTime: friStart,
      scope: 'THIS',
      changes: {
        title: '周五架构评审（改期）',
        start_time: friNewStart,
      },
      newRecordId: 'ex-fri-1',
      nowMs: 3000,
    });
    expect(editThis.createdRecords).toHaveLength(1);
    const friException = editThis.createdRecords[0];
    expect(friException.recurring_event_id).toBe(master.id);
    expect(friException.original_start_time).toBe(friStart);

    const winStart = fromCstComponents(2026, 11, 9, 0, 0, 0);
    const winEnd = fromCstComponents(2026, 11, 20, 23, 59, 59);
    const expandedAfterThis = expandEventsInWindow(
      [masterAfterDel, friException],
      winStart,
      winEnd
    );
    // Week 1: Mon (9th), Wed deleted, Fri (13th moved to 14:00)
    // Week 2: Mon (16th), Wed (18th), Fri (20th)
    expect(expandedAfterThis).toHaveLength(5);
    expect(expandedAfterThis[0].startTime).toBe(monStart);
    expect(expandedAfterThis[1].title).toBe('周五架构评审（改期）');
    expect(expandedAfterThis[1].startTime).toBe(friNewStart);
    expect(expandedAfterThis[1].isException).toBe(true);

    // 3. Edit next Monday ('THIS_AND_FOLLOWING') -> split series from Nov 16 onwards
    const splitRes = editRecurringEvent({
      masterEvent: masterAfterDel,
      existingExceptions: [friException],
      instanceStartTime: nextMonStart,
      scope: 'THIS_AND_FOLLOWING',
      changes: {
        title: '新阶段晨会',
      },
      newRecordId: 'master-2',
      nowMs: 4000,
    });
    const truncatedMaster = splitRes.updatedRecords[0];
    const newMaster = splitRes.createdRecords[0];
    expect(truncatedMaster.rrule).toContain('UNTIL=');
    expect(newMaster.id).toBe('master-2');
    expect(newMaster.start_time).toBe(nextMonStart);

    const expandedAfterSplit = expandEventsInWindow(
      [truncatedMaster, friException, newMaster],
      winStart,
      winEnd
    );
    expect(expandedAfterSplit.map((e) => e.title)).toEqual([
      '晨会',
      '周五架构评审（改期）',
      '新阶段晨会',
      '新阶段晨会',
      '新阶段晨会',
    ]);
  });

  it('computes offline Lunar day info and expands LUNAR: yearly/monthly recurrences', () => {
    // 2026-11-09 is Lunar 2026-10-01 (十月初一)
    const nov9 = fromCstComponents(2026, 11, 9, 10, 0, 0);
    const info = getLunarDayInfo(nov9);
    expect(info.lunarMonth).toBe(10);
    expect(info.lunarDay).toBe(1);
    expect(info.shortLabel).toBe('十月');

    // Create a yearly lunar birthday on Lunar 10th month 1st day
    const lunarRule = createLunarRRuleFromTimestamp(nov9, 'YEARLY');
    expect(lunarRule).toBe('LUNAR:FREQ=YEARLY;MONTH=10;DAY=1');

    const lunarMaster = makeBaseMasterEvent({
      id: 'lunar-bday',
      title: '母亲农历生日',
      start_time: nov9,
      end_time: nov9 + 3600_000,
      rrule: lunarRule,
    });

    // Expand across 2026-01-01 to 2027-12-31
    const instances = expandEventsInWindow(
      [lunarMaster],
      fromCstComponents(2026, 1, 1, 0, 0, 0),
      fromCstComponents(2027, 12, 31, 23, 59, 59)
    );
    expect(instances).toHaveLength(2);
    // Both occurrences must fall on Lunar 10-01 in 2026 and 2027
    for (const inst of instances) {
      const lInfo = getLunarDayInfo(inst.startTime);
      expect(lInfo.lunarMonth).toBe(10);
      expect(lInfo.lunarDay).toBe(1);
      expect(inst.isLunarRecurring).toBe(true);
    }
  });

  it('parses Google Calendar & Real Madrid iCal feeds and computes rolling 14-day reminder triggers', () => {
    const sampleIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'X-WR-CALNAME:Real Madrid Schedule',
      'BEGIN:VEVENT',
      'UID:rm-match-001@realmadrid.com',
      'SUMMARY:Real Madrid vs Barcelona',
      'LOCATION:Santiago Bernabeu',
      'DTSTART:20261114T200000Z',
      'DTEND:20261114T220000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const rmCal: CalendarRecord = {
      id: 'cal-rm',
      name: '皇马比赛',
      color: '#2563EB',
      is_visible: 1,
      is_readonly: 1,
      source_url: 'https://example.com/realmadrid.ics',
      default_reminders: '[30, 10]',
      last_fetched_at: Date.now(),
      sort_order: 1,
      updated_at: Date.now(),
      sync_version: 1,
      is_deleted: 0,
    };

    const parsed = parseIcsContent({
      icsContent: sampleIcs,
      calendarId: rmCal.id,
      defaultReminders: [30, 10],
    });
    expect(parsed.calendarName).toBe('Real Madrid Schedule');
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].external_uid).toBe('rm-match-001@realmadrid.com');
    expect(parsed.events[0].title).toBe('Real Madrid vs Barcelona');
    expect(parsed.events[0].start_time).toBe(Date.UTC(2026, 10, 14, 20, 0, 0));

    // Export and verify round-trip
    const exported = exportEventsToIcs(rmCal.name, parsed.events);
    expect(exported).toContain('UID:rm-match-001@realmadrid.com');
    expect(exported).toContain('SUMMARY:Real Madrid vs Barcelona');

    // Compute upcoming reminders from 2026-11-13T12:00:00Z
    const nowMs = Date.UTC(2026, 10, 13, 12, 0, 0);
    const triggers = computeUpcomingReminderTriggers({
      events: parsed.events,
      calendars: [rmCal],
      nowMs,
      windowDays: 14,
      maxAlarms: 50,
    });
    expect(triggers).toHaveLength(2);
    // 30 mins before comes before 10 mins before
    expect(triggers[0].reminderMinutes).toBe(30);
    expect(triggers[0].triggerTime).toBe(Date.UTC(2026, 10, 14, 19, 30, 0));
    expect(triggers[1].reminderMinutes).toBe(10);
    expect(triggers[1].triggerTime).toBe(Date.UTC(2026, 10, 14, 19, 50, 0));
  });
});
