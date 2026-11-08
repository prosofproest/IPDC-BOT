import nodemailer from 'nodemailer';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mailer');

export class Mailer {
  constructor(cfg, health) {
    this.cfg = cfg; this.health = health; this.enabled = cfg.enabled;
    this.transport = cfg.enabled ? nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass } }) : null;
  }
  async send({ to, subject, text, attachments }) {
    if (!this.enabled) throw new Error('SMTP is not configured');
    if (!to?.length) throw new Error('No report recipients configured');
    try {
      await this.transport.sendMail({ from: this.cfg.from, to: to.join(', '), subject, text, attachments });
      this.health?.record('smtp', true); return true;
    } catch (e) { this.health?.record('smtp', false, e.code || e.message); log.error('send failed', e); throw e; }
  }
}
