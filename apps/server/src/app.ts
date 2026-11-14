import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import {
  CalendarRecord,
  CreateSubscriptionRequestSchema,
  EventRecord,
  ImportIcsRequestSchema,
  SyncPushRequestSchema,
  exportEventsToIcs,
  parseIcsContent,
} from '@acta/core';
import {
  SqliteDb,
  applySyncPush,
  getCurrentSyncVersion,
  getSyncPull,
  nextSyncVersion,
  performHotBackup,
  upsertIcsEventsIntoCalendar,
} from './db/index.js';
import {
  fetchAndSyncSubscription,
  normalizeSubscriptionUrl,
} from './jobs/index.js';

export interface BuildServerOptions {
  db: SqliteDb;
  authSecret: string;
  backupDir?: string;
  staticDir?: string;
  icsFetcher?: (url: string) => Promise<string>;
}

export async function buildServer(options: BuildServerOptions): Promise<{
  app: FastifyInstance;
  broadcastSync: (version: number) => void;
}> {
  const { db, authSecret } = options;
  const app = Fastify({
    logger: false,
    bodyLimit: 25 * 1024 * 1024, // 25MB to support large Google Calendar .ics imports
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(websocket);

  const clients = new Set<WebSocket>();

  function broadcastSync(version: number) {
    const message = JSON.stringify({
      type: 'SYNC_REQUIRED',
      version,
      timestamp: Date.now(),
    });
    for (const socket of clients) {
      if (socket.readyState === 1) {
        socket.send(message);
      }
    }
  }

  function extractToken(req: FastifyRequest): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice('Bearer '.length).trim();
    }
    const query = req.query as Record<string, string | undefined>;
    if (query && typeof query.token === 'string') {
      return query.token.trim();
    }
    return null;
  }

  function isTokenValid(token: string | null): boolean {
    if (!authSecret) return true;
    if (!token) return false;
    return token === authSecret;
  }

  async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
    const token = extractToken(req);
    if (!isTokenValid(token)) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '访问密码无效或缺失' });
    }
  }

  // Health check
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      serverSyncVersion: getCurrentSyncVersion(db),
      timestamp: Date.now(),
    };
  });

  // Verify password / token
  app.post('/api/auth/verify', async (req, reply) => {
    const body = (req.body as { token?: string } | undefined) ?? {};
    const token = body.token?.trim() || extractToken(req);
    if (!isTokenValid(token ?? null)) {
      return reply.code(401).send({ authenticated: false, message: '访问密码不正确' });
    }
    return {
      authenticated: true,
      serverSyncVersion: getCurrentSyncVersion(db),
    };
  });

  // WebSocket real-time notification endpoint
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const token = extractToken(req);
    if (!isTokenValid(token)) {
      socket.close(4001, 'Unauthorized');
      return;
    }

    clients.add(socket);
    socket.send(
      JSON.stringify({
        type: 'CONNECTED',
        version: getCurrentSyncVersion(db),
      })
    );

    socket.on('close', () => {
      clients.delete(socket);
    });
  });

  // Incremental Sync Push
  app.post('/api/sync/push', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SyncPushRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_PAYLOAD',
        details: parsed.error.flatten(),
      });
    }

    const res = applySyncPush(db, parsed.data);
    if (res.appliedCalendarIds.length > 0 || res.appliedEventIds.length > 0) {
      broadcastSync(res.serverSyncVersion);
    }
    return res;
  });

  // Incremental Sync Pull
  app.get('/api/sync/pull', { preHandler: requireAuth }, async (req) => {
    const query = req.query as { since?: string };
    const since = Number(query.since ?? 0);
    const safeSince = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
    return getSyncPull(db, safeSince);
  });

  // Import Google Calendar .ics file
  app.post('/api/ics/import', { preHandler: requireAuth }, async (req, reply) => {
    const parsedReq = ImportIcsRequestSchema.safeParse(req.body);
    if (!parsedReq.success) {
      return reply.code(400).send({
        error: 'INVALID_ICS_REQUEST',
        details: parsedReq.error.flatten(),
      });
    }

    const { icsContent, calendarColor } = parsedReq.data;
    let targetCalendarId = parsedReq.data.calendarId;
    let targetCalendarName = parsedReq.data.calendarName || 'Google 导入日历';

    const tempCalId = targetCalendarId || crypto.randomUUID();
    const parsedIcs = parseIcsContent({
      icsContent,
      calendarId: tempCalId,
      defaultReminders: [15],
    });

    if (parsedIcs.calendarName && !parsedReq.data.calendarName) {
      targetCalendarName = parsedIcs.calendarName;
    }

    if (!targetCalendarId) {
      targetCalendarId = tempCalId;
      const now = Date.now();
      const ver = nextSyncVersion(db);
      db.prepare(`
        INSERT INTO calendars (
          id, name, color, is_visible, is_readonly, source_url, default_reminders,
          last_fetched_at, sort_order, updated_at, sync_version, is_deleted
        ) VALUES (?, ?, ?, 1, 0, NULL, '[15]', NULL, 10, ?, ?, 0)
      `).run(targetCalendarId, targetCalendarName, calendarColor || '#10B981', now, ver);
    }

    const res = upsertIcsEventsIntoCalendar({
      db,
      calendarId: targetCalendarId,
      events: parsedIcs.events,
      isSubscriptionSync: false,
    });

    broadcastSync(res.serverSyncVersion);

    return {
      calendarId: targetCalendarId,
      calendarName: targetCalendarName,
      inserted: res.inserted,
      updated: res.updated,
      serverSyncVersion: res.serverSyncVersion,
    };
  });

  // Export .ics file
  app.get('/api/ics/export', { preHandler: requireAuth }, async (req, reply) => {
    const query = req.query as { calendarId?: string };
    let calName = 'Acta 个人日历备份';
    let events: EventRecord[];

    if (query.calendarId) {
      const cal = db
        .prepare('SELECT * FROM calendars WHERE id = ? AND is_deleted = 0')
        .get(query.calendarId) as CalendarRecord | undefined;
      if (cal) {
        calName = cal.name;
      }
      events = db
        .prepare('SELECT * FROM events WHERE calendar_id = ? AND is_deleted = 0')
        .all(query.calendarId) as EventRecord[];
    } else {
      events = db
        .prepare('SELECT * FROM events WHERE is_deleted = 0')
        .all() as EventRecord[];
    }

    const icsText = exportEventsToIcs(calName, events);
    reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="acta-calendar.ics"')
      .send(icsText);
  });

  // Add external iCal subscription (e.g. Real Madrid matches)
  app.post('/api/subscriptions', { preHandler: requireAuth }, async (req, reply) => {
    const parsedReq = CreateSubscriptionRequestSchema.safeParse(req.body);
    if (!parsedReq.success) {
      return reply.code(400).send({
        error: 'INVALID_SUBSCRIPTION_REQUEST',
        details: parsedReq.error.flatten(),
      });
    }

    const { name, url, color, defaultReminders } = parsedReq.data;
    const normalizedUrl = normalizeSubscriptionUrl(url);
    const calendarId = `sub-${crypto.randomUUID()}`;
    const now = Date.now();
    const ver = nextSyncVersion(db);

    db.prepare(`
      INSERT INTO calendars (
        id, name, color, is_visible, is_readonly, source_url, default_reminders,
        last_fetched_at, sort_order, updated_at, sync_version, is_deleted
      ) VALUES (?, ?, ?, 1, 1, ?, ?, NULL, 20, ?, ?, 0)
    `).run(
      calendarId,
      name,
      color,
      normalizedUrl,
      JSON.stringify(defaultReminders),
      now,
      ver
    );

    try {
      const syncRes = await fetchAndSyncSubscription({
        db,
        calendarId,
        broadcastSync,
        fetcher: options.icsFetcher,
      });
      return {
        calendarId,
        name,
        sourceUrl: normalizedUrl,
        inserted: syncRes.inserted,
        updated: syncRes.updated,
        serverSyncVersion: syncRes.serverSyncVersion,
      };
    } catch (err) {
      // Calendar row is still created so user can retry or inspect
      broadcastSync(getCurrentSyncVersion(db));
      return reply.code(502).send({
        error: 'SUBSCRIPTION_FETCH_FAILED',
        calendarId,
        message: err instanceof Error ? err.message : '拉取外部订阅日历失败',
      });
    }
  });

  // Refresh a specific external iCal subscription
  app.post(
    '/api/subscriptions/:id/refresh',
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = req.params as { id: string };
      try {
        const res = await fetchAndSyncSubscription({
          db,
          calendarId: params.id,
          broadcastSync,
          fetcher: options.icsFetcher,
        });
        return res;
      } catch (err) {
        return reply.code(502).send({
          error: 'SUBSCRIPTION_REFRESH_FAILED',
          message: err instanceof Error ? err.message : '刷新订阅日历失败',
        });
      }
    }
  );

  // Trigger manual SQLite hot backup
  app.post('/api/admin/backup', { preHandler: requireAuth }, async () => {
    const backupDir = options.backupDir ?? path.resolve('./data/backups');
    const filePath = performHotBackup(db, backupDir, 30);
    return {
      ok: true,
      backupFile: path.basename(filePath),
      timestamp: Date.now(),
    };
  });

  // Serve Web static assets if built
  if (options.staticDir && fs.existsSync(options.staticDir)) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'NOT_FOUND' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return { app, broadcastSync };
}
