import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase } from './db/index.js';
import { buildServer } from './app.js';
import { startBackgroundJobs } from './jobs/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const port = Number(process.env.PORT ?? 3080);
  const host = process.env.HOST ?? '0.0.0.0';
  const dbPath = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data/calendar.db');
  const backupDir =
    process.env.BACKUP_DIR ?? path.resolve(path.dirname(dbPath), 'backups');
  const authSecret = process.env.AUTH_SECRET ?? 'acta-default-secret';
  const staticDir =
    process.env.STATIC_DIR ?? path.resolve(__dirname, '../../web/dist');

  const db = initDatabase(dbPath);
  const { app, broadcastSync } = await buildServer({
    db,
    authSecret,
    backupDir,
    staticDir,
  });

  startBackgroundJobs({
    db,
    backupDir,
    broadcastSync,
  });

  await app.listen({ port, host });
  console.log(`[ActaServer] Listening on http://${host}:${port} (DB: ${dbPath})`);
}

main().catch((err) => {
  console.error('[ActaServer] Fatal startup error:', err);
  process.exit(1);
});
