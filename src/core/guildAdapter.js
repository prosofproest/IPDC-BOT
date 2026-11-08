import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { slugify } from '../utils/misc.js';
import { CHANNEL_TYPES } from './structure.js';

// Thin wrapper over discord.js so the reconciler is testable with a fake guild.
const TYPE_TO_KIND = new Map(Object.entries(CHANNEL_TYPES).map(([k, v]) => [v, k]));

const wrapChannel = (c) => c && ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId ?? null, raw: c });
const unknown = (e) => e?.code === 10003 || e?.code === 10011 || e?.code === 10007 || e?.status === 404;

export class GuildAdapter {
  constructor(client, guildId) { this.client = client; this.guildId = guildId; }
  get guild() { return this.client.guilds.cache.get(this.guildId); }
  get everyoneId() { return this.guildId; }
  get botId() { return this.client.user.id; }

  async getRole(id) {
    if (!id) return null;
    try { const r = await this.guild.roles.fetch(id); return r ? { id: r.id, name: r.name } : null; }
    catch (e) { if (unknown(e)) return null; throw e; }
  }
  async findRole(name) {
    const roles = await this.guild.roles.fetch();
    const r = roles.find((x) => x.name.toLowerCase() === name.toLowerCase() && !x.managed && x.id !== this.guildId);
    return r ? { id: r.id, name: r.name } : null;
  }
  async createRole({ name, reason }) {
    const r = await this.guild.roles.create({ name, mentionable: false, permissions: [], reason });
    return { id: r.id, name: r.name };
  }

  async getChannel(id) {
    if (!id) return null;
    try { return wrapChannel(await this.guild.channels.fetch(id)); }
    catch (e) { if (unknown(e)) return null; throw e; }
  }
  async findChannel({ kind, name, parentId }) {
    const all = await this.guild.channels.fetch();
    const want = CHANNEL_TYPES[kind];
    const target = kind === 'voice' || kind === 'category' ? name.toLowerCase() : slugify(name);
    const c = all.find((x) => x && x.type === want && (x.parentId ?? null) === (parentId ?? null)
      && (kind === 'voice' || kind === 'category' ? x.name.toLowerCase() : slugify(x.name)) === target);
    return wrapChannel(c);
  }
  async createChannel({ kind, name, parentId, topic, overwrites, reason }) {
    const opts = {
      name, type: CHANNEL_TYPES[kind], reason,
      permissionOverwrites: overwrites.map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })),
    };
    if (parentId) opts.parent = parentId;
    if (topic && kind !== 'voice' && kind !== 'category') opts.topic = topic;
    return wrapChannel(await this.guild.channels.create(opts));
  }

  async getOverwrites(chan) {
    const m = new Map();
    for (const ow of chan.raw.permissionOverwrites.cache.values()) m.set(ow.id, { allow: ow.allow.bitfield, deny: ow.deny.bitfield, type: ow.type });
    return m;
  }
  // Set only the bits we require; leave every other bit of the existing overwrite untouched.
  async repairOverwrite(chan, o, reason) {
    const flags = {};
    for (const [name, bit] of Object.entries(PermissionFlagsBits)) {
      if (o.allow & bit) flags[name] = true;
      else if (o.deny & bit) flags[name] = false;
    }
    await chan.raw.permissionOverwrites.edit(o.id, flags, { type: o.type, reason });
  }
  async memberExists(id) {
    try { await this.guild.members.fetch(id); return true; } catch (e) { if (unknown(e) || e?.code === 10013) return false; throw e; }
  }
}
export { TYPE_TO_KIND, ChannelType };
