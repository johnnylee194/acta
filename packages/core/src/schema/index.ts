import { z } from 'zod';

export const SyncStatusSchema = z.enum(['SYNCED', 'DIRTY']);
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const CalendarSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().default('#3B82F6'),
  is_visible: z.number().int().min(0).max(1).default(1),
  is_readonly: z.number().int().min(0).max(1).default(0),
  source_url: z.string().nullable().optional().default(null),
  default_reminders: z.string().default('[]'), // JSON string of number[] (minutes before start)
  last_fetched_at: z.number().int().nullable().optional().default(null),
  sort_order: z.number().int().default(0),
  updated_at: z.number().int(),
  sync_version: z.number().int().default(0),
  is_deleted: z.number().int().min(0).max(1).default(0),
  sync_status: SyncStatusSchema.optional(),
});

export type CalendarRecord = z.infer<typeof CalendarSchema>;

export const EventSchema = z.object({
  id: z.string().min(1),
  calendar_id: z.string().min(1),
  external_uid: z.string().nullable().optional().default(null),
  title: z.string().min(1),
  description: z.string().default(''),
  location: z.string().default(''),
  color: z.string().nullable().optional().default(null),

  start_time: z.number().int(),
  end_time: z.number().int(),
  is_all_day: z.number().int().min(0).max(1).default(0),
  timezone: z.string().default('Asia/Shanghai'),

  // Recurrence:
  // - Standard RFC 5545 string, e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  // - Or Lunar extension string, e.g. "LUNAR:FREQ=YEARLY;MONTH=8;DAY=15" or "LUNAR:FREQ=MONTHLY;DAY=1"
  rrule: z.string().nullable().optional().default(null),
  exdates: z.string().default('[]'), // JSON array of UTC ms timestamps

  recurring_event_id: z.string().nullable().optional().default(null),
  original_start_time: z.number().int().nullable().optional().default(null),

  reminders: z.string().default('[15]'), // JSON array of minutes before start

  created_at: z.number().int(),
  updated_at: z.number().int(),
  sync_version: z.number().int().default(0),
  is_deleted: z.number().int().min(0).max(1).default(0),
  sync_status: SyncStatusSchema.optional(),
});

export type EventRecord = z.infer<typeof EventSchema>;

export type RecurrenceEditScope = 'THIS' | 'THIS_AND_FOLLOWING' | 'ALL';

export interface ExpandedEventInstance {
  /** Runtime composite ID: `${masterId}_${instanceStartTime}` for virtual instances, or `event.id` for standalone/exception instances */
  instanceId: string;
  /** The underlying DB row ID (master event ID for virtual instances, or concrete event ID) */
  eventId: string;
  /** If this is a virtual instance or exception instance of a recurring event, points to master event ID */
  masterEventId: string | null;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  color: string;
  startTime: number;
  endTime: number;
  isAllDay: boolean;
  timezone: string;
  isRecurring: boolean;
  isLunarRecurring: boolean;
  isException: boolean;
  rrule: string | null;
  /** Original occurrence start time in the recurrence series */
  originalStartTime: number;
  /** Merged reminder minutes (from event.reminders or calendar.default_reminders) */
  reminders: number[];
  isReadonly: boolean;
}

export const SyncPushRequestSchema = z.object({
  calendars: z.array(CalendarSchema).default([]),
  events: z.array(EventSchema).default([]),
});
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

export const SyncPushResponseSchema = z.object({
  appliedCalendarIds: z.array(z.string()),
  appliedEventIds: z.array(z.string()),
  serverSyncVersion: z.number().int(),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

export const SyncPullResponseSchema = z.object({
  calendars: z.array(CalendarSchema),
  events: z.array(EventSchema),
  serverSyncVersion: z.number().int(),
});
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;

export const CreateSubscriptionRequestSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  color: z.string().default('#2563EB'),
  defaultReminders: z.array(z.number().int().min(0)).default([30]),
});
export type CreateSubscriptionRequest = z.infer<typeof CreateSubscriptionRequestSchema>;

export const ImportIcsRequestSchema = z.object({
  calendarId: z.string().optional(),
  calendarName: z.string().optional().default('导入的日历'),
  calendarColor: z.string().optional().default('#10B981'),
  icsContent: z.string().min(1),
});
export type ImportIcsRequest = z.infer<typeof ImportIcsRequestSchema>;

export function parseJsonNumberArray(raw: string | null | undefined, fallback: number[] = []): number[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    }
  } catch {
    // ignore invalid json
  }
  return fallback;
}
