import type { Request } from 'express';
import type { Db } from '../db.js';

export async function audit(db: Db, req: Request | null, action: string, opts: { actorId?: string | null; actorEmail?: string | null; target?: string; detail?: Record<string, unknown> } = {}) {
  const actor = (req as any)?.user as { id: string; email: string } | undefined;
  await db.query(
    'insert into audit_logs(actor_id, actor_email, action, target, detail, ip) values ($1,$2,$3,$4,$5::jsonb,$6)',
    [opts.actorId ?? actor?.id ?? null, opts.actorEmail ?? actor?.email ?? null, action, opts.target ?? null, JSON.stringify(opts.detail ?? {}), req?.ip ?? null],
  );
}
