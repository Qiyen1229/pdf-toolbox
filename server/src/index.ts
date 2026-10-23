import { config } from './config.js';
import { openDb, migrate, seedAdmin } from './db.js';
import { createApp } from './app.js';
import { log } from './lib/logger.js';

const db = await openDb();
await migrate(db);
await seedAdmin(db);
const app = createApp(db);
const server = app.listen(config.port, '0.0.0.0', () => {
  log.info({ port: config.port, db: db.kind, env: config.env }, `PDF 工具箱 listening on http://localhost:${config.port}`);
});
// 定期清理過期的 token / 用量資料保留 400 天
setInterval(() => {
  db.query(`delete from refresh_tokens where expires_at < now() - interval '1 day'`).catch(() => {});
  db.query(`delete from email_tokens where expires_at < now() - interval '1 day'`).catch(() => {});
  db.query(`delete from usage_events where at < now() - interval '400 days'`).catch(() => {});
}, 3600_000).unref();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => { void db.close().finally(() => process.exit(0)); }));
}
