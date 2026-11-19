import os from 'node:os';
import { createLogger } from '../utils/logger.js';
import { OverwriteType } from 'discord.js';
import { KEYS, bitsOf, buildStructure } from './structure.js';
import { slugify } from '../utils/misc.js';
import { getValidActiveTeams, isProtectedRole } from './dynamicRoles.js';
import { acquireRenewableLock } from '../utils/lock.js';

const log = createLogger('reconcile');

/**
 * Idempotent startup reconciliation (spec section 11).
 *  - reuse existing objects by persisted ID
 *  - adopt matching unmanaged objects instead of duplicating them
 *  - create ONLY genuinely missing objects, persist IDs immediately
 *  - repair ONLY missing/incorrect permission bits (never reset, never delete)
 */
export class Reconciler {
  constructor({ adapter, store, state, cfg, audit, roles = null, queue = null, managed = null }) {
    this.adapter = adapter; this.store = store; this.state = state; this.cfg = cfg; this.audit = audit;
    this.roles = roles; this.queue = queue; this.managed = managed;
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
  async saveEntry(entry, opts = {}) { await this.store.set('registry', entry.key, entry, opts); }

  // ---- public entry: overlapping calls coalesce into one extra pass ----
  async run(reason = 'manual', { lease = null } = {}) {
    if (lease) {
      return await this._execute(reason, lease);
    }
    if (this.running) { this.rerun = true; return this.running; }
    this.running = (async () => {
      let res;
      do { this.rerun = false; res = await this._locked(reason); } while (this.rerun);
      return res;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async _locked(reason) {
    const lease = await acquireRenewableLock(this.store, 'reconcile', this.owner, { ttlMs: 60_000, renewIntervalMs: 15_000 });
    if (!lease) { log.warn('reconciliation lock held elsewhere; skipping'); return { skipped: true, reason: 'lock-held' }; }
    try {
      await lease.assertAlive();
      return await this._execute(reason, lease);
    } finally {
      await lease.release();
    }
  }

  async _execute(reason, globalLease = null) {
    const t0 = Date.now();
    const summary = { reason, reused: 0, created: 0, adopted: 0, repaired: 0, skipped: 0, errors: [], createdKeys: [], repairedKeys: [] };

    // 0. Recovery sweep for interrupted deletions
    if (this.managed?.deleteWhere) {
      const allStoredPms = (await this.store.list('pms')) || [];
      for (const pm of allStoredPms.filter((p) => p.status === 'deleting')) {
        const pmLease = await acquireRenewableLock(this.store, `pm:${pm.id}`, `reconcile-rec:${this.owner}`, { ttlMs: 15_000, renewIntervalMs: 5_000 });
        if (!pmLease) {
          log.warn(`skipping recovery for PM ${pm.id}; lock currently held`);
          continue;
        }
        try {
          await pmLease.assertAlive();
          await globalLease?.assertAlive();
          const pred = (k) => k.startsWith(`pm:${pm.id}:`) || k.startsWith(`msg:pm:${pm.id}:`);
          await this.managed.deleteWhere(pred, 'Resume PM deletion on reconciliation');
          await pmLease.assertAlive();
          await globalLease?.assertAlive();
          const remaining = (await this.store.list('registry')).filter((r) => pred(r.key));
          if (remaining.length === 0) {
            let allMembersCleaned = true;
            for (const m of (await this.state.members()).filter((x) => x.pmId === pm.id)) {
              await pmLease.assertAlive();
              const memLease = await acquireRenewableLock(this.store, `member:${m.id}`, `reconcile-rec-mem:${this.owner}`, { ttlMs: 10_000, renewIntervalMs: 3_000 });
              if (!memLease) {
                log.warn(`could not acquire lock for member ${m.id} during PM ${pm.id} recovery; skipping`);
                allMembersCleaned = false;
                continue;
              }
              try {
                await memLease.assertAlive();
                await pmLease.assertAlive();
                await globalLease?.assertAlive();
                const activeLocks = [globalLease, pmLease, memLease].filter(Boolean);
                await this.state.saveMember(m.id, { pmId: null, teamId: null, status: 'unassigned' }, { lock: activeLocks });
              } finally {
                await memLease.release();
              }
            }
            await pmLease.assertAlive();
            await globalLease?.assertAlive();
            if (allMembersCleaned) {
              const activeLocks = [globalLease, pmLease].filter(Boolean);
              await this.state.updatePm(pm.id, { status: 'removed', removedAt: Date.now() }, { lock: activeLocks });
            } else {
              log.warn(`PM ${pm.id} cleanup incomplete due to locked members; status remains deleting`);
            }
          }
        } catch (pmRecErr) {
          log.warn(`recovery failed for PM ${pm.id}: ${pmRecErr.message}`);
          summary.errors.push(`pm-recovery:${pm.id}: ${pmRecErr.message}`);
        } finally {
          await pmLease.release();
        }
      }

      const allStoredTeams = (await this.store.list('teams')) || [];
      for (const t of allStoredTeams.filter((tm) => tm.status === 'deleting')) {
        const teamLease = await acquireRenewableLock(this.store, `team:${t.id}`, `reconcile-rec:${this.owner}`, { ttlMs: 15_000, renewIntervalMs: 5_000 });
        if (!teamLease) {
          log.warn(`skipping recovery for team ${t.id}; lock currently held`);
          continue;
        }
        try {
          await teamLease.assertAlive();
          await globalLease?.assertAlive();
          const pred = (k) => k === KEYS.teamRole(t.id) || k === KEYS.resourceForum(t.id) || (k.startsWith('pm:') && k.endsWith(`:team:${t.id}:text`));
          await this.managed.deleteWhere(pred, 'Resume team deletion on reconciliation');
          await teamLease.assertAlive();
          await globalLease?.assertAlive();
          const remaining = (await this.store.list('registry')).filter((r) => pred(r.key));
          if (remaining.length === 0) {
            for (const pm of await this.state.pms()) {
              if ((pm.teamIds || []).includes(t.id)) {
                const activeLocks = [globalLease, teamLease].filter(Boolean);
                await this.state.updatePm(pm.id, { teamIds: pm.teamIds.filter((x) => x !== t.id) }, { lock: activeLocks });
              }
            }
            let allMembersCleaned = true;
            for (const m of (await this.state.members()).filter((x) => x.teamId === t.id)) {
              await teamLease.assertAlive();
              const memLease = await acquireRenewableLock(this.store, `member:${m.id}`, `reconcile-rec-mem:${this.owner}`, { ttlMs: 10_000, renewIntervalMs: 3_000 });
              if (!memLease) {
                log.warn(`could not acquire lock for member ${m.id} during team ${t.id} recovery; skipping`);
                allMembersCleaned = false;
                continue;
              }
              try {
                await memLease.assertAlive();
                await teamLease.assertAlive();
                await globalLease?.assertAlive();
                const activeLocks = [globalLease, teamLease, memLease].filter(Boolean);
                await this.state.saveMember(m.id, { teamId: null }, { lock: activeLocks });
              } finally {
                await memLease.release();
              }
            }
            await teamLease.assertAlive();
            await globalLease?.assertAlive();
            if (allMembersCleaned) {
              const activeLocks = [globalLease, teamLease].filter(Boolean);
              await this.state.updateTeam(t.id, { status: 'removed', removedAt: Date.now() }, { lock: activeLocks });
            } else {
              log.warn(`Team ${t.id} cleanup incomplete due to locked members; status remains deleting`);
            }
          }
        } catch (teamRecErr) {
          log.warn(`recovery failed for team ${t.id}: ${teamRecErr.message}`);
          summary.errors.push(`team-recovery:${t.id}: ${teamRecErr.message}`);
        } finally {
          await teamLease.release();
        }
      }
    }

    const [rawPms, rawTeams, members, settings] = await Promise.all([
      this.state.pms(), this.state.teams(), this.state.members(), this.state.settings(),
    ]);

    // 1. Pre-filter candidate teams: exclude protected names, protected IDs, and bot names
    const protectedGrid = this.cfg?.roles?.grid || '1568690888413282396';
    const protectedAdmin = this.cfg?.roles?.admin || '1568690393824891141';
    const protectedIpdc = this.cfg?.roles?.ipdc;
    const protectedNames = new Set(['ipdc grid', 'admin', 'ipdc']);

    const candidateTeams = rawTeams.filter((t) => {
      if (!t || !t.id || !t.name) return false;
      if (t.status === 'removed' || t.status === 'deleting') return false;
      const norm = t.name.trim().toLowerCase();
      if (protectedNames.has(norm) || norm.startsWith('ipdc bot')) return false;
      if (t.id === protectedGrid || t.id === protectedAdmin || (protectedIpdc && t.id === protectedIpdc) || t.id === '1568690888413282396' || t.id === '1568690393824891141') return false;
      if (t.roleId && (t.roleId === protectedGrid || t.roleId === protectedAdmin || (protectedIpdc && t.roleId === protectedIpdc) || t.roleId === '1568690888413282396' || t.roleId === '1568690393824891141')) return false;
      return true;
    });

    const registry = await this.loadRegistry();
    const idOf = (key) => registry.get(key)?.id;

    // 2. Reconcile static system roles, candidate team roles, and PM roles first
    const roleItems = [
      { key: KEYS.roleGrid, kind: 'role', name: 'IPDC GRID', fixedId: this.cfg.roles.grid },
      { key: KEYS.roleAdmin, kind: 'role', name: 'ADMIN', fixedId: this.cfg.roles.admin },
      { key: KEYS.roleIpdc, kind: 'role', name: 'IPDC', fixedId: this.cfg.roles.ipdc || undefined, adopt: true },
      ...candidateTeams.map((t) => ({ key: KEYS.teamRole(t.id), kind: 'role', name: t.name, fixedId: t.roleId || undefined, adopt: true, meta: { teamId: t.id } })),
      ...rawPms.map((p) => {
        const roleName = p.roleName || (p.name.startsWith('PM - ') ? p.name : `PM - ${p.name}`);
        return { key: KEYS.pmRole(p.id), kind: 'role', name: roleName, altName: p.name, fixedId: p.roleId || undefined, adopt: true, meta: { pmId: p.id } };
      }),
    ];

    for (const item of roleItems) {
      try {
        await this._role(item, registry, summary, { lock: globalLease });
      } catch (e) {
        summary.errors.push(`${item.key}: ${e.message}`);
        log.error(`failed ${item.key}`, e);
      }
    }

    // 3. Post-role validation: verify landed Discord role objects and exclude protected/admin/managed roles
    const validTeams = await getValidActiveTeams({
      state: this.state,
      store: this.store,
      reconciler: this,
      cfg: this.cfg,
      adapter: this.adapter,
      roles: this.roles,
      client: this.roles?.client,
      guild: this.roles?.guild,
    });
    const validTeamIds = validTeams.map((t) => t.id);

    // 4. Backfill valid team IDs and prune obsolete/invalid/protected team IDs from PM records in Firestore
    await this.state.ensureGlobalTeamRoleAssignments(validTeamIds);
    const freshPms = await this.state.pms();

    // 5. Build full structure (channels, categories, forums, PM team text channels) using fresh PM records & validated teams only
    await globalLease?.assertAlive();
    const allItems = buildStructure({ pms: freshPms, teams: validTeams, members, settings, cfg: this.cfg });
    const channelItems = allItems.filter((item) => item.kind !== 'role');

    for (const item of channelItems) {
      try {
        await globalLease?.assertAlive();
        await this._channel(item, registry, idOf, summary, { lock: globalLease });
      } catch (e) {
        summary.errors.push(`${item.key}: ${e.message}`);
        log.error(`failed ${item.key}`, e);
      }
    }

    // 6. PM Discord role synchronization
    if (this.roles?.apply) {
      await globalLease?.assertAlive();
      await this._syncPmRoles(validTeams, validTeamIds, summary);
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

  async _syncPmRoles(validTeams, validTeamIds, summary) {
    const ipdcRoleId = await this.getObjectId(KEYS.roleIpdc);
    let verifiedIpdcRoleId = null;
    if (ipdcRoleId) {
      const ipdcRole = await this.adapter.getRole(ipdcRoleId).catch(() => null);
      if (ipdcRole && !this._isFixed(ipdcRole.id)) {
        verifiedIpdcRoleId = ipdcRoleId;
      }
    }

    const validTeamRoleIds = [];
    for (const t of validTeams) {
      const trId = t.roleId || await this.getObjectId(KEYS.teamRole(t.id)).catch(() => null);
      if (trId) validTeamRoleIds.push(trId);
    }

    const allStoredTeams = (await this.store.list('teams')) || [];
    const removedOrInactiveTeamIds = allStoredTeams
      .filter((t) => t.status === 'removed' || t.status === 'deleting' || !validTeamIds.includes(t.id))
      .map((t) => t.id);

    const obsoleteTeamRoleIds = [];
    for (const deadId of removedOrInactiveTeamIds) {
      const deadTrId = await this.getObjectId(KEYS.teamRole(deadId)).catch(() => null);
      if (deadTrId && !validTeamRoleIds.includes(deadTrId)) {
        obsoleteTeamRoleIds.push(deadTrId);
      }
    }

    const activePms = (await this.state.pms()).filter((p) => p.status !== 'removed' && p.discordUserId && !p.name?.toLowerCase().includes('other pm'));

    const protectedSystemRoles = new Set([
      this.cfg?.roles?.grid,
      this.cfg?.roles?.admin,
      '1568690888413282396',
      '1568690393824891141',
    ].filter(Boolean));

    for (const pm of activePms) {
      try {
        const exists = await this.adapter.memberExists(pm.discordUserId).catch(() => false);
        if (!exists) {
          log.warn(`PM ${pm.name} (${pm.discordUserId}) is not a member of the guild; skipping role sync`);
          continue;
        }

        const pmRoleId = await this.getObjectId(KEYS.pmRole(pm.id)).catch(() => null);
        let verifiedPmRoleId = null;
        if (pmRoleId) {
          const pmRole = await this.adapter.getRole(pmRoleId).catch(() => null);
          if (pmRole && !isProtectedRole(pmRole, this.cfg)) {
            verifiedPmRoleId = pmRoleId;
          }
        }

        const targetRoleIds = [verifiedIpdcRoleId, verifiedPmRoleId, ...validTeamRoleIds].filter(Boolean);

        const guild = this.roles?.guild || (this.roles?.client?.guilds?.cache?.get(this.cfg?.discord?.guildId));
        let member = guild?.members?.cache?.get(pm.discordUserId) || null;
        if (!member && guild?.members?.fetch) {
          member = await guild.members.fetch(pm.discordUserId).catch(() => null);
        }

        let currentRoleIds = new Set();
        if (member?.roles?.cache) {
          currentRoleIds = new Set(member.roles.cache.keys());
        }

        const toAdd = targetRoleIds.filter((r) => !currentRoleIds.has(r));
        const toRemove = obsoleteTeamRoleIds.filter((r) => currentRoleIds.has(r) && !targetRoleIds.includes(r));

        if (member && toAdd.length === 0 && toRemove.length === 0) {
          continue;
        }

        const safeToAdd = (member ? toAdd : targetRoleIds).filter((r) => !protectedSystemRoles.has(r));
        const safeToRemove = (member ? toRemove : obsoleteTeamRoleIds).filter((r) => !protectedSystemRoles.has(r) && !safeToAdd.includes(r));

        if (safeToAdd.length === 0 && safeToRemove.length === 0) {
          continue;
        }

        try {
          await this.roles.apply(
            pm.discordUserId,
            { add: safeToAdd, remove: safeToRemove },
            'IPDC startup reconciliation'
          );
          summary.pmRolesSynced = (summary.pmRolesSynced || 0) + 1;
        } catch (roleErr) {
          log.warn(`role application failed for PM ${pm.name} (${pm.discordUserId}): ${roleErr.message}`);
          summary.errors.push(`roles.apply:${pm.id}: ${roleErr.message}`);
          if (this.queue?.enqueue) {
            try {
              await this.queue.enqueue('roles.apply', {
                userId: pm.discordUserId,
                add: safeToAdd,
                remove: safeToRemove,
              }, {
                dedupeKey: `pm_${pm.id}_sync`,
              });
              log.info(`enqueued role sync retry for PM ${pm.id}`);
            } catch (qErr) {
              log.warn(`failed to enqueue role sync retry: ${qErr.message}`);
            }
          }
        }
      } catch (pmErr) {
        log.warn(`error during role reconciliation for PM ${pm.id}: ${pmErr.message}`);
        summary.errors.push(`pm:${pm.id}: ${pmErr.message}`);
      }
    }
  }

  async getRoleItem(key) {
    if (key === KEYS.roleGrid) return { key, kind: 'role', name: 'IPDC GRID', fixedId: this.cfg.roles?.grid };
    if (key === KEYS.roleAdmin) return { key, kind: 'role', name: 'ADMIN', fixedId: this.cfg.roles?.admin };
    if (key === KEYS.roleIpdc) return { key, kind: 'role', name: 'IPDC', fixedId: this.cfg.roles?.ipdc || undefined, adopt: true };

    if (key.startsWith('team:') && key.endsWith(':role')) {
      const teamId = key.split(':')[1];
      const team = await this.state.getTeam(teamId);
      if (team && team.status !== 'removed') {
        return { key, kind: 'role', name: team.name, fixedId: team.roleId || undefined, adopt: true, meta: { teamId: team.id } };
      }
    }

    if (key.startsWith('pm:') && key.endsWith(':role')) {
      const pmId = key.split(':')[1];
      const pm = await this.state.getPm(pmId);
      if (pm && pm.status !== 'removed') {
        const roleName = pm.roleName || (pm.name.startsWith('PM - ') ? pm.name : `PM - ${pm.name}`);
        return { key, kind: 'role', name: roleName, altName: pm.name, fixedId: pm.roleId || undefined, adopt: true, meta: { pmId: pm.id } };
      }
    }
    return null;
  }

  async ensureRole(key, opts = {}) {
    const item = await this.getRoleItem(key);
    if (!item) return null;
    const registry = await this.loadRegistry();
    const summary = { reused: 0, created: 0, adopted: 0, skipped: 0, errors: [], createdKeys: [] };
    await this._role(item, registry, summary, opts);
    return (await this.getObjectId(key)) || null;
  }

  async _role(item, registry, summary, opts = {}) {
    const reg = registry.get(item.key);
    let role = reg ? await this.adapter.getRole(reg.id) : null;
    if (role) { summary.reused++; return; }

    if (item.fixedId) {
      role = await this.adapter.getRole(item.fixedId);
      if (role) {
        await this._persist(registry, { key: item.key, type: 'role', id: role.id, name: role.name, adopted: true }, opts);
        summary.adopted++;
        return;
      }
      if (item.key === 'role:grid' || item.key === 'role:admin') {
        summary.errors.push(`${item.key}: configured role ${item.fixedId} does not exist in the guild (the bot never creates this role)`);
        summary.skipped++;
        return;
      }
    }

    // Coordinate role creation/adoption with per-role distributed lease
    const roleLockKey = `role-ensure:${item.key}`;
    const roleLockOwner = `ensure:${item.key}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    let roleLease = null;

    // Retry loop to allow concurrent creators to finish
    for (let attempt = 0; attempt < 30; attempt++) {
      roleLease = await acquireRenewableLock(this.store, roleLockKey, roleLockOwner, { ttlMs: 15_000, renewIntervalMs: 5_000 });
      if (roleLease) break;

      // Check if another worker created or adopted the role while we waited
      const fresh = await this.store.get('registry', item.key);
      if (fresh?.id) {
        const freshRole = await this.adapter.getRole(fresh.id);
        if (freshRole) {
          registry.set(item.key, fresh);
          summary.reused++;
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!roleLease) {
      const fresh = await this.store.get('registry', item.key);
      if (fresh?.id) {
        const freshRole = await this.adapter.getRole(fresh.id);
        if (freshRole) {
          registry.set(item.key, fresh);
          summary.reused++;
          return;
        }
      }
      throw new Error(`Could not acquire role coordination lock for ${item.key}; concurrent role reconciliation in progress`);
    }

    try {
      await roleLease.assertAlive();

      // Fresh authoritative recheck from store under role coordination lock
      const fresh = await this.store.get('registry', item.key);
      if (fresh?.id) {
        const freshRole = await this.adapter.getRole(fresh.id);
        if (freshRole) {
          registry.set(item.key, fresh);
          summary.reused++;
          return;
        }
      }

      // Collect all active locks for transactional write validation
      const callerLocks = Array.isArray(opts.lock) ? opts.lock : (opts.lock ? [opts.lock] : []);
      const activeLocks = [roleLease, ...callerLocks].filter(Boolean);
      const writeOpts = activeLocks.length > 0 ? { ...opts, lock: activeLocks } : opts;

      // Adoption of existing unmanaged Discord role
      if (item.adopt) {
        let found = await this.adapter.findRole(item.name);
        if (!found && item.altName) found = await this.adapter.findRole(item.altName);
        if (found && !this._isFixed(found.id)) {
          await this._persist(registry, { key: item.key, type: 'role', id: found.id, name: found.name, adopted: true }, writeOpts);
          if (item.meta?.teamId) await this.state.updateTeam(item.meta.teamId, { roleId: found.id }, writeOpts);
          if (item.meta?.pmId) await this.state.updatePm(item.meta.pmId, { roleId: found.id }, writeOpts);
          summary.adopted++;
          return;
        }
      }

      // Create new role in Discord
      const created = await this.adapter.createRole({ name: item.name, reason: `IPDC structure: ${item.key}` });
      await this._persist(registry, { key: item.key, type: 'role', id: created.id, name: created.name }, writeOpts);
      if (item.meta?.teamId) await this.state.updateTeam(item.meta.teamId, { roleId: created.id }, writeOpts);
      if (item.meta?.pmId) await this.state.updatePm(item.meta.pmId, { roleId: created.id }, writeOpts);
      summary.created++;
      summary.createdKeys.push(item.key);
    } finally {
      await roleLease.release();
    }
  }

  _isFixed(id) { return id === this.cfg.roles.grid || id === this.cfg.roles.admin; }

  async _channel(item, registry, idOf, summary, opts = {}) {
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
        await this._persist(registry, { key: item.key, type: item.kind, id: found.id, name: found.name, parentKey: item.parentKey ?? null, adopted: true }, opts);
        summary.adopted++;
      } else {
        const okOverwrites = [];
        for (const o of resolved) { if (o.type === OverwriteType.Role || await this.adapter.memberExists(o.id)) okOverwrites.push(o); }
        chan = await this.adapter.createChannel({
          kind: item.kind, name: item.kind === 'category' ? item.name : slugOrName(item), parentId,
          topic: item.topic, overwrites: okOverwrites, reason: `IPDC structure: ${item.key}`,
        });
        await this._persist(registry, { key: item.key, type: item.kind, id: chan.id, name: chan.name, parentKey: item.parentKey ?? null }, opts);
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

  async _persist(registry, entry, opts = {}) {
    entry.updatedAt = Date.now();
    registry.set(entry.key, entry);
    await this.saveEntry(entry, opts); // persist immediately, per spec
  }
}

function slugOrName(item) {
  if (item.kind === 'voice') return item.name;
  return slugify(item.name);
}
