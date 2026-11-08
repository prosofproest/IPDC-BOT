import { createLogger } from '../utils/logger.js';
import { buildStructure } from './structure.js';
import { slugify } from '../utils/misc.js';

const log = createLogger('managed');
const gone = (e) => e?.code === 10003 || e?.code === 10011 || e?.status === 404;

// Explicit, admin-initiated operations on managed objects (rename / delete / orphan discovery).
// Startup reconciliation never calls any of this.
export class Managed {
  constructor({ client, store, cfg, state }) { this.client = client; this.store = store; this.cfg = cfg; this.state = state; }
  get guild() { return this.client.guilds.cache.get(this.cfg.discord.guildId); }

  async renameManaged(key, newName, { slug = false } = {}) {
    const reg = await this.store.get('registry', key); if (!reg) return false;
    const name = slug ? slugify(newName) : newName;
    try {
      if (reg.type === 'role') { const r = await this.guild.roles.fetch(reg.id); await r?.setName(name, 'IPDC admin rename'); }
      else { const c = await this.guild.channels.fetch(reg.id); await c?.setName(name, 'IPDC admin rename'); }
      await this.store.merge('registry', key, { name });
      return true;
    } catch (e) { if (gone(e)) return false; throw e; }
  }

  async deleteManaged(key, reason) {
    const reg = await this.store.get('registry', key); if (!reg) return false;
    try {
      if (reg.type === 'role') { const r = await this.guild.roles.fetch(reg.id); await r?.delete(reason); }
      else if (reg.type !== 'message') { const c = await this.guild.channels.fetch(reg.id); await c?.delete(reason); }
    } catch (e) { if (!gone(e)) throw e; }
    await this.store.delete('registry', key);
    return true;
  }

  /** Delete every managed object whose key matches the predicate. Channels first, categories and roles last. */
  async deleteWhere(pred, reason) {
    const rows = (await this.store.list('registry')).filter((r) => pred(r.key));
    const order = { message: 0, text: 1, voice: 1, forum: 1, category: 2, role: 3 };
    rows.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
    let n = 0;
    for (const r of rows) { try { if (await this.deleteManaged(r.key, reason)) n++; } catch (e) { log.error(`delete ${r.key} failed`, e); } }
    return n;
  }

  /** Managed objects that exist in the registry but are no longer part of the desired structure. */
  async orphans() {
    const [pms, teams, members, settings] = await Promise.all([this.state.pms(), this.state.teams(), this.state.members(), this.state.settings()]);
    const desired = new Set(buildStructure({ pms, teams, members, settings, cfg: this.cfg }).map((i) => i.key));
    const rows = await this.store.list('registry');
    return rows.filter((r) => r.type !== 'message' && !desired.has(r.key) && /^(pm:|team:|resource:)/.test(r.key));
  }
}
