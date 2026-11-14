import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, SqliteDb } from '../db/index.js';
import { buildServer } from '../app.js';

describe('@acta/server API & sync integration tests', () => {
  let db: SqliteDb;
  let tmpDir: string;
  const SECRET = 'my-super-secret-password';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acta-test-'));
    db = initDatabase(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enforces single-user Bearer authentication and seeds default calendars', async () => {
    const { app } = await buildServer({ db, authSecret: SECRET, backupDir: tmpDir });

    const unauthRes = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since=0',
    });
    expect(unauthRes.statusCode).toBe(401);

    const authRes = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since=0',
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(authRes.statusCode).toBe(200);
    const body = authRes.json();
    expect(body.calendars.length).toBeGreaterThanOrEqual(3);
    expect(body.serverSyncVersion).toBeGreaterThanOrEqual(3);
  });

  it('handles incremental push/pull and merges concurrent offline exdates on master recurring events', async () => {
    const { app } = await buildServer({ db, authSecret: SECRET });
    const headers = { Authorization: `Bearer ${SECRET}` };

    const masterEvent = {
      id: 'ev-recurring-1',
      calendar_id: 'cal-personal',
      external_uid: null,
      title: '每周健身',
      description: '',
      location: '',
      color: null,
      start_time: 1762650000000,
      end_time: 1762653600000,
      is_all_day: 0,
      timezone: 'Asia/Shanghai',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      exdates: JSON.stringify([1762822800000]),
      recurring_event_id: null,
      original_start_time: null,
      reminders: '[15]',
      created_at: 1000,
      updated_at: 2000,
      sync_version: 0,
      is_deleted: 0,
    };

    const push1 = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers,
      payload: {
        calendars: [],
        events: [masterEvent],
      },
    });
    expect(push1.statusCode).toBe(200);
    const vAfterPush1 = push1.json().serverSyncVersion;

    // Second device pushes another exdate on the same master event
    const push2 = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers,
      payload: {
        calendars: [],
        events: [
          {
            ...masterEvent,
            exdates: JSON.stringify([1762995600000]),
            updated_at: 3000,
          },
        ],
      },
    });
    expect(push2.statusCode).toBe(200);

    const pullRes = await app.inject({
      method: 'GET',
      url: `/api/sync/pull?since=${vAfterPush1}`,
      headers,
    });
    const pulled = pullRes.json();
    expect(pulled.events).toHaveLength(1);
    expect(JSON.parse(pulled.events[0].exdates)).toEqual([
      1762822800000,
      1762995600000,
    ]);
  });

  it('subscribes to external webcal:// Real Madrid feed and updates match kickoff time on refresh', async () => {
    let kickoffUtc = '20261122T200000Z';
    const mockFetcher = async (_url: string) =>
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'X-WR-CALNAME:Real Madrid CF',
        'BEGIN:VEVENT',
        'UID:laliga-rm-2026-11-22@realmadrid.com',
        'SUMMARY:Real Madrid vs Sevilla',
        'LOCATION:Bernabeu',
        `DTSTART:${kickoffUtc}`,
        'DURATION:PT2H',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');

    const { app } = await buildServer({
      db,
      authSecret: SECRET,
      icsFetcher: mockFetcher,
      backupDir: path.join(tmpDir, 'backups'),
    });
    const headers = { Authorization: `Bearer ${SECRET}` };

    const subRes = await app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers,
      payload: {
        name: '皇马赛程',
        url: 'webcal://www.realmadrid.com/calendars/matches.ics',
        color: '#2563EB',
        defaultReminders: [30],
      },
    });
    expect(subRes.statusCode).toBe(200);
    const subData = subRes.json();
    expect(subData.inserted).toBe(1);
    expect(subData.sourceUrl).toBe('https://www.realmadrid.com/calendars/matches.ics');

    // Now LaLiga reschedules the kickoff time by +1 hour
    kickoffUtc = '20261122T210000Z';
    const refreshRes = await app.inject({
      method: 'POST',
      url: `/api/subscriptions/${subData.calendarId}/refresh`,
      headers,
    });
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.json().updated).toBe(1);
    expect(refreshRes.json().inserted).toBe(0);

    // Also test zero-downtime hot backup
    const backupRes = await app.inject({
      method: 'POST',
      url: '/api/admin/backup',
      headers,
    });
    expect(backupRes.statusCode).toBe(200);
    expect(backupRes.json().ok).toBe(true);
  });
});
