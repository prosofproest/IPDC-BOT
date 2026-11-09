import os from 'node:os';
import { createLogger } from '../utils/logger.js';
import { OverwriteType } from 'discord.js';
import { bitsOf, buildStructure } from './structure.js';
import { slugify } from '../utils/misc.js';

const log = createLogger('reconcile');

/**
 * Idempotent startup reconciliation (spec section 11).
 *  - reuse existing objects by persisted ID
 *  - adopt matching unmanaged objects instead of duplicating them
 *  - create ONLY genuinely missing objects, persist IDs immediately
 *  - repair ONLY missing/incorrect permission bits (never reset, never delete)
 */
export class Reconciler {
  constructor({ adapter, store, state, cfg, audit }) {
    this.adapter = adapter; this.store = store; this.state = state; this.cfg = cfg; this.audit = audit;
    this.running = null; this.rerun = false; this.owner = `${os.hostname()}:${process.pid}`;
    this.lastResult = null;
  }

  // ---- registry ----
  async loadRegistry() {
    const rows = await this.store.list('registry');
    const reg = new Map();
    for (const r of rows) reg.set(r.key, r);
    return reg;
  }
  async getObjectId(key) { const r = await this.store.get('registry', key); return r?.id ?? null; }
  async saveEntry(entry) { await this.store.set('registry', entry.key, entry); }

  // ---- public entry: overlapping calls coalesce into one extra pass ----
  async run(reason = 'manual') {
    if (this.running) { this.rerun = true; return this.running; }
    this.running = (async () => {
      let res;
      do { this.rerun = false; res = await this._locked(reason); } while (this.rerun);
      return res;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async _locked(reason) {
    const got = await this.store.tryLock('reconcile', this.owner, 5 * 60_000);
    if (!got) { log.warn('reconciliation lock held elsewhere; skipping'); return { skipped: true, reason: 'lock-held' }; }
    try { return await this._execute(reason); } finally { await this.store.unlock('reconcile', this.owner); }
  }

  async _execute(reason) {
    const t0 = Date.now();
    const summary = { reason, reused: 0, created: 0, adopted: 0, repaired: 0, skipped: 0, errors: [], createdKeys: [], repairedKeys: [] };
    const [pms, teams, members, settings] = await Promise.all([
      this.state.pms(), this.state.teams(), this.state.members(), this.state.settings(),
    ]);
    const items = buildStructure({ pms, teams, members, settings, cfg: this.cfg });
    const registry = await this.loadRegistry();
    const idOf = (key) => registry.get(key)?.id;

    for (const item of items) {
      try {
        if (item.kind === 'role') await this._role(item, registry, summary);
        else await this._channel(item, registry, idOf, summary);
      } catch (e) {
        summary.errors.push(`${item.key}: ${e.message}`);
        log.error(`failed ${item.key}`, e);
      }
    }
    summary.ms = Date.now() - t0;
    this.lastResult = { ...summary, at: Date.now() };
    log.info(`reconciliation (${reason}): reused=${summary.reused} adopted=${summary.adopted} created=${summary.created} repaired=${summary.repaired} skipped=${summary.skipped} errors=${summary.errors.length} in ${summary.ms}ms`);
    if (summary.created || summary.repaired || summary.adopted || summary.errors.length) {
      await this.audit?.log({
        action: 'structure.reconcile', level: summary.errors.length ? 'error' : 'info',
        details: { reason, created: summary.created, adopted: summary.adopted, repaired: summary.repaired, errors: summary.errors.slice(0, 10) },
      });
    }
    return summary;
  }

  async _role(item, registry, summary) {
    const reg = registry.get(item.key);
    let role = reg ? await this.adapter.getRole(reg.id) : null;
    if (role) { summary.reused++; return; }

    if (item.fixedId) {
      role = await this.adapter.getRole(item.fixedId);
      if (role) { await this._persist(registry, { key: item.key, type: 'role', id: role.id, name: role.name, adopted: true }); summary.adopted++; return; }
      if (item.key === 'role:grid' || item.key === 'role:admin') {
        summary.errors.push(`${item.key}: configured role ${item.fixedId} does not exist in the guild (the bot never creates this role)`);
        summary.skipped++; return;
      }
    }
    if (item.adopt) {
      let found = await this.adapter.findRole(item.name);
      if (!found && item.altName) found = await this.adapter.findRole(item.altName);
      if (found && !this._isFixed(found.id)) {
        await this._persist(registry, { key: item.key, type: 'role', id: found.id, name: found.name, adopted: true });
        if (item.meta?.teamId) await this.state.updateTeam(item.meta.teamId, { roleId: found.id });
        if (item.meta?.pmId) await this.state.updatePm(item.meta.pmId, { roleId: found.id });
        summary.adopted++; return;
      }
    }
    const created = await this.adapter.createRole({ name: item.name, reason: `IPDC structure: ${item.key}` });
    await this._persist(registry, { key: item.key, type: 'role', id: created.id, name: created.name });
    if (item.meta?.teamId) await this.state.updateTeam(item.meta.teamId, { roleId: created.id });
    if (item.meta?.pmId) await this.state.updatePm(item.meta.pmId, { roleId: created.id });
    summary.created++; summary.createdKeys.push(item.key);
  }

  _isFixed(id) { return id === this.cfg.roles.grid || id === this.cfg.roles.admin; }

  async _channel(item, registry, idOf, summary) {
    let parentId = null;
    if (item.parentKey) {
      parentId = idOf(item.parentKey);
      if (!parentId) { summary.skipped++; summary.errors.push(`${item.key}: parent ${item.parentKey} unavailable`); return; }
    }
    const resolved = this._resolveOverwrites(item.overwrites || [], idOf);
    const reg = registry.get(item.key);
    let chan = reg ? await this.adapter.getChannel(reg.id) : null;
    if (chan) {
      summary.reused++;
    } else {
      const found = await this.adapter.findChannel({ kind: item.kind, name: item.kind === 'category' ? item.name : slugOrName(item), parentId });
      if (found && !this._claimed(registry, found.id, item.key)) {
        chan = found;
        await this._persist(registry, { key: item.key, type: item.kind, id: found.id, name: found.name, parentKey: item.parentKey ?? null, adopted: true });
        summary.adopted++;
      } else {
        const okOverwrites = [];
        for (const o of resolved) { if (o.type === OverwriteType.Role || await this.adapter.memberExists(o.id)) okOverwrites.push(o); }
        chan = await this.adapter.createChannel({
          kind: item.kind, name: item.kind === 'category' ? item.name : slugOrName(item), parentId,
          topic: item.topic, overwrites: okOverwrites, reason: `IPDC structure: ${item.key}`,
        });
        await this._persist(registry, { key: item.key, type: item.kind, id: chan.id, name: chan.name, parentKey: item.parentKey ?? null });
        summary.created++; summary.createdKeys.push(item.key);
        return; // created with correct overwrites
      }
    }
    // repair only missing/incorrect bits
    const existing = await this.adapter.getOverwrites(chan);
    for (const o of resolved) {
      const cur = existing.get(o.id) || { allow: 0n, deny: 0n };
      const ok = (cur.allow & o.allow) === o.allow && (cur.deny & o.deny) === o.deny
        && (cur.allow & o.deny) === 0n && (cur.deny & o.allow) === 0n;
      if (ok) continue;
      if (o.type === OverwriteType.Member && !(await this.adapter.memberExists(o.id))) { summary.skipped++; continue; }
      await this.adapter.repairOverwrite(chan, o, `IPDC reconcile repair: ${item.key}`);
      summary.repaired++; summary.repairedKeys.push(item.key);
    }
  }

  _claimed(registry, id, exceptKey) {
    for (const r of registry.values()) if (r.id === id && r.key !== exceptKey) return true;
    return false;
  }

  _resolveOverwrites(list, idOf) {
    const out = [];
    for (const o of list) {
      let id; let type = OverwriteType.Role;
      if (o.to === 'everyone') id = this.adapter.everyoneId;
      else if (o.to === 'bot') { id = this.adapter.botId; type = OverwriteType.Member; }
      else if (o.to.startsWith('user:')) { id = o.to.slice(5); type = OverwriteType.Member; }
      else id = idOf(o.to);
      if (!id) continue; // unresolved subject (e.g. role missing): skipped, reported via role errors
      out.push({ id, type, allow: bitsOf(o.allow), deny: bitsOf(o.deny) });
    }
    return out;
  }

  async _persist(registry, entry) {
    entry.updatedAt = Date.now();
    registry.set(entry.key, entry);
    await this.saveEntry(entry); // persist immediately, per spec
  }
}

function slugOrName(item) {
  if (item.kind === 'voice') return item.name;
  return slugify(item.name);
}
