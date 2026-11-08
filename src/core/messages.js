import { createLogger } from '../utils/logger.js';
import { sha } from '../utils/misc.js';

const log = createLogger('messages');
const unknown = (e) => e?.code === 10008 || e?.code === 10003 || e?.status === 404;

// Long-lived messages (panels, heatmap, dashboards): IDs are persisted and the SAME message is
// edited in place. A message is only created when it genuinely does not exist.
export class Messages {
  constructor({ client, store, cfg, reconciler }) { this.client = client; this.store = store; this.cfg = cfg; this.reconciler = reconciler; this.locks = new Map(); }
  get guild() { return this.client.guilds.cache.get(this.cfg.discord.guildId); }

  async channelFor(channelKey) {
    const id = await this.reconciler.getObjectId(channelKey);
    if (!id) return null;
    try { return await this.guild.channels.fetch(id); } catch { return null; }
  }

  static tag(payload, key) {
    const embeds = payload.embeds || [];
    if (!embeds.length) return payload;
    const last = embeds[embeds.length - 1];
    const cur = last.data?.footer?.text || '';
    last.setFooter({ text: `${cur ? `${cur} · ` : ''}ref:${key}`.slice(0, 2048) });
    return payload;
  }

  hashOf(payload) {
    return sha(JSON.stringify({
      e: (payload.embeds || []).map((e) => (e.toJSON ? e.toJSON() : e)),
      c: (payload.components || []).map((c) => (c.toJSON ? c.toJSON() : c)),
      f: (payload.files || []).map((f) => f.name),
      x: payload.hashExtra || '',
    }));
  }

  /** Serialize per key so concurrent callers cannot create two copies. */
  async ensure(key, channelKey, payload, { refresh = true } = {}) {
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._ensure(key, channelKey, payload, refresh));
    this.locks.set(key, run);
    return run;
  }

  async _ensure(key, channelKey, payload, refresh) {
    const channel = await this.channelFor(channelKey);
    if (!channel) { log.warn(`channel ${channelKey} unavailable for message ${key}`); return null; }
    Messages.tag(payload, key);
    const hash = this.hashOf(payload);
    const reg = await this.store.get('registry', `msg:${key}`);
    let msg = null;
    if (reg?.messageId && reg.channelId === channel.id) {
      try { msg = await channel.messages.fetch(reg.messageId); } catch (e) { if (!unknown(e)) throw e; }
    }
    if (!msg) { // search before creating: adopt an existing tagged bot message
      try {
        const recent = await channel.messages.fetch({ limit: 50 });
        msg = recent.find((m) => m.author.id === this.client.user.id && m.embeds.some((e) => e.footer?.text?.includes(`ref:${key}`))) || null;
      } catch (e) { log.warn('adopt search failed', e); }
    }
    if (msg) {
      if (refresh && (!reg || reg.hash !== hash)) {
        await msg.edit({ ...payload, attachments: [] });
      }
      await this.store.set('registry', `msg:${key}`, { key: `msg:${key}`, type: 'message', channelId: channel.id, messageId: msg.id, hash: refresh ? hash : reg?.hash ?? hash, updatedAt: Date.now() });
      return msg;
    }
    msg = await channel.send(payload);
    await this.store.set('registry', `msg:${key}`, { key: `msg:${key}`, type: 'message', channelId: channel.id, messageId: msg.id, hash, updatedAt: Date.now() });
    log.info(`created long-lived message ${key}`);
    return msg;
  }
}
