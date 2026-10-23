import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { randomToken } from './crypto.js';

export interface SessionUser {
  id: string; email: string; displayName: string; role: string;
  mustChangePassword: boolean; totpEnabled: boolean; permissions: string[];
  /** 管理角色尚未完成改密碼 / TOTP 時為 true；此時僅能存取 /api/auth/* */
  setupRequired: boolean;
}
declare global { namespace Express { interface Request { user?: SessionUser } } }

export const PRIVILEGED_ROLES = ['super_admin', 'admin', 'viewer'];

export function signAccess(u: { id: string; role: string; token_version: number }) {
  return jwt.sign({ sub: u.id, role: u.role, tv: u.token_version }, config.jwtSecret, { algorithm: 'HS256', expiresIn: config.accessTtlSec });
}

export function setAuthCookies(res: Response, access: string, refresh: string) {
  const base = { secure: config.cookieSecure, sameSite: 'strict' as const };
  res.cookie('access_token', access, { ...base, httpOnly: true, path: '/', maxAge: config.accessTtlSec * 1000 });
  res.cookie('refresh_token', refresh, { ...base, httpOnly: true, path: '/api/auth', maxAge: config.refreshTtlSec * 1000 });
  res.cookie('csrf', randomToken(24), { ...base, httpOnly: false, path: '/', maxAge: config.refreshTtlSec * 1000 });
}
export function clearAuthCookies(res: Response) {
  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/api/auth' });
  res.clearCookie('csrf', { path: '/' });
}

export function loadSession(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const tok = req.cookies?.access_token;
    if (!tok) return next();
    try {
      const p = jwt.verify(tok, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      const { rows } = await db.query(
        `select u.id, u.email, u.display_name, u.role, u.is_active, u.token_version, u.must_change_password, u.totp_enabled,
                coalesce((select array_agg(permission) from role_permissions where role = u.role), '{}') as permissions
           from users u where u.id = $1`, [p.sub]);
      const u = rows[0];
      if (u && u.is_active && u.token_version === p.tv) {
        req.user = {
          id: u.id, email: u.email, displayName: u.display_name, role: u.role,
          mustChangePassword: u.must_change_password, totpEnabled: u.totp_enabled, permissions: u.permissions,
          setupRequired: false,
        };
      }
    } catch { /* 無效或過期：視為未登入，前端會呼叫 refresh */ }
    next();
  };
}

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  next();
};
/** 已登入且已完成強制設定（改密碼 / TOTP） */
export const requireReady = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (req.user.setupRequired) return res.status(403).json({ error: 'setup_required' });
  next();
};
export const requirePerm = (...perms: string[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (req.user.setupRequired) return res.status(403).json({ error: 'setup_required' });
  if (!perms.every((p) => req.user!.permissions.includes(p))) return res.status(403).json({ error: 'forbidden' });
  next();
};
