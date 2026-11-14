import cron from 'node-cron';
import {
  CalendarRecord,
  parseIcsContent,
  parseJsonNumberArray,
} from '@acta/core';
import {
  SqliteDb,
  performHotBackup,
  upsertIcsEventsIntoCalendar,
} from '../db/index.js';

export function normalizeSubscriptionUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.toLowerCase().startsWith('webcal://')) {
    return 'https://' + trimmed.slice('webcal://'.length);
  }
  if (trimmed.toLowerCase().startsWith('webcals://')) {
    return 'https://' + trimmed.slice('webcals://'.length);
  }
  return trimmed;
}

export async function defaultIcsFetcher(url: string): Promise<string> {
  const normalized = normalizeSubscriptionUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(normalized, {
      headers: {
        'User-Agent': 'ActaCalendar/1.0 (+https://github.com/acta-calendar)',
        Accept: 'text/calendar, text/plain, */*',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} when fetching ${normalized}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAndSyncSubscription(params: {
  db: SqliteDb;
  calendarId: string;
  broadcastSync?: (version: number) => void;
  fetcher?: (url: string) => Promise<string>;
}): Promise<{
  calendarId: string;
  inserted: number;
  updated: number;
  serverSyncVersion: number;
}> {
  const { db, calendarId, broadcastSync } = params;
  const fetcher = params.fetcher ?? defaultIcsFetcher;

  const cal = db
    .prepare(
      'SELECT * FROM calendars WHERE id = ? AND is_deleted = 0 AND source_url IS NOT NULL'
    )
    .get(calendarId) as CalendarRecord | undefined;

  if (!cal || !cal.source_url) {
    throw new Error(`Subscription calendar not found: ${calendarId}`);
  }

  const icsContent = await fetcher(cal.source_url);
  const defaultReminders = parseJsonNumberArray(cal.default_reminders, [30]);
  const parsed = parseIcsContent({
    icsContent,
    calendarId: cal.id,
    defaultReminders,
  });

  const res = upsertIcsEventsIntoCalendar({
    db,
    calendarId: cal.id,
    events: parsed.events,
    isSubscriptionSync: true,
  });

  if ((res.inserted > 0 || res.updated > 0) && broadcastSync) {
    broadcastSync(res.serverSyncVersion);
  }

  return {
    calendarId: cal.id,
    inserted: res.inserted,
    updated: res.updated,
    serverSyncVersion: res.serverSyncVersion,
  };
}

export async function refreshAllSubscriptions(params: {
  db: SqliteDb;
  broadcastSync?: (version: number) => void;
  fetcher?: (url: string) => Promise<string>;
}): Promise<void> {
  const { db, broadcastSync, fetcher } = params;
  const subs = db
    .prepare(
      'SELECT id FROM calendars WHERE is_deleted = 0 AND source_url IS NOT NULL AND source_url != ""'
    )
    .all() as Array<{ id: string }>;

  for (const sub of subs) {
    try {
      await fetchAndSyncSubscription({
        db,
        calendarId: sub.id,
        broadcastSync,
        fetcher,
      });
    } catch (err) {
      console.error(`[SubscriptionSync] Failed to refresh calendar ${sub.id}:`, err);
    }
  }
}

export function startBackgroundJobs(params: {
  db: SqliteDb;
  backupDir: string;
  broadcastSync: (version: number) => void;
}) {
  const { db, backupDir, broadcastSync } = params;

  // 1. Refresh external iCal subscriptions every 4 hours
  const subTask = cron.schedule('0 */4 * * *', () => {
    void refreshAllSubscriptions({ db, broadcastSync });
  });

  // 2. Daily SQLite zero-downtime hot backup at 03:30 Asia/Shanghai
  const backupTask = cron.schedule(
    '30 3 * * *',
    () => {
      try {
        const dest = performHotBackup(db, backupDir, 30);
        console.log(`[HotBackup] Created snapshot: ${dest}`);
      } catch (err) {
        console.error('[HotBackup] Failed:', err);
      }
    },
    { timezone: 'Asia/Shanghai' }
  );

  return {
    stop() {
      subTask.stop();
      backupTask.stop();
    },
  };
}
