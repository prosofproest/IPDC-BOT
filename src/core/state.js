import { DEFAULT_SETTINGS } from '../config/constants.js';
import { newId, slugify } from '../utils/misc.js';

// Typed accessors over the durable store. No names or IDs are hardcoded here:
// PMs, team roles and mappings come from Admin Panel configuration.
export class State {
  constructor(store) {
    this.store = store;
    this._teamLocks = new Map();
  }

  async settings() {
    const s = (await this.store.get('config', 'settings')) || {};
    return { ...structuredClone(DEFAULT_SETTINGS), ...s };
  }
  async saveSettings(patch) { await this.store.merge('config', 'settings', patch); return this.settings(); }

  // ---- PMs ----
  async pms() { return (await this.store.list('pms')).filter((p) => p.status !== 'removed' && p.status !== 'deleting'); }
  async getPm(id) { return this.store.get('pms', id); }
  async pmByUser(userId) { return (await this.pms()).find((p) => p.discordUserId === userId) || null; }
  async createPm({ id, name, discordUserId }, opts = {}) {
    const pms = await this.pms();
    const slug = slugify(name);
    if (pms.some((p) => p.slug === slug)) throw new Error(`A PM named "${name}" already exists.`);
    if (pms.some((p) => p.discordUserId === discordUserId)) throw new Error('That user is already a PM.');
    const teams = await this.teams();
    const allTeamIds = teams.map((t) => t.id);
    const pm = { id: id || newId(), name: name.trim(), slug, discordUserId, teamIds: allTeamIds, repo: null, status: 'active', createdAt: Date.now() };
    await this.store.set('pms', pm.id, pm, opts); return pm;
  }
  async updatePm(id, patch, opts = {}) { await this.store.merge('pms', id, patch, opts); return this.getPm(id); }
  async assignTeamToAllPms(teamId) {
    const pms = await this.pms();
    const updated = [];
    for (const pm of pms) {
      const cur = pm.teamIds || [];
      if (!cur.includes(teamId)) {
        const next = [...cur, teamId];
        await this.store.merge('pms', pm.id, { teamIds: next });
        updated.push({ ...pm, teamIds: next });
      } else {
        updated.push(pm);
      }
    }
    return updated;
  }
  async ensureGlobalTeamRoleAssignments(validTeamIds = null) {
    const [pms, teams] = await Promise.all([this.pms(), this.teams()]);
    const allTeamIds = Array.isArray(validTeamIds) ? validTeamIds : teams.map((t) => t.id);
    const updated = [];
    for (const pm of pms) {
      if (pm.name?.toLowerCase().includes('other pm')) {
        updated.push(pm);
        continue;
      }
      const cur = pm.teamIds || [];
      const missing = allTeamIds.filter((tid) => !cur.includes(tid));
      const obsolete = cur.filter((tid) => !allTeamIds.includes(tid));
      if (missing.length > 0 || obsolete.length > 0) {
        const next = Array.from(new Set([...cur.filter((tid) => allTeamIds.includes(tid)), ...allTeamIds]));
        await this.store.merge('pms', pm.id, { teamIds: next });
        updated.push({ ...pm, teamIds: next });
      } else {
        updated.push(pm);
      }
    }
    return updated;
  }

  // ---- team roles ----
  async teams() { return (await this.store.list('teams')).filter((t) => t.status !== 'removed' && t.status !== 'deleting'); }
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
    const finalSlug = slug || slugify(name);
    const lockKey = roleId ? `role:${roleId}` : `slug:${finalSlug}`;
    if (this._teamLocks.has(lockKey)) {
      return this._teamLocks.get(lockKey);
    }
    const p = (async () => {
      const teams = await this.teams();
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
      await this.assignTeamToAllPms(t.id);
      return t;
    })().finally(() => {
      this._teamLocks.delete(lockKey);
    });
    this._teamLocks.set(lockKey, p);
    return p;
  }
  async updateTeam(id, patch, opts = {}) { await this.store.merge('teams', id, patch, opts); return this.getTeam(id); }

  // ---- members ----
  async members() { return this.store.list('members'); }
  async getMember(userId) { return this.store.get('members', userId); }
  async saveMember(userId, patch, opts = {}) { await this.store.merge('members', userId, patch, opts); return this.getMember(userId); }
  async membersOfPm(pmId) { return (await this.members()).filter((m) => m.pmId === pmId && m.status === 'approved'); }

  // ---- GitHub identity map ----
  async githubOwner(username) { return this.store.get('githubLinks', username.toLowerCase()); }
  async linkGithub(userId, username, { override = false, lock = null } = {}) {
    const key = username.toLowerCase();
    const cur = await this.githubOwner(username);
    if (cur && cur.userId !== userId && !override) throw new Error('That GitHub account is already linked to another member.');
    if (cur && cur.userId !== userId && override) {
      await this.store.merge('members', cur.userId, { github: null }, { lock });
    }
    const m = await this.getMember(userId);
    const oldUser = m?.github?.username;
    if (oldUser && oldUser.toLowerCase() !== key) await this.store.delete('githubLinks', oldUser.toLowerCase());
    await this.store.set('githubLinks', key, { userId, username, linkedAt: Date.now() }, { lock });
    await this.saveMember(userId, { github: { username, linkedAt: Date.now() } }, { lock });
  }
}
