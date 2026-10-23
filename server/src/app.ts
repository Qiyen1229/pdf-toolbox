import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { config } from './config.js';
import { log } from './lib/logger.js';
import { loadSession, requireReady } from './lib/session.js';
import { csrf, adminIpGuard, apiLimiter } from './security.js';
import { authRouter } from './routes/auth.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';

export function createApp(db: Db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === 'false' ? false : /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  if (config.forceHttps) {
    app.use((req, res, next) => (req.secure ? next() : res.redirect(308, `https://${req.get('host')}${req.originalUrl}`)));
  }
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'blob:', 'data:'],
        workerSrc: ["'self'", 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.forceHttps ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: config.forceHttps ? { maxAge: 31536000, includeSubDomains: true } : false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  }));
  app.use((_req, res, next) => { res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); next(); });

  app.use((req, res, next) => { // 結構化存取日誌：不含 query string、不含 body
    const t = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path.startsWith('/api')) log.info({ m: req.method, p: req.path, s: res.statusCode, ms: Number(process.hrtime.bigint() - t) / 1e6 | 0, u: req.user?.id }, 'req');
    });
    next();
  });

  app.use(cookieParser());

  const api = express.Router();
  api.use(apiLimiter);
  api.use(express.json({ limit: '100kb' }));
  api.use(loadSession(db));
  api.use(csrf);
  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.use('/auth', authRouter(db));
  api.use('/', publicRouter(db));
  api.use('/admin', adminIpGuard, requireReady, (req, res, next) =>
    req.user!.permissions.includes('admin.access') ? next() : res.status(403).json({ error: 'forbidden' }), adminRouter(db));
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  api.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error({ err: String(err?.message ?? err) }, 'unhandled');
    res.status(err?.status && err.status < 500 ? err.status : 500).json({ error: err?.status && err.status < 500 ? 'bad_request' : 'internal_error' });
  });
  app.use('/api', api);

  // SPA 靜態檔案
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist, {
      index: false,
      setHeaders(res, file) {
        if (/sw\.js$|index\.html$|manifest\.webmanifest$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
        else if (/\/assets\//.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }
  return app;
}
