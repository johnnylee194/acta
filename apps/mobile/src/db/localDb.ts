import * as SQLite from 'expo-sqlite';
import {
  CalendarRecord,
  EventRecord,
  SyncPullResponse,
  SyncPushRequest,
} from '@acta/core';

let dbInstance: SQLite.SQLiteDatabase | null = null;

export function getLocalDb(): SQLite.SQLiteDatabase {
  if (dbInstance) return dbInstance;
  const db = SQLite.openDatabaseSync('acta_local.db');
  db.execSync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS calendars (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#3B82F6',
      is_visible INTEGER NOT NULL DEFAULT 1,
      is_readonly INTEGER NOT NULL DEFAULT 0,
      source_url TEXT,
      default_reminders TEXT DEFAULT '[]',
      last_fetched_at INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      sync_version INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT NOT NULL DEFAULT 'SYNCED'
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL,
      external_uid TEXT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      location TEXT DEFAULT '',
      color TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      is_all_day INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      rrule TEXT,
      exdates TEXT DEFAULT '[]',
      recurring_event_id TEXT,
      original_start_time INTEGER,
      reminders TEXT NOT NULL DEFAULT '[15]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sync_version INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT NOT NULL DEFAULT 'SYNCED'
    );

    CREATE INDEX IF NOT EXISTS idx_local_events_time ON events(start_time, end_time);
    CREATE INDEX IF NOT EXISTS idx_local_events_recurring ON events(recurring_event_id);
    CREATE INDEX IF NOT EXISTS idx_local_events_dirty ON events(sync_status);

    CREATE TABLE IF NOT EXISTS local_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Ensure at least one default local calendar exists for immediate offline use before first sync
  const countRow = db.getFirstSync<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM calendars'
  );
  if (!countRow || countRow.cnt === 0) {
    const now = Date.now();
    db.runSync(
      `INSERT INTO calendars (
        id, name, color, is_visible, is_readonly, source_url, default_reminders,
        last_fetched_at, sort_order, updated_at, sync_version, is_deleted, sync_status
      ) VALUES ('cal-personal', '个人事务', '#3B82F6', 1, 0, NULL, '[15]', NULL, 0, ?, 0, 0, 'SYNCED')`,
      [now]
    );
  }

  dbInstance = db;
  return db;
}

export interface ServerConfig {
  serverUrl: string;
  authToken: string;
  lastSyncVersion: number;
}

export function getServerConfig(): ServerConfig {
  const db = getLocalDb();
  const rows = db.getAllSync<{ key: string; value: string }>(
    'SELECT key, value FROM local_meta'
  );
  const map: Record<string, string> = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return {
    serverUrl: map.server_url || '',
    authToken: map.auth_token || '',
    lastSyncVersion: Number(map.last_sync_version || 0),
  };
}

export function saveServerConfig(serverUrl: string, authToken: string): void {
  const db = getLocalDb();
  const cleanUrl = serverUrl.trim().replace(/\/+$/, '');
  db.withTransactionSync(() => {
    db.runSync(
      `INSERT OR REPLACE INTO local_meta (key, value) VALUES ('server_url', ?)`,
      [cleanUrl]
    );
    db.runSync(
      `INSERT OR REPLACE INTO local_meta (key, value) VALUES ('auth_token', ?)`,
      [authToken.trim()]
    );
  });
}

export function getAllLocalCalendars(): CalendarRecord[] {
  const db = getLocalDb();
  return db.getAllSync<CalendarRecord>(
    'SELECT * FROM calendars WHERE is_deleted = 0 ORDER BY sort_order ASC, name ASC'
  );
}

export function getAllLocalEvents(): EventRecord[] {
  const db = getLocalDb();
  return db.getAllSync<EventRecord>('SELECT * FROM events WHERE is_deleted = 0');
}

export function getLocalEventById(id: string): EventRecord | null {
  const db = getLocalDb();
  return db.getFirstSync<EventRecord>('SELECT * FROM events WHERE id = ?', [id]);
}

export function getLocalExceptionsForMaster(masterId: string): EventRecord[] {
  const db = getLocalDb();
  return db.getAllSync<EventRecord>(
    'SELECT * FROM events WHERE recurring_event_id = ? AND is_deleted = 0',
    [masterId]
  );
}

export function saveLocalCalendar(cal: CalendarRecord): void {
  const db = getLocalDb();
  db.runSync(
    `INSERT OR REPLACE INTO calendars (
      id, name, color, is_visible, is_readonly, source_url, default_reminders,
      last_fetched_at, sort_order, updated_at, sync_version, is_deleted, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DIRTY')`,
    [
      cal.id,
      cal.name,
      cal.color,
      cal.is_visible,
      cal.is_readonly ?? 0,
      cal.source_url ?? null,
      cal.default_reminders ?? '[]',
      cal.last_fetched_at ?? null,
      cal.sort_order ?? 0,
      cal.updated_at,
      cal.sync_version ?? 0,
      cal.is_deleted ?? 0,
    ]
  );
}

export function saveLocalEventMutations(
  updatedRecords: EventRecord[],
  createdRecords: EventRecord[]
): void {
  const db = getLocalDb();
  const all = [...updatedRecords, ...createdRecords];
  db.withTransactionSync(() => {
    for (const ev of all) {
      db.runSync(
        `INSERT OR REPLACE INTO events (
          id, calendar_id, external_uid, title, description, location, color,
          start_time, end_time, is_all_day, timezone, rrule, exdates,
          recurring_event_id, original_start_time, reminders,
          created_at, updated_at, sync_version, is_deleted, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DIRTY')`,
        [
          ev.id,
          ev.calendar_id,
          ev.external_uid ?? null,
          ev.title,
          ev.description ?? '',
          ev.location ?? '',
          ev.color ?? null,
          ev.start_time,
          ev.end_time,
          ev.is_all_day ?? 0,
          ev.timezone ?? 'Asia/Shanghai',
          ev.rrule ?? null,
          ev.exdates ?? '[]',
          ev.recurring_event_id ?? null,
          ev.original_start_time ?? null,
          ev.reminders ?? '[15]',
          ev.created_at,
          ev.updated_at,
          ev.sync_version ?? 0,
          ev.is_deleted ?? 0,
        ]
      );
    }
  });
}

export function getDirtySyncPayload(): SyncPushRequest {
  const db = getLocalDb();
  const calendars = db.getAllSync<CalendarRecord>(
    `SELECT * FROM calendars WHERE sync_status = 'DIRTY'`
  );
  const events = db.getAllSync<EventRecord>(
    `SELECT * FROM events WHERE sync_status = 'DIRTY'`
  );
  return { calendars, events };
}

export function markDirtyRecordsAsSynced(
  calendarIds: string[],
  eventIds: string[]
): void {
  const db = getLocalDb();
  db.withTransactionSync(() => {
    for (const cid of calendarIds) {
      db.runSync(`UPDATE calendars SET sync_status = 'SYNCED' WHERE id = ?`, [cid]);
    }
    for (const eid of eventIds) {
      db.runSync(`UPDATE events SET sync_status = 'SYNCED' WHERE id = ?`, [eid]);
    }
  });
}

export function applyRemoteSyncPull(payload: SyncPullResponse): void {
  const db = getLocalDb();
  db.withTransactionSync(() => {
    for (const cal of payload.calendars) {
      const local = db.getFirstSync<{ sync_status: string; updated_at: number }>(
        'SELECT sync_status, updated_at FROM calendars WHERE id = ?',
        [cal.id]
      );
      if (local && local.sync_status === 'DIRTY' && local.updated_at > cal.updated_at) {
        continue;
      }
      db.runSync(
        `INSERT OR REPLACE INTO calendars (
          id, name, color, is_visible, is_readonly, source_url, default_reminders,
          last_fetched_at, sort_order, updated_at, sync_version, is_deleted, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SYNCED')`,
        [
          cal.id,
          cal.name,
          cal.color,
          cal.is_visible,
          cal.is_readonly ?? 0,
          cal.source_url ?? null,
          cal.default_reminders ?? '[]',
          cal.last_fetched_at ?? null,
          cal.sort_order ?? 0,
          cal.updated_at,
          cal.sync_version,
          cal.is_deleted,
        ]
      );
    }

    for (const ev of payload.events) {
      const local = db.getFirstSync<{ sync_status: string; updated_at: number }>(
        'SELECT sync_status, updated_at FROM events WHERE id = ?',
        [ev.id]
      );
      if (local && local.sync_status === 'DIRTY' && local.updated_at > ev.updated_at) {
        continue;
      }
      db.runSync(
        `INSERT OR REPLACE INTO events (
          id, calendar_id, external_uid, title, description, location, color,
          start_time, end_time, is_all_day, timezone, rrule, exdates,
          recurring_event_id, original_start_time, reminders,
          created_at, updated_at, sync_version, is_deleted, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SYNCED')`,
        [
          ev.id,
          ev.calendar_id,
          ev.external_uid ?? null,
          ev.title,
          ev.description ?? '',
          ev.location ?? '',
          ev.color ?? null,
          ev.start_time,
          ev.end_time,
          ev.is_all_day ?? 0,
          ev.timezone ?? 'Asia/Shanghai',
          ev.rrule ?? null,
          ev.exdates ?? '[]',
          ev.recurring_event_id ?? null,
          ev.original_start_time ?? null,
          ev.reminders ?? '[15]',
          ev.created_at,
          ev.updated_at,
          ev.sync_version,
          ev.is_deleted,
        ]
      );
    }

    db.runSync(
      `INSERT OR REPLACE INTO local_meta (key, value) VALUES ('last_sync_version', ?)`,
      [String(payload.serverSyncVersion)]
    );
  });
}
