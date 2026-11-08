import { EmbedBuilder } from 'discord.js';
import { createLogger, redact } from '../utils/logger.js';
import { BRAND } from '../config/constants.js';
import { newId, truncate } from '../utils/misc.js';

const log = createLogger('audit');

// Durable audit trail (Firestore) mirrored best-effort to #admin-audit-logs.
export class Audit {
  constructor(store) { this.store = store; this.sink = null; }
  setSink(fn) { this.sink = fn; }

  async log({ action, actorId = null, targetId = null, details = {}, level = 'info' }) {
    const entry = {
      at: Date.now(), action, actorId, targetId, level,
      details: JSON.parse(redact(JSON.stringify(details ?? {}))),
    };
    const id = `${String(entry.at).padStart(14, '0')}_${newId()}`;
    try { await this.store.set('audit', id, entry); } catch (e) { log.error('audit persist failed', e); }
    log.info(`${action}`, { actorId, targetId });
    try { await this.sink?.(entry); } catch (e) { log.warn('audit sink failed', e); }
    return entry;
  }

  async recent(limit = 15, filter = () => true) {
    const all = (await this.store.list('audit')).filter(filter);
    all.sort((a, b) => b.at - a.at);
    return all.slice(0, limit);
  }

  static toEmbed(entry) {
    const e = new EmbedBuilder().setColor(entry.level === 'error' ? 0xcf222e : BRAND.color)
      .setTitle(truncate(entry.action, 250)).setTimestamp(entry.at);
    const lines = [];
    if (entry.actorId) lines.push(`Actor: <@${entry.actorId}>`);
    if (entry.targetId) lines.push(`Target: <@${entry.targetId}>`);
    const d = Object.entries(entry.details || {}).map(([k, v]) => `${k}: ${truncate(typeof v === 'string' ? v : JSON.stringify(v), 300)}`);
    e.setDescription(truncate([...lines, ...d].join('\n') || 'No details.', 3500));
    return e;
  }
}
