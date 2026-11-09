import { ChannelType } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { slugify } from '../utils/misc.js';
import { KEYS } from './structure.js';
import { provisionPmWorkspace } from './workspace.js';

const log = createLogger('dynamic-roles');

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
 * Detect newly created Discord roles and automatically provision:
 * - Registration in Firestore as team role
 * - Resource forum under IPDC RESOURCES with technical starter post
 * - PM workspace integration and channel provisioning
 * - Permission configuration
 */
export async function handleRoleCreate(ctx, role) {
  const { cfg, state, store, reconciler, managed, audit, client } = ctx;
  if (isProtectedRole(role, cfg)) {
    log.debug(`ignoring protected or managed role creation: ${role.name} (${role.id})`);
    return { ignored: true, reason: 'protected' };
  }

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

  // Check if any existing PM members in the guild already possess this role in Discord
  const pms = await state.pms();
  for (const p of pms) {
    if (!p.discordUserId) continue;
    let member = null;
    try {
      const guild = client.guilds?.cache?.get(cfg.discord.guildId) || (await client.guilds?.fetch?.(cfg.discord.guildId).catch(() => null));
      member = guild ? await guild.members.fetch(p.discordUserId).catch(() => null) : null;
    } catch {}

    if (member && member.roles?.cache?.has(role.id)) {
      if (!(p.teamIds || []).includes(team.id)) {
        log.info(`auto-linking team ${team.name} to PM ${p.name} based on Discord role possession`);
        await state.updatePm(p.id, { teamIds: [...(p.teamIds || []), team.id] });
        await provisionPmWorkspace(ctx, p.id, { welcome: false });
      }
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
}

/**
 * Handle role renaming:
 * Synchronize team/PM names, slugs, forum names, and channels without recreating objects.
 */
export async function handleRoleUpdate(ctx, oldRole, newRole) {
  const { cfg, state, managed, audit } = ctx;
  if (isProtectedRole(newRole, cfg)) return { ignored: true, reason: 'protected' };
  if (oldRole.name === newRole.name) return { ignored: true, reason: 'name_unchanged' };

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
}

/**
 * Handle role deletion safely:
 * Cleans up associated resources and team text channels without touching member user records or unrelated channels.
 */
export async function handleRoleDelete(ctx, role) {
  const { cfg, state, store, managed, audit } = ctx;
  if (isProtectedRole(role, cfg)) return { ignored: true, reason: 'protected' };

  log.warn(`Discord role deleted: "${role.name}" (${role.id})`);

  // 1. Check if associated with a Team
  const team = await state.teamByRole(role.id) || await state.teamByName(role.name);
  if (team) {
    log.info(`cleaning up resources for deleted team role "${team.name}" (${team.id})`);

    // Delete resource forum and team channels under PMs
    if (managed) {
      await managed.deleteManaged(KEYS.resourceForum(team.id), 'Team role deleted in Discord');
      await managed.deleteWhere((k) => k.endsWith(`:team:${team.id}:text`), 'Team role deleted in Discord');
      await managed.deleteManaged(KEYS.teamRole(team.id), 'Team role deleted in Discord');
    }

    // Clean registry keys
    await store.delete('registry', KEYS.teamRole(team.id));
    await store.delete('registry', KEYS.resourceForum(team.id));

    // Update PMs in Firestore
    for (const p of await state.pms()) {
      if ((p.teamIds || []).includes(team.id)) {
        await state.updatePm(p.id, { teamIds: p.teamIds.filter((t) => t !== team.id) });
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

