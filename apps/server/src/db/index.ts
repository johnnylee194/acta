import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CalendarRecord,
  EventRecord,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  parseJsonNumberArray,
} from '@acta/core';

export type SqliteDb = Database.Database;

export function initDatabase(dbPath: string): SqliteDb {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
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
      sync_version INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0
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
      sync_version INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (calendar_id) REFERENCES calendars(id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_sync_version ON events(sync_version);
    CREATE INDEX IF NOT EXISTS idx_events_time_range ON events(start_time, end_time);
    CREATE INDEX IF NOT EXISTS idx_events_recurring ON events(recurring_event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_uid
      ON events(calendar_id, external_uid)
      WHERE external_uid IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('current_sync_version', 0);
  `);

  // Seed default calendars if none exist
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM calendars').get() as { cnt: number };
  if (countRow.cnt === 0) {
    const now = Date.now();
    const defaults = [
      { id: 'cal-personal', name: '个人事务', color: '#3B82F6', order: 0 },
      { id: 'cal-family', name: '家庭与纪念日', color: '#EC4899', order: 1 },
      { id: 'cal-health', name: '运动健康', color: '#10B981', order: 2 },
    ];
    const insertCal = db.prepare(`
      INSERT INTO calendars (
        id, name, color, is_visible, is_readonly, source_url, default_reminders,
        last_fetched_at, sort_order, updated_at, sync_version, is_deleted
      ) VALUES (?, ?, ?, 1, 0, NULL, '[15]', NULL, ?, ?, ?, 0)
    `);
    const updateVer = db.prepare(
      `UPDATE sync_meta SET value = ? WHERE key = 'current_sync_version'`
    );
    let ver = getCurrentSyncVersion(db);
    const tx = db.transaction(() => {
      for (const c of defaults) {
        ver += 1;
        insertCal.run(c.id, c.name, c.color, c.order, now, ver);
      }
      updateVer.run(ver);
    });
    tx();
  }

  return db;
}

export function getCurrentSyncVersion(db: SqliteDb): number {
  const row = db
    .prepare(`SELECT value FROM sync_meta WHERE key = 'current_sync_version'`)
    .get() as { value: number } | undefined;
  return row ? Number(row.value) : 0;
}

export function nextSyncVersion(db: SqliteDb): number {
  const next = getCurrentSyncVersion(db) + 1;
  db.prepare(`UPDATE sync_meta SET value = ? WHERE key = 'current_sync_version'`).run(next);
  return next;
}

/**
 * Apply client dirty records in a single SQLite transaction using Last-Write-Wins (updated_at),
 * plus union-merging `exdates` when updating a recurring master event.
 */
export function applySyncPush(db: SqliteDb, payload: SyncPushRequest): SyncPushResponse {
  const appliedCalendarIds: string[] = [];
  const appliedEventIds: string[] = [];

  const getCalStmt = db.prepare('SELECT updated_at FROM calendars WHERE id = ?');
  const upsertCalStmt = db.prepare(`
    INSERT INTO calendars (
      id, name, color, is_visible, is_readonly, source_url, default_reminders,
      last_fetched_at, sort_order, updated_at, sync_version, is_deleted
    ) VALUES (
      @id, @name, @color, @is_visible, @is_readonly, @source_url, @default_reminders,
      @last_fetched_at, @sort_order, @updated_at, @sync_version, @is_deleted
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      color = excluded.color,
      is_visible = excluded.is_visible,
      is_readonly = excluded.is_readonly,
      source_url = excluded.source_url,
      default_reminders = excluded.default_reminders,
      last_fetched_at = excluded.last_fetched_at,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at,
      sync_version = excluded.sync_version,
      is_deleted = excluded.is_deleted
  `);

  const getEventStmt = db.prepare(
    'SELECT updated_at, exdates, rrule FROM events WHERE id = ?'
  );
  const upsertEventStmt = db.prepare(`
    INSERT INTO events (
      id, calendar_id, external_uid, title, description, location, color,
      start_time, end_time, is_all_day, timezone, rrule, exdates,
      recurring_event_id, original_start_time, reminders,
      created_at, updated_at, sync_version, is_deleted
    ) VALUES (
      @id, @calendar_id, @external_uid, @title, @description, @location, @color,
      @start_time, @end_time, @is_all_day, @timezone, @rrule, @exdates,
      @recurring_event_id, @original_start_time, @reminders,
      @created_at, @updated_at, @sync_version, @is_deleted
    )
    ON CONFLICT(id) DO UPDATE SET
      calendar_id = excluded.calendar_id,
      external_uid = excluded.external_uid,
      title = excluded.title,
      description = excluded.description,
      location = excluded.location,
      color = excluded.color,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      is_all_day = excluded.is_all_day,
      timezone = excluded.timezone,
      rrule = excluded.rrule,
      exdates = excluded.exdates,
      recurring_event_id = excluded.recurring_event_id,
      original_start_time = excluded.original_start_time,
      reminders = excluded.reminders,
      updated_at = excluded.updated_at,
      sync_version = excluded.sync_version,
      is_deleted = excluded.is_deleted
  `);

  const tx = db.transaction(() => {
    for (const cal of payload.calendars) {
      const existing = getCalStmt.get(cal.id) as { updated_at: number } | undefined;
      if (!existing || cal.updated_at >= existing.updated_at) {
        const ver = nextSyncVersion(db);
        upsertCalStmt.run({
          id: cal.id,
          name: cal.name,
          color: cal.color ?? '#3B82F6',
          is_visible: cal.is_visible ?? 1,
          is_readonly: cal.is_readonly ?? 0,
          source_url: cal.source_url ?? null,
          default_reminders: cal.default_reminders ?? '[]',
          last_fetched_at: cal.last_fetched_at ?? null,
          sort_order: cal.sort_order ?? 0,
          updated_at: cal.updated_at,
          sync_version: ver,
          is_deleted: cal.is_deleted ?? 0,
        });
      }
      appliedCalendarIds.push(cal.id);
    }

    for (const ev of payload.events) {
      const existing = getEventStmt.get(ev.id) as
        | { updated_at: number; exdates: string; rrule: string | null }
        | undefined;

      if (!existing || ev.updated_at >= existing.updated_at) {
        let mergedExdates = ev.exdates ?? '[]';
        if (existing && existing.rrule && ev.rrule) {
          const oldEx = parseJsonNumberArray(existing.exdates, []);
          const newEx = parseJsonNumberArray(ev.exdates, []);
          const union = Array.from(new Set([...oldEx, ...newEx])).sort((a, b) => a - b);
          mergedExdates = JSON.stringify(union);
        }

        const ver = nextSyncVersion(db);
        upsertEventStmt.run({
          id: ev.id,
          calendar_id: ev.calendar_id,
          external_uid: ev.external_uid ?? null,
          title: ev.title,
          description: ev.description ?? '',
          location: ev.location ?? '',
          color: ev.color ?? null,
          start_time: ev.start_time,
          end_time: ev.end_time,
          is_all_day: ev.is_all_day ?? 0,
          timezone: ev.timezone ?? 'Asia/Shanghai',
          rrule: ev.rrule ?? null,
          exdates: mergedExdates,
          recurring_event_id: ev.recurring_event_id ?? null,
          original_start_time: ev.original_start_time ?? null,
          reminders: ev.reminders ?? '[15]',
          created_at: ev.created_at,
          updated_at: ev.updated_at,
          sync_version: ver,
          is_deleted: ev.is_deleted ?? 0,
        });
      }
      appliedEventIds.push(ev.id);
    }
  });

  tx();

  return {
    appliedCalendarIds,
    appliedEventIds,
    serverSyncVersion: getCurrentSyncVersion(db),
  };
}

export function getSyncPull(db: SqliteDb, sinceVersion: number): SyncPullResponse {
  const calendars = db
    .prepare(
      'SELECT * FROM calendars WHERE sync_version > ? ORDER BY sync_version ASC'
    )
    .all(sinceVersion) as CalendarRecord[];

  const events = db
    .prepare(
      'SELECT * FROM events WHERE sync_version > ? ORDER BY sync_version ASC'
    )
    .all(sinceVersion) as EventRecord[];

  return {
    calendars,
    events,
    serverSyncVersion: getCurrentSyncVersion(db),
  };
}

/**
 * Upsert events parsed from an external iCal subscription or Google Calendar .ics import.
 * Matches existing records by (calendar_id, external_uid) so rescheduled matches update cleanly without duplicates.
 */
export function upsertIcsEventsIntoCalendar(params: {
  db: SqliteDb;
  calendarId: string;
  events: EventRecord[];
  isSubscriptionSync?: boolean;
}): { inserted: number; updated: number; serverSyncVersion: number } {
  const { db, calendarId, events, isSubscriptionSync } = params;
  const now = Date.now();
  let inserted = 0;
  let updated = 0;

  const existingByUid = new Map<
    string,
    {
      id: string;
      title: string;
      description: string;
      location: string;
      start_time: number;
      end_time: number;
      is_all_day: number;
      rrule: string | null;
      exdates: string;
      is_deleted: number;
    }
  >();

  const rows = db
    .prepare(
      'SELECT id, external_uid, title, description, location, start_time, end_time, is_all_day, rrule, exdates, is_deleted FROM events WHERE calendar_id = ? AND external_uid IS NOT NULL'
    )
    .all(calendarId) as Array<{
    id: string;
    external_uid: string;
    title: string;
    description: string;
    location: string;
    start_time: number;
    end_time: number;
    is_all_day: number;
    rrule: string | null;
    exdates: string;
    is_deleted: number;
  }>;

  for (const r of rows) {
    existingByUid.set(r.external_uid, r);
  }

  const insertStmt = db.prepare(`
    INSERT INTO events (
      id, calendar_id, external_uid, title, description, location, color,
      start_time, end_time, is_all_day, timezone, rrule, exdates,
      recurring_event_id, original_start_time, reminders,
      created_at, updated_at, sync_version, is_deleted
    ) VALUES (
      @id, @calendar_id, @external_uid, @title, @description, @location, @color,
      @start_time, @end_time, @is_all_day, @timezone, @rrule, @exdates,
      @recurring_event_id, @original_start_time, @reminders,
      @created_at, @updated_at, @sync_version, @is_deleted
    )
  `);

  const updateStmt = db.prepare(`
    UPDATE events SET
      title = @title,
      description = @description,
      location = @location,
      start_time = @start_time,
      end_time = @end_time,
      is_all_day = @is_all_day,
      rrule = @rrule,
      exdates = @exdates,
      recurring_event_id = @recurring_event_id,
      original_start_time = @original_start_time,
      reminders = @reminders,
      updated_at = @updated_at,
      sync_version = @sync_version,
      is_deleted = @is_deleted
    WHERE id = @id
  `);

  const tx = db.transaction(() => {
    for (const ev of events) {
      const uid = ev.external_uid;
      const existing = uid ? existingByUid.get(uid) : undefined;

      if (!existing) {
        const ver = nextSyncVersion(db);
        insertStmt.run({
          ...ev,
          id: ev.id || crypto.randomUUID(),
          calendar_id: calendarId,
          created_at: now,
          updated_at: now,
          sync_version: ver,
        });
        inserted += 1;
      } else {
        const hasChanged =
          existing.title !== ev.title ||
          existing.description !== ev.description ||
          existing.location !== ev.location ||
          existing.start_time !== ev.start_time ||
          existing.end_time !== ev.end_time ||
          existing.is_all_day !== ev.is_all_day ||
          existing.rrule !== ev.rrule ||
          existing.exdates !== ev.exdates ||
          existing.is_deleted !== ev.is_deleted;

        if (hasChanged) {
          const ver = nextSyncVersion(db);
          updateStmt.run({
            id: existing.id,
            title: ev.title,
            description: ev.description,
            location: ev.location,
            start_time: ev.start_time,
            end_time: ev.end_time,
            is_all_day: ev.is_all_day,
            rrule: ev.rrule,
            exdates: ev.exdates,
            recurring_event_id: ev.recurring_event_id,
            original_start_time: ev.original_start_time,
            reminders: ev.reminders,
            updated_at: now,
            sync_version: ver,
            is_deleted: ev.is_deleted,
          });
          updated += 1;
        }
      }
    }

    if (isSubscriptionSync) {
      const calVer = nextSyncVersion(db);
      db.prepare(
        'UPDATE calendars SET last_fetched_at = ?, updated_at = ?, sync_version = ? WHERE id = ?'
      ).run(now, now, calVer, calendarId);
    }
  });

  tx();

  return {
    inserted,
    updated,
    serverSyncVersion: getCurrentSyncVersion(db),
  };
}

/**
 * Zero-downtime SQLite hot backup via VACUUM INTO, retaining the latest `retainDays` snapshots.
 */
export function performHotBackup(
  db: SqliteDb,
  backupDir: string,
  retainDays = 30
): string {
  fs.mkdirSync(backupDir, { recursive: true });
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const fileName = `calendar_backup_${yyyy}${mm}${dd}.db`;
  const targetPath = path.join(backupDir, fileName);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }

  const escapedPath = targetPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedPath}';`);

  // Prune old backups
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('calendar_backup_') && f.endsWith('.db'))
    .sort();

  if (files.length > retainDays) {
    const toRemove = files.slice(0, files.length - retainDays);
    for (const oldFile of toRemove) {
      try {
        fs.unlinkSync(path.join(backupDir, oldFile));
      } catch {
        // ignore unlink errors
      }
    }
  }

  return targetPath;
}
