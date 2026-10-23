import pino from 'pino';
import { config } from '../config.js';

/** 結構化日誌；自動遮蔽敏感欄位。絕不記錄檔案內容。 */
export const log = pino({
  level: process.env.LOG_LEVEL || (config.isProd ? 'info' : 'debug'),
  redact: {
    paths: ['password', 'newPassword', 'currentPassword', 'token', 'totp', 'code', 'secret', '*.password', '*.token', 'req.headers.cookie', 'req.headers.authorization'],
    censor: '[REDACTED]',
  },
});

export async function alert(kind: string, detail: Record<string, unknown>) {
  log.warn({ alert: kind, ...detail }, 'security alert');
  if (config.alertWebhook) {
    try {
      await fetch(config.alertWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `[PDF 工具箱] ${kind}`, ...detail }), signal: AbortSignal.timeout(5000) });
    } catch (e) { log.error({ err: String(e) }, 'alert webhook failed'); }
  }
}
