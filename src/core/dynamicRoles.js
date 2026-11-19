import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { slugify } from '../utils/misc.js';
import { KEYS } from './structure.js';
import { provisionPmWorkspace } from './workspace.js';

const log = createLogger('dynamic-roles');

// Map for serializing concurrent operations on the same role ID
const _roleLocks = new Map();

async function withRoleLock(key, fn) {
  while (_roleLocks.has(key)) {
    try {
      await _roleLocks.get(key);
    } catch {}
  }
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  _roleLocks.set(key, p);
  try {
    return await fn();
  } finally {
    _roleLocks.delete(key);
    resolve();
  }
}

/**
 * Identify protected system roles that must never be modified or provisioned as team roles.
 */
export function isProtectedRole(role, cfg = {}) {
  if (!role) return true;
  const id = role.id;
  const name = (role.name || '').trim().toLowerCase();

  // Guild ID is @everyone
  if (id === role.guild?.id || name === '@everyone') return true;

  // Bot managed integration roles
  if (role.managed) return true;

  // Administrator permissions
  if (role.permissions?.has?.(PermissionFlagsBits.Administrator) ||
      role.permissions?.has?.(1n << 3n) ||
      role.permissions?.has?.('Administrator') ||
      (typeof role.permissions === 'bigint' && (role.permissions & (1n << 3n)) !== 0n) ||
      (typeof role.permissions === 'number' && (role.permissions & 8) !== 0)) {
    return true;
  }

  // Configured system roles
  const gridId = cfg.roles?.grid || '1568690888413282396';
  const adminId = cfg.roles?.admin || '1568690393824891141';
  const ipdcId = cfg.roles?.ipdc;

  if (id === gridId || id === adminId || (ipdcId && id === ipdcId)) return true;
  if (name === 'ipdc grid' || name === 'admin' || name === 'ipdc') return true;

  // Bot's own user name
  if (name === 'ipdc' || name.startsWith('ipdc bot')) return true;

  return false;
}

/**
 * Retrieve all valid, active team records whose Discord roles are verified,
 * non-protected, non-administrator, and non-managed.
 *
 * Missing roles, fetch failures, protected IDs, and invalid records are safely excluded.
 */
export async function getValidActiveTeams(ctx) {
  const { state, store, reconciler, cfg, client, adapter, roles } = ctx || {};
  let teams = [];
  if (state?.teams) {
    teams = await state.teams();
  } else if (store?.list) {
    teams = await store.list('teams');
  }

  const validTeams = [];
  const seenIds = new Set();

  const protectedGrid = cfg?.roles?.grid || '1568690888413282396';
  const protectedAdmin = cfg?.roles?.admin || '1568690393824891141';
  const protectedIpdc = cfg?.roles?.ipdc;
  const protectedNames = new Set(['ipdc grid', 'admin', 'ipdc']);

  // Resolve guild if available
  let guild = ctx?.guild || null;
  if (!guild && client?.guilds) {
    const guildId = cfg?.discord?.guildId;
    if (guildId) {
      guild = client.guilds.cache?.get?.(guildId) || null;
      if (!guild && client.guilds.fetch) {
        guild = await client.guilds.fetch(guildId).catch(() => null);
      }
    } else {
      guild = client.guilds.cache?.first?.() || null;
    }
  }

  for (const team of teams) {
    if (!team || typeof team !== 'object') continue;
    if (team.status === 'removed') continue;
    if (!team.id || !team.name) {
      log.warn(`excluding team without id or name: ${JSON.stringify(team)}`);
      continue;
    }

    if (seenIds.has(team.id)) continue;

    const normName = team.name.trim().toLowerCase();
    if (protectedNames.has(normName) || normName.startsWith('ipdc bot')) {
      log.warn(`excluding team with protected name: "${team.name}" (${team.id})`);
      continue;
    }

    // Independently reject protected team IDs
    if (team.id === protectedGrid || team.id === protectedAdmin || (protectedIpdc && team.id === protectedIpdc) || team.id === '1568690888413282396' || team.id === '1568690393824891141') {
      log.warn(`excluding team with protected id: "${team.name}" (${team.id})`);
      continue;
    }

    // Resolve Discord role ID from team or reconciler/registry/roles
    let roleId = team.roleId;
    if (!roleId && reconciler?.getObjectId) {
      roleId = await reconciler.getObjectId(KEYS.teamRole(team.id)).catch(() => null);
    }
    if (!roleId && roles?.idFor) {
      roleId = await roles.idFor(KEYS.teamRole(team.id)).catch(() => null);
    }
    if (!roleId && store?.get) {
      const reg = await store.get('registry', KEYS.teamRole(team.id)).catch(() => null);
      roleId = reg?.id;
    }

    if (!roleId) {
      log.warn(`excluding team "${team.name}" (${team.id}): no associated Discord role ID resolved`);
      continue;
    }

    // Independently reject protected role IDs
    if (roleId === protectedGrid || roleId === protectedAdmin || (protectedIpdc && roleId === protectedIpdc) || roleId === '1568690888413282396' || roleId === '1568690393824891141') {
      log.warn(`excluding team "${team.name}" (${team.id}): roleId ${roleId} is a protected system role ID`);
      continue;
    }

    // Resolve actual Discord role object from guild, adapter, or roles service
    let discordRole = null;
    if (guild?.roles?.fetch) {
      try {
        discordRole = await guild.roles.fetch(roleId).catch(() => null);
      } catch (e) {
        log.warn(`failed to fetch Discord role ${roleId} for team "${team.name}": ${e.message}`);
      }
    } else if (guild?.roles?.cache?.get) {
      discordRole = guild.roles.cache.get(roleId) || null;
    }

    if (!discordRole && adapter?.getRole) {
      try {
        discordRole = await adapter.getRole(roleId);
      } catch (e) {
        log.warn(`failed to get role from adapter for team "${team.name}": ${e.message}`);
      }
    }

    if (!discordRole && reconciler?.adapter?.getRole) {
      try {
        discordRole = await reconciler.adapter.getRole(roleId);
      } catch (e) {
        log.warn(`failed to get role from reconciler adapter for team "${team.name}": ${e.message}`);
      }
    }

    if (!discordRole && roles?.get) {
      try {
        discordRole = await roles.get(roleId);
      } catch (e) {
        log.warn(`failed to get role from roles service for team "${team.name}": ${e.message}`);
      }
    }

    // Missing or unverified role must be safely excluded (never classify unverified role as valid)
    if (!discordRole) {
      log.warn(`excluding team "${team.name}" (${team.id}): Discord role ${roleId} could not be resolved or verified`);
      continue;
    }

    // Pass actual role object to isProtectedRole
    if (isProtectedRole(discordRole, cfg)) {
      log.warn(`excluding team "${team.name}" (${team.id}): role ${roleId} is protected, managed, or has Administrator privileges`);
      continue;
    }

    seenIds.add(team.id);
    validTeams.push(team);
  }

  return validTeams;
}

/**
 * Detect newly created Discord roles and automatically provision:
 * - Registration in Firestore as team role
 * - Global assignment: Discord role assigned to every existing active PM
 * - Firestore PM teamIds updated for every existing active PM
 * - Resource forum under IPDC RESOURCES with correct overwrites
 * - PM workspace integration and channel provisioning
 */
export async function handleRoleCreate(ctx, role) {
  const { cfg, state, store, reconciler, managed, audit, client, queue, roles } = ctx;
  if (isProtectedRole(role, cfg)) {
    log.debug(`ignoring protected or managed role creation: ${role.name} (${role.id})`);
    return { ignored: true, reason: 'protected' };
  }

  return withRoleLock(role.id, async () => {
    log.info(`new Discord role detected: "${role.name}" (${role.id})`);

    // 1. Check if this is a personal PM role
    const pmPrefixMatch = role.name.match(/^PM\s*[:-]\s*(.+)$/i);
    if (pmPrefixMatch) {
      const pmName = pmPrefixMatch[1].trim();
      let pm = (await state.pms()).find((p) => p.name.toLowerCase() === pmName.toLowerCase() || p.roleId === role.id);
      if (!pm) {
        pm = await state.createPm({ name: pmName, discordUserId: null });
        await state.updatePm(pm.id, { roleId: role.id });
      } else if (!pm.roleId) {
        await state.updatePm(pm.id, { roleId: role.id });
      }
      await store.set('registry', KEYS.pmRole(pm.id), {
        key: KEYS.pmRole(pm.id),
        type: 'role',
        id: role.id,
        name: role.name,
        updatedAt: Date.now(),
      });
      await provisionPmWorkspace(ctx, pm.id, { welcome: false });
      if (audit) {
        await audit.log({ action: 'pm.role_created', targetId: role.id, details: { pmId: pm.id, name: pm.name } });
      }
      return { handled: true, type: 'pm', pm };
    }

    // 2. It is a Team Role (e.g. "AI/ML", "Mobile App", "DevOps")
    const slug = slugify(role.name);
    let team = await state.teamByRole(role.id) || await state.teamBySlug(slug) || await state.teamByName(role.name);

    if (!team) {
      team = await state.createTeam({ name: role.name, roleId: role.id, slug });
      log.info(`registered new team role in Firestore: ${team.name} (${team.id})`);
    } else if (!team.roleId || team.roleId !== role.id) {
      team = await state.updateTeam(team.id, { roleId: role.id, name: role.name });
    }

    // Ensure all active PM records in Firestore have this team assigned (idempotent)
    await state.assignTeamToAllPms(team.id);

    // Persist role in reconciler registry
    const regKey = KEYS.teamRole(team.id);
    await store.set('registry', regKey, {
      key: regKey,
      type: 'role',
      id: role.id,
      name: role.name,
      updatedAt: Date.now(),
    });

    // Reconcile structure so resource forum under IPDC RESOURCES is created with correct overwrites
    await reconciler.run(`dynamic-team-role:${team.id}`);
    const forumId = await reconciler.getObjectId(KEYS.resourceForum(team.id));

    // 3. Global Assignment: Assign Discord role to every existing active PM and provision workspace
    const pms = await state.pms();
    const activePms = pms.filter((p) => p.status !== 'removed' && p.discordUserId);
    const roleService = roles || ctx.roles;

    for (const p of activePms) {
      // Assign Discord role to PM
      if (roleService?.apply) {
        try {
          await roleService.apply(p.discordUserId, { add: [role.id], remove: [] }, `IPDC global team assignment: ${team.name}`);
        } catch (err) {
          log.warn(`failed to apply role ${role.id} to PM ${p.name} (${p.discordUserId}): ${err.message}`);
          if (queue?.enqueue) {
            await queue.enqueue(
              'roles.apply',
              { userId: p.discordUserId, add: [role.id], remove: [] },
              { dedupeKey: `pm_${p.id}_team_${team.id}` }
            );
          }
          if (audit) {
            await audit.log({
              action: 'roles.apply.queued',
              level: 'warn',
              targetId: p.discordUserId,
              details: { teamId: team.id, roleId: role.id, error: err.message },
            });
          }
        }
      }

      // Provision workspace channel for this PM
      try {
        await provisionPmWorkspace(ctx, p.id, { welcome: false });
      } catch (err) {
        log.warn(`workspace provisioning deferred for PM ${p.name}: ${err.message}`);
      }
    }

    if (audit) {
      await audit.log({
        action: 'team.role_created',
        targetId: role.id,
        details: { teamId: team.id, roleName: role.name, slug: team.slug },
      });
    }

    return { handled: true, type: 'team', team, forumId };
  });
}

/**
 * Handle role renaming:
 * Synchronize team/PM names, slugs, forum names, and channels without recreating objects.
 */
export async function handleRoleUpdate(ctx, oldRole, newRole) {
  const { cfg, state, managed, audit } = ctx;
  if (isProtectedRole(newRole, cfg)) return { ignored: true, reason: 'protected' };
  if (oldRole.name === newRole.name) return { ignored: true, reason: 'name_unchanged' };

  return withRoleLock(newRole.id, async () => {
    log.info(`Discord role renamed: "${oldRole.name}" -> "${newRole.name}" (${newRole.id})`);

    // 1. Check if associated with a Team
    const team = await state.teamByRole(newRole.id) || await state.teamByName(oldRole.name);
    if (team) {
      const newSlug = slugify(newRole.name);
      await state.updateTeam(team.id, { name: newRole.name, slug: newSlug });

      // Update managed names safely
      if (managed) {
        await managed.renameManaged(KEYS.teamRole(team.id), newRole.name);
        await managed.renameManaged(KEYS.resourceForum(team.id), newSlug, { slug: true });
        for (const p of await state.pms()) {
          await managed.renameManaged(KEYS.pmTeamText(p.id, team.id), newSlug, { slug: true });
        }
      }

      if (audit) {
        await audit.log({
          action: 'team.role_renamed',
          targetId: newRole.id,
          details: { teamId: team.id, oldName: oldRole.name, newName: newRole.name, slug: newSlug },
        });
      }
      return { handled: true, type: 'team', team };
    }

    // 2. Check if associated with a PM
    const pms = await state.pms();
    const pm = pms.find((p) => p.roleId === newRole.id || p.name.toLowerCase() === oldRole.name.toLowerCase() || p.name.toLowerCase() === oldRole.name.replace(/^PM\s*[:-]\s*/i, '').toLowerCase());
    if (pm) {
      const newPmName = newRole.name.replace(/^PM\s*[:-]\s*/i, '').trim();
      const newSlug = slugify(newPmName);
      await state.updatePm(pm.id, { name: newPmName, slug: newSlug });

      if (managed) {
        await managed.renameManaged(KEYS.pmRole(pm.id), newRole.name);
        await managed.renameManaged(KEYS.pmCategory(pm.id), newPmName);
        await managed.renameManaged(KEYS.pmControl(pm.id), `${newSlug}-control`, { slug: true });
        await managed.renameManaged(KEYS.pmUpdates(pm.id), `${newSlug}-updates`, { slug: true });
      }

      if (audit) {
        await audit.log({
          action: 'pm.role_renamed',
          targetId: newRole.id,
          details: { pmId: pm.id, oldName: pm.name, newName: newPmName },
        });
      }
      return { handled: true, type: 'pm', pm };
    }

    return { ignored: true, reason: 'unmatched' };
  });
}

/**
 * Safely inspects a resource forum for manual content (active & archived threads).
 * Fails conservatively: preserves the forum if Discord API fails or access is missing.
 * Only returns false when emptiness has been positively established or channel is already missing from Discord.
 */
export async function forumHasManualContent(client, cfg, reconciler, teamId) {
  const forumKey = KEYS.resourceForum(teamId);
  const forumId = await reconciler?.getObjectId?.(forumKey);
  if (!forumId || !client) return false;

  let forum = null;
  try {
    forum = (await client.channels?.fetch?.(forumId).catch((err) => {
      if (err?.code === 10003 || err?.code === 10011 || err?.status === 404) return null;
      throw err;
    }));
  } catch (err) {
    // API error fetching forum channel: fail-safe preserve
    log.warn(`failed to fetch forum channel for team ${teamId}, preserving conservatively: ${err.message}`);
    return true;
  }

  // If channel is already missing from Discord, safe to clean up
  if (!forum) return false;

  // If threads API is not available on channel, fail-safe preserve
  if (!forum.threads) {
    log.warn(`threads API unavailable for forum channel ${forumId}, preserving conservatively`);
    return true;
  }

  // 1. Check active threads
  let active = null;
  try {
    active = await forum.threads.fetchActive?.();
  } catch (err) {
    log.warn(`failed to fetch active threads for forum ${forumId}, preserving conservatively: ${err.message}`);
    return true;
  }

  const activeList = active?.threads ? (active.threads instanceof Map ? [...active.threads.values()] : (Array.isArray(active.threads) ? active.threads : [...(active.threads || [])])) : [];
  if (activeList.length > 0) return true;

  // 2. Check public archived threads
  let archivedPub = null;
  try {
    archivedPub = await forum.threads.fetchArchived?.({ type: 'public' });
  } catch (err) {
    log.warn(`failed to fetch public archived threads for forum ${forumId}, preserving conservatively: ${err.message}`);
    return true;
  }

  const pubList = archivedPub?.threads ? (archivedPub.threads instanceof Map ? [...archivedPub.threads.values()] : (Array.isArray(archivedPub.threads) ? archivedPub.threads : [...(archivedPub.threads || [])])) : [];
  if (pubList.length > 0) return true;

  // 3. Check private archived threads where supported
  try {
    const archivedPriv = await forum.threads.fetchArchived?.({ type: 'private' });
    if (archivedPriv) {
      const privList = archivedPriv.threads ? (archivedPriv.threads instanceof Map ? [...archivedPriv.threads.values()] : (Array.isArray(archivedPriv.threads) ? archivedPriv.threads : [...(archivedPriv.threads || [])])) : [];
      if (privList.length > 0) return true;
    }
  } catch (err) {
    log.warn(`failed to fetch private archived threads for forum ${forumId}, preserving conservatively: ${err.message}`);
    return true;
  }

  // Positively established: 0 active, 0 public archived, 0 private archived threads
  return false;
}

/**
 * Handle role deletion safely:
 * Cleans up associated resources and team text channels without touching member user records or unrelated channels.
 * Preserves manually posted forum content and NEVER deletes PM team text channels.
 */
export async function handleRoleDelete(ctx, role) {
  const { cfg, state, store, managed, audit, client, reconciler, roles } = ctx;
  if (isProtectedRole(role, cfg)) return { ignored: true, reason: 'protected' };

  return withRoleLock(role.id, async () => {
    log.warn(`Discord role deleted: "${role.name}" (${role.id})`);

    // 1. Check if associated with a Team
    const team = await state.teamByRole(role.id) || await state.teamByName(role.name);
    if (team) {
      log.info(`cleaning up resources for deleted team role "${team.name}" (${team.id})`);

      // Positively verify emptiness of resource forum across active and archived threads
      const hasManualContent = await forumHasManualContent(client, cfg, reconciler, team.id);

      if (managed) {
        if (!hasManualContent) {
          await managed.deleteManaged(KEYS.resourceForum(team.id), 'Team role deleted in Discord');
        } else {
          log.info(`preserving resource forum for team ${team.name} due to existing forum content or conservative fail-safe`);
        }
        await managed.deleteManaged(KEYS.teamRole(team.id), 'Team role deleted in Discord');
      }

      // Clean registry keys
      await store.delete('registry', KEYS.teamRole(team.id));
      if (!hasManualContent) {
        await store.delete('registry', KEYS.resourceForum(team.id));
      }

      // PM team text channels: NEVER delete Discord channels during team role deletion.
      // Remove only their bot-managed registry mappings to preserve chat history, manual messages, attachments, and threads.
      const regRows = await store.list('registry');
      for (const r of regRows) {
        if (r.key?.endsWith(`:team:${team.id}:text`)) {
          await store.delete('registry', r.key);
          log.info(`unmanaged registry mapping for ${r.key}; preserved Discord channel and all message history`);
        }
      }

      // Update PMs in Firestore: remove deleted team from all PM records and Discord roles
      const roleService = roles || ctx.roles;
      for (const p of await state.pms()) {
        if ((p.teamIds || []).includes(team.id)) {
          await state.updatePm(p.id, { teamIds: p.teamIds.filter((t) => t !== team.id) });
        }
        if (p.discordUserId && roleService?.apply) {
          try {
            await roleService.apply(p.discordUserId, { remove: [role.id] }, `IPDC team role deleted: ${team.name}`);
          } catch (e) {
            log.debug(`could not remove deleted role ${role.id} from ${p.name}: ${e.message}`);
          }
        }
      }

      // Unset teamId from members who had this teamId - member accounts remain intact
      for (const m of (await state.members()).filter((x) => x.teamId === team.id)) {
        await state.saveMember(m.id, { teamId: null });
      }

      // Soft-delete team in Firestore
      await state.updateTeam(team.id, { status: 'removed', removedAt: Date.now() });

      if (audit) {
        await audit.log({
          action: 'team.role_deleted',
          targetId: role.id,
          details: { teamId: team.id, name: team.name },
        });
      }
      return { handled: true, type: 'team', team };
    }

    // 2. Check if associated with a PM
    const pms = await state.pms();
    const pm = pms.find((p) => p.roleId === role.id || p.name.toLowerCase() === role.name.toLowerCase());
    if (pm) {
      log.info(`cleaning up workspace for deleted PM role "${pm.name}" (${pm.id})`);
      if (managed) {
        await managed.deleteWhere((k) => k.startsWith(`pm:${pm.id}:`) || k.startsWith(`msg:pm:${pm.id}:`), 'PM role deleted in Discord');
      }
      await state.updatePm(pm.id, { status: 'removed', removedAt: Date.now() });
      for (const m of await state.membersOfPm(pm.id)) {
        await state.saveMember(m.id, { pmId: null, teamId: null, status: 'unassigned' });
      }

      if (audit) {
        await audit.log({
          action: 'pm.role_deleted',
          targetId: role.id,
          details: { pmId: pm.id, name: pm.name },
        });
      }
      return { handled: true, type: 'pm', pm };
    }

    return { ignored: true, reason: 'unmatched' };
  });
}

/**
 * Handle member role updates:
 * If a PM's roles in Discord are modified directly, synchronize their assigned teams and provision/deprovision channels.
 */
export async function handleMemberUpdate(ctx, oldMember, newMember) {
  const { state, audit } = ctx;
  if (!newMember) return { ignored: true };

  const pm = await state.pmByUser(newMember.id);
  if (!pm) return { ignored: true, reason: 'not_pm' };

  const newRoleIds = new Set(newMember.roles?.cache?.keys() || []);
  const allTeams = await state.teams();

  const mappedTeamIds = [];
  for (const t of allTeams) {
    const roleId = t.roleId || (await ctx.reconciler?.getObjectId?.(KEYS.teamRole(t.id)));
    if (roleId && newRoleIds.has(roleId)) {
      mappedTeamIds.push(t.id);
    }
  }

  const currentTeamIds = pm.teamIds || [];
  const same = mappedTeamIds.length === currentTeamIds.length && mappedTeamIds.every((id) => currentTeamIds.includes(id));
  if (same) return { ignored: true, reason: 'teams_unchanged' };

  log.info(`synchronizing PM ${pm.name} teams from Discord member role update: [${mappedTeamIds.join(', ')}]`);
  await state.updatePm(pm.id, { teamIds: mappedTeamIds });
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  if (audit) {
    await audit.log({
      action: 'pm.roles_synced',
      targetId: newMember.id,
      details: { pmId: pm.id, teams: mappedTeamIds },
    });
  }

  return { handled: true, pm, teamIds: mappedTeamIds };
}

