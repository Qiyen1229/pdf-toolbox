import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { log } from './logger.js';

const transport = config.smtp.host
  ? nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined })
  : null;

export const mailEnabled = !!transport;

export async function sendMail(to: string, subject: string, text: string) {
  if (!transport) {
    // 未設定 SMTP：僅開發環境把內容印到 console（方便本機測試重設連結）；生產環境不輸出
    if (!config.isProd) console.log(`\n[mail:dev] to=${to}\nsubject=${subject}\n${text}\n`);
    else log.warn({ to }, 'SMTP not configured; mail not sent');
    return;
  }
  await transport.sendMail({ from: config.smtp.from, to, subject, text });
}
