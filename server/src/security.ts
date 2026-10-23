import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { config } from './config.js';
import { ipAllowed } from './lib/ip.js';
import { alert } from './lib/logger.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 雙重提交 Cookie：非 GET 的 API 請求，X-CSRF-Token 必須等於 csrf cookie。（另有 SameSite=Strict） */
export function csrf(req: Request, res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();
  const c = req.cookies?.csrf, h = req.get('x-csrf-token');
  // 無 cookie（尚未登入的首次請求，如 login）：改以 Origin 檢查
  if (!c) {
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'csrf' });
    return next();
  }
  if (!h || h.length !== c.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(c))) return res.status(403).json({ error: 'csrf' });
  next();
}

export function adminIpGuard(req: Request, res: Response, next: NextFunction) {
  if (!ipAllowed(req.ip, config.adminIpAllowlist)) {
    void alert('admin_ip_blocked', { ip: req.ip, path: req.path });
    return res.status(403).json({ error: 'ip_not_allowed' });
  }
  next();
}

const limiter = (windowMs: number, limit: number, name: string) =>
  rateLimit({
    windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res) => { void alert('rate_limited', { name, ip: req.ip, path: req.path }); res.status(429).json({ error: 'too_many_requests' }); },
  });

export const apiLimiter = limiter(60_000, 300, 'api');
export const authLimiter = limiter(15 * 60_000, 30, 'auth');
export const usageLimiter = limiter(60_000, 120, 'usage');
