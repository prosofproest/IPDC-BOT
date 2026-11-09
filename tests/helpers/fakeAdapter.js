import { OverwriteType } from 'discord.js';
import { slugify } from '../../src/utils/misc.js';

export class FakeAdapter {
  constructor({ gridId = '1568690888413282396', adminId = '1568690393824891141', missingMembers = [] } = {}) {
    this.roles = new Map(); this.channels = new Map(); this.next = 1000;
    this.everyoneId = 'guild1'; this.botId = 'bot1';
    this.calls = { createRole: 0, createChannel: 0, repair: 0 };
    this.missingMembers = new Set(missingMembers);
    if (gridId) this.roles.set(gridId, { id: gridId, name: 'IPDC GRID' });
    if (adminId) this.roles.set(adminId, { id: adminId, name: 'ADMIN' });
  }
  id() { return String(++this.next); }
  async getRole(id) { return this.roles.get(id) || null; }
  async findRole(name) { return [...this.roles.values()].find((r) => r.name.toLowerCase() === name.toLowerCase()) || null; }
  async createRole({ name }) { this.calls.createRole++; const r = { id: this.id(), name }; this.roles.set(r.id, r); return r; }
  async deleteRole(id) { return this.roles.delete(id); }
  async renameRole(id, name) { const r = this.roles.get(id); if (r) { r.name = name; return true; } return false; }
  async getChannel(id) { return this.channels.get(id) || null; }
  async deleteChannel(id) { return this.channels.delete(id); }
  async findChannel({ kind, name, parentId }) {
    const norm = (n) => (kind === 'voice' || kind === 'category' ? n.toLowerCase() : slugify(n));
    return [...this.channels.values()].find((c) => c.kind === kind && (c.parentId ?? null) === (parentId ?? null) && norm(c.name) === norm(name)) || null;
  }
  async createChannel({ kind, name, parentId, overwrites }) {
    this.calls.createChannel++;
    const c = { id: this.id(), kind, name, parentId: parentId ?? null, ow: new Map() };
    for (const o of overwrites) c.ow.set(o.id, { allow: o.allow, deny: o.deny, type: o.type });
    this.channels.set(c.id, c); return c;
  }
  async getOverwrites(chan) { return new Map(chan.ow); }
  async repairOverwrite(chan, o) {
    this.calls.repair++;
    const cur = chan.ow.get(o.id) || { allow: 0n, deny: 0n, type: o.type };
    chan.ow.set(o.id, { type: o.type, allow: (cur.allow | o.allow) & ~o.deny, deny: (cur.deny | o.deny) & ~o.allow });
  }
  async memberExists(id) { return !this.missingMembers.has(id); }
  byName(name) { return [...this.channels.values()].filter((c) => c.name === name); }
}
export { OverwriteType };
