export * from './schema/index.js';
export * from './lunar/index.js';
export * from './recurrence/index.js';
export * from './ics/index.js';

import { CalendarRecord, EventRecord, ExpandedEventInstance } from './schema/index.js';
import { expandEventsInWindow } from './recurrence/index.js';

export interface ScheduledReminderTrigger {
  triggerId: string;
  instanceId: string;
  eventId: string;
  calendarId: string;
  title: string;
  location: string;
  eventStartTime: number;
  eventEndTime: number;
  isAllDay: boolean;
  reminderMinutes: number;
  triggerTime: number;
}

/**
 * Rolling Window Local Alarm Calculator:
 * Expands events over the next `windowDays` (default 14 days), computes absolute trigger timestamps,
 * filters strictly future triggers (> nowMs), and returns the earliest `maxAlarms` (default 50).
 */
export function computeUpcomingReminderTriggers(params: {
  events: EventRecord[];
  calendars?: CalendarRecord[];
  nowMs?: number;
  windowDays?: number;
  maxAlarms?: number;
}): ScheduledReminderTrigger[] {
  const nowMs = params.nowMs ?? Date.now();
  const windowDays = params.windowDays ?? 14;
  const maxAlarms = params.maxAlarms ?? 50;

  // Include a extra day at the tail so reminders for events on day 14+ that trigger within day 14 are caught
  const windowEndMs = nowMs + (windowDays + 1) * 24 * 60 * 60 * 1000;
  const instances: ExpandedEventInstance[] = expandEventsInWindow(
    params.events,
    nowMs,
    windowEndMs,
    params.calendars
  );

  const triggers: ScheduledReminderTrigger[] = [];
  const windowLimitMs = nowMs + windowDays * 24 * 60 * 60 * 1000;

  for (const inst of instances) {
    const uniqueReminders = Array.from(new Set(inst.reminders)).filter(
      (m) => Number.isFinite(m) && m >= 0
    );
    for (const mins of uniqueReminders) {
      const triggerTime = inst.startTime - mins * 60 * 1000;
      if (triggerTime > nowMs && triggerTime <= windowLimitMs) {
        triggers.push({
          triggerId: `${inst.instanceId}_rem_${mins}`,
          instanceId: inst.instanceId,
          eventId: inst.eventId,
          calendarId: inst.calendarId,
          title: inst.title,
          location: inst.location,
          eventStartTime: inst.startTime,
          eventEndTime: inst.endTime,
          isAllDay: inst.isAllDay,
          reminderMinutes: mins,
          triggerTime,
        });
      }
    }
  }

  triggers.sort((a, b) => a.triggerTime - b.triggerTime);
  return triggers.slice(0, maxAlarms);
}
