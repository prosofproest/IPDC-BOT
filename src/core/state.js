import { DEFAULT_SETTINGS } from '../config/constants.js';
import { newId, slugify } from '../utils/misc.js';

// Typed accessors over the durable store. No names or IDs are hardcoded here:
// PMs, team roles and mappings come from Admin Panel configuration.
export class State {
  constructor(store) { this.store = store; }

  async settings() {
    const s = (await this.store.get('config', 'settings')) || {};
    return { ...structuredClone(DEFAULT_SETTINGS), ...s };
  }
  async saveSettings(patch) { await this.store.merge('config', 'settings', patch); return this.settings(); }

  // ---- PMs ----
  async pms() { return (await this.store.list('pms')).filter((p) => p.status !== 'removed'); }
  async getPm(id) { return this.store.get('pms', id); }
  async pmByUser(userId) { return (await this.pms()).find((p) => p.discordUserId === userId) || null; }
  async createPm({ name, discordUserId }) {
    const pms = await this.pms();
    const slug = slugify(name);
    if (pms.some((p) => p.slug === slug)) throw new Error(`A PM named "${name}" already exists.`);
    if (pms.some((p) => p.discordUserId === discordUserId)) throw new Error('That user is already a PM.');
    const pm = { id: newId(), name: name.trim(), slug, discordUserId, teamIds: [], repo: null, status: 'active', createdAt: Date.now() };
    await this.store.set('pms', pm.id, pm); return pm;
  }
  async updatePm(id, patch) { await this.store.merge('pms', id, patch); return this.getPm(id); }

  // ---- team roles ----
  async teams() { return (await this.store.list('teams')).filter((t) => t.status !== 'removed'); }
  async getTeam(id) { return this.store.get('teams', id); }
  async teamByRole(roleId) {
    if (!roleId) return null;
    return (await this.teams()).find((t) => t.roleId === roleId) || null;
  }
  async teamBySlug(slug) {
    if (!slug) return null;
    return (await this.teams()).find((t) => t.slug === slug) || null;
  }
  async teamByName(name) {
    if (!name) return null;
    const n = name.trim().toLowerCase();
    const s = slugify(name);
    return (await this.teams()).find((t) => t.name.toLowerCase() === n || t.slug === s) || null;
  }
  async createTeam({ name, roleId = null, slug = null }) {
    const teams = await this.teams();
    const finalSlug = slug || slugify(name);
    const existing = teams.find((t) => t.slug === finalSlug || (roleId && t.roleId === roleId));
    if (existing) {
      if (roleId && !existing.roleId) {
        await this.store.merge('teams', existing.id, { roleId });
        return this.getTeam(existing.id);
      }
      if (roleId && existing.roleId === roleId) {
        return existing;
      }
      throw new Error(`A team role named "${name}" already exists.`);
    }
    const t = { id: newId(), name: name.trim(), slug: finalSlug, roleId: roleId || null, status: 'active', createdAt: Date.now() };
    await this.store.set('teams', t.id, t);
    return t;
  }
  async updateTeam(id, patch) { await this.store.merge('teams', id, patch); return this.getTeam(id); }

  // ---- members ----
  async members() { return this.store.list('members'); }
  async getMember(userId) { return this.store.get('members', userId); }
  async saveMember(userId, patch) { await this.store.merge('members', userId, patch); return this.getMember(userId); }
  async membersOfPm(pmId) { return (await this.members()).filter((m) => m.pmId === pmId && m.status === 'approved'); }

  // ---- GitHub identity map ----
  async githubOwner(username) { return this.store.get('githubLinks', username.toLowerCase()); }
  async linkGithub(userId, username, { override = false } = {}) {
    const key = username.toLowerCase();
    const cur = await this.githubOwner(username);
    if (cur && cur.userId !== userId && !override) throw new Error('That GitHub account is already linked to another member.');
    if (cur && cur.userId !== userId && override) {
      await this.store.merge('members', cur.userId, { github: null });
    }
    const m = await this.getMember(userId);
    const oldUser = m?.github?.username;
    if (oldUser && oldUser.toLowerCase() !== key) await this.store.delete('githubLinks', oldUser.toLowerCase());
    await this.store.set('githubLinks', key, { userId, username, linkedAt: Date.now() });
    await this.saveMember(userId, { github: { username, linkedAt: Date.now() } });
  }
}
