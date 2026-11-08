import { createLogger } from '../utils/logger.js';
import { retry } from '../utils/misc.js';
import { KEYS } from './structure.js';

const log = createLogger('roles');

/**
 * Role assignment with hard guards:
 *  - the bot can NEVER add/remove IPDC GRID or ADMIN (spec: manually assigned by owner)
 *  - changes are applied, then verified by re-fetch; failures bubble up so callers can queue a retry
 */
export class RoleService {
  constructor({ client, cfg, reconciler, adapter }) {
    this.client = client; this.cfg = cfg; this.reconciler = reconciler; this.adapter = adapter;
    this.protected = new Set([cfg.roles.grid, cfg.roles.admin]);
  }
  get guild() { return this.client.guilds.cache.get(this.cfg.discord.guildId); }

  async idFor(key) {
    let id = await this.reconciler.getObjectId(key);
    if (!id || !(await this.adapter.getRole(id))) { await this.reconciler.run(`ensure:${key}`); id = await this.reconciler.getObjectId(key); }
    if (!id) throw new Error(`Role for ${key} is not available yet.`);
    return id;
  }

  assertAllowed(ids) {
    for (const id of ids) if (this.protected.has(id)) throw new Error('Refusing to modify a protected role (IPDC GRID / ADMIN are assigned manually).');
  }

  async apply(userId, { add = [], remove = [] }, reason = 'IPDC workflow') {
    this.assertAllowed([...add, ...remove]);
    const member = await this.guild.members.fetch(userId);
    const toAdd = add.filter((r) => !member.roles.cache.has(r));
    const toRemove = remove.filter((r) => member.roles.cache.has(r) && !add.includes(r));
    await retry(async () => {
      if (toAdd.length) await member.roles.add(toAdd, reason);
      if (toRemove.length) await member.roles.remove(toRemove, reason);
    }, { attempts: 3, baseMs: 500 });
    const check = await this.guild.members.fetch({ user: userId, force: true });
    const bad = [...add.filter((r) => !check.roles.cache.has(r)), ...remove.filter((r) => check.roles.cache.has(r) && !add.includes(r))];
    if (bad.length) throw new Error(`Role verification failed for ${bad.length} role(s).`);
    log.info(`roles applied for ${userId}: +${toAdd.length} -${toRemove.length}`);
    return { added: toAdd, removed: toRemove };
  }

  async memberRoleKeys({ pmId, teamId }) {
    const out = { ipdc: await this.idFor(KEYS.roleIpdc) };
    if (pmId) out.pm = await this.idFor(KEYS.pmRole(pmId));
    if (teamId) out.team = await this.idFor(KEYS.teamRole(teamId));
    return out;
  }
}
