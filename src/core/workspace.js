import { ActionRowBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { fmtIST, slugify, truncate } from '../utils/misc.js';
import { KEYS, bitsOf, PERM_GROUPS } from './structure.js';
import { BRAND } from '../config/constants.js';
import { button, embed, errEmbed, okEmbed, row } from '../ui.js';
import { pmPanelPayload } from '../features/pm.js';

const log = createLogger('workspace');

// ---------------------------------------------------------------------------
// 1. Channel Introduction Content
// ---------------------------------------------------------------------------

export function pmControlIntroPayload(pm, teams = []) {
  return pmPanelPayload(pm);
}

export function pmUpdatesIntroPayload(pm) {
  return {
    embeds: [embed({
      title: 'PROJECT UPDATES',
      color: BRAND.accent,
      description: 'Post project announcements, deadlines, and milestone updates here.',
    })],
  };
}

export function pmGithubActivityIntroPayload(pm, githubConfig = {}) {
  return {
    embeds: [embed({
      title: 'GITHUB ACTIVITY',
      color: BRAND.accent,
      description: 'Daily repository activity and contribution summaries appear here.',
    })],
  };
}

export function pmTeamTextIntroPayload(pm, team) {
  return {
    embeds: [embed({
      title: `${team.name.toUpperCase()} TEAM`,
      color: BRAND.accent,
      description: [
        `Collaboration channel for the **${team.name}** team under Project Manager <@${pm.discordUserId}>.`,
        'Discuss project tasks, share updates, and coordinate with your team here.',
      ].join('\n'),
    })],
  };
}

export function teamResourceContent(teamName, teamSlug) {
  const desc = `Official resources for the ${teamName} team. Resources are posted and maintained by authorized IPDC administrators.`;
  return {
    title: `Official resources for the ${teamName} team`,
    description: desc,
    content: desc,
  };
}

export function pmOnboardingWelcomePayload(pm, { channels = {}, teams = [] } = {}) {
  const teamList = teams.length ? teams.map((t) => `• **${t.name}**`).join('\n') : '• Pending assignment';
  const resourceLinks = teams.length
    ? teams.map((t) => `• <#${channels.resources?.[t.id] || slugify(t.name)}> (${t.name})`).join('\n')
    : '• None assigned yet';

  const e = embed({
    title: `WELCOME TO YOUR PM WORKSPACE — ${pm.name.toUpperCase()}`,
    color: BRAND.accent,
    description: `Congratulations <@${pm.discordUserId}>! Your Project Manager appointment at the **INVICTUS PROJECT DEVELOPMENT CENTRE** has been approved.\n\nYour personal PM workspace and team resources are now fully provisioned and ready.`,
    fields: [
      {
        name: 'Your Assigned Team(s)',
        value: teamList,
      },
      {
        name: 'Your Personal PM Workspace',
        value: [
          `• **Control Panel**: <#${channels.control}> (Manage repo, review applicant requests)`,
          `• **Updates Channel**: <#${channels.updates}> (Post deadlines and announcements)`,
          `• **GitHub Activity**: <#${channels.activity}> (Daily consolidated activity & stats)`,
          `• **Voice Rooms**: <#${channels.meeting}> · <#${channels.project}>`,
        ].join('\n'),
      },
      {
        name: 'Team Resources Access',
        value: resourceLinks,
      },
      {
        name: 'Getting Started Checklist',
        value: [
          `1. Open <#${channels.control}> and click **SET REPOSITORY** to configure your project repo.`,
          `2. Check your assigned team forum in **IPDC RESOURCES** to review technical standards.`,
          `3. Coordinate with your team in your dedicated team channels.`,
          `4. Post milestone updates and meeting schedules in <#${channels.updates}>.`,
        ].join('\n'),
      },
      {
        name: 'Need Assistance?',
        value: 'For questions regarding role changes, server configuration, or project escalations, contact the **IPDC Administration** via a Support Ticket or `#admin-panel`.',
      },
    ],
    footer: 'INVICTUS PROJECT DEVELOPMENT CENTRE · Member Onboarding',
  });
  return { embeds: [e] };
}

// ---------------------------------------------------------------------------
// 2. Idempotent PM Workspace Provisioner & Concurrency Lock
// ---------------------------------------------------------------------------

const _provisionLocks = new Map();

export async function withProvisionLock(pmId, fn) {
  while (_provisionLocks.has(pmId)) {
    try {
      await _provisionLocks.get(pmId);
    } catch {
      // Ignore errors from previous operation
    }
  }
  let resolveLock;
  const lockPromise = new Promise((resolve) => {
    resolveLock = resolve;
  });
  _provisionLocks.set(pmId, lockPromise);
  try {
    return await fn();
  } finally {
    _provisionLocks.delete(pmId);
    resolveLock();
  }
}

export async function provisionPmWorkspace(ctx, pmId, options = {}) {
  return withProvisionLock(pmId, async () => {
    return _provisionPmWorkspaceInternal(ctx, pmId, options);
  });
}

async function _provisionPmWorkspaceInternal(ctx, pmId, { welcome = true, auditActorId = null, syncGlobal } = {}) {
  const { state, store, reconciler, roles, client, cfg, audit } = ctx;
  const pm = await state.getPm(pmId);
  if (!pm || pm.status === 'removed') throw new Error(`Project Manager "${pmId}" not found or removed.`);

  log.info(`provisioning PM workspace for ${pm.name} (${pm.id})`);

  // 1. Ensure personal PM role
  let pmRoleId = await reconciler.getObjectId(KEYS.pmRole(pm.id));
  if (!pmRoleId) {
    await reconciler.run(`ensure-pm-role:${pm.id}`);
    pmRoleId = await reconciler.getObjectId(KEYS.pmRole(pm.id));
  }

  // 2. Resolve assigned teams and team roles
  const allStoredTeams = (store ? await store.list('teams') : await state.teams()) || [];
  const allTeams = allStoredTeams;
  const activeTeams = allTeams.filter((t) => t.status !== 'removed');
  const activeTeamIds = activeTeams.map((t) => t.id);

  // In global assignment architecture:
  // Every active PM receives every valid active team role.
  // Workspace provisioning uses the complete active team list, not an incomplete or stale pm.teamIds list.
  const shouldSyncGlobal = syncGlobal !== false && !pm.name?.toLowerCase().includes('other pm');
  let assignedTeams;
  if (shouldSyncGlobal) {
    assignedTeams = activeTeams;
    const currentTeamIds = pm.teamIds || [];
    const isMissing = activeTeamIds.some((id) => !currentTeamIds.includes(id));
    const hasObsolete = currentTeamIds.some((id) => !activeTeamIds.includes(id));
    if (isMissing || hasObsolete) {
      await state.updatePm(pm.id, { teamIds: activeTeamIds });
      pm.teamIds = activeTeamIds;
    }
  } else {
    const assignedTeamIds = pm.teamIds || [];
    assignedTeams = allTeams.filter((t) => assignedTeamIds.includes(t.id));
  }

  const teamRoleIds = {};
  for (const t of assignedTeams) {
    let trId = await reconciler.getObjectId(KEYS.teamRole(t.id));
    if (!trId) {
      await reconciler.run(`ensure-team-role:${t.id}`);
      trId = await reconciler.getObjectId(KEYS.teamRole(t.id));
    }
    if (trId) teamRoleIds[t.id] = trId;
  }

  // 3. Reconcile Discord structure so all categories and channels exist
  await reconciler.run(`pm-workspace:${pm.id}`);

  // 4. Synchronize PM member roles in Discord
  const rolesAdded = [];
  const rolesRemoved = [];
  if (pm.discordUserId && roles) {
    const ipdcRoleId = await reconciler.getObjectId(KEYS.roleIpdc);
    const toAdd = [ipdcRoleId, pmRoleId, ...Object.values(teamRoleIds)].filter(Boolean);

    // Identify team roles to remove:
    // Only remove team roles if the team is confirmed inactive/removed
    // Or if not in assignedTeams (when shouldSyncGlobal is false)
    const toRemove = [];
    for (const t of allTeams) {
      if (t.status === 'removed' || (!shouldSyncGlobal && !assignedTeams.some((at) => at.id === t.id))) {
        const otherTrId = await reconciler.getObjectId(KEYS.teamRole(t.id));
        if (otherTrId) toRemove.push(otherTrId);
      }
    }

    const protectedRoles = new Set([
      cfg?.roles?.grid,
      cfg?.roles?.admin,
      '1568690888413282396',
      '1568690393824891141',
    ].filter(Boolean));

    const safeToAdd = toAdd.filter((r) => !protectedRoles.has(r));
    const safeToRemove = toRemove.filter((r) => !protectedRoles.has(r) && !safeToAdd.includes(r));

    try {
      const applied = await roles.apply(
        pm.discordUserId,
        { add: safeToAdd, remove: safeToRemove },
        `IPDC PM workspace provisioning for ${pm.name}`
      );
      rolesAdded.push(...(applied?.added || []));
      rolesRemoved.push(...(applied?.removed || []));
    } catch (e) {
      log.warn(`could not apply roles to PM user ${pm.discordUserId}: ${e.message}`);
      const enqueueFn = ctx.queue?.enqueue
        ? ctx.queue.enqueue.bind(ctx.queue)
        : ctx.queue?.add
          ? ctx.queue.add.bind(ctx.queue)
          : null;
      if (enqueueFn) {
        try {
          await enqueueFn('roles.apply', {
            userId: pm.discordUserId,
            add: safeToAdd,
            remove: safeToRemove,
          }, {
            dedupeKey: `pm_${pm.id}_sync`,
          });
          log.info(`enqueued role sync retry for PM ${pm.id}`);
        } catch (queueErr) {
          log.warn(`failed to enqueue role sync retry: ${queueErr.message}`);
        }
      }
    }
  }

  // 5. Gather created channel IDs
  const channelIds = {
    category: await reconciler.getObjectId(KEYS.pmCategory(pm.id)),
    control: await reconciler.getObjectId(KEYS.pmControl(pm.id)),
    updates: await reconciler.getObjectId(KEYS.pmUpdates(pm.id)),
    activity: await reconciler.getObjectId(KEYS.pmActivity(pm.id)),
    meeting: await reconciler.getObjectId(KEYS.pmVoiceMeeting(pm.id)),
    project: await reconciler.getObjectId(KEYS.pmVoiceProject(pm.id)),
    teams: {},
    resources: {},
  };

  for (const t of assignedTeams) {
    channelIds.teams[t.id] = await reconciler.getObjectId(KEYS.pmTeamText(pm.id, t.id));
  }
  for (const t of allTeams) {
    channelIds.resources[t.id] = await reconciler.getObjectId(KEYS.resourceForum(t.id));
  }

  // 6. Populate structured introduction messages via messages.ensure (idempotent, edited in place)
  if (ctx.messages?.ensure) {
    // #<slug>-control: Interactive PM Control Panel
    await ctx.messages.ensure(`pm:${pm.id}:panel`, KEYS.pmControl(pm.id), pmPanelPayload(pm));

    // Clean up legacy intro:control bot message if it was previously registered
    if (ctx.store) {
      try {
        const oldReg = await ctx.store.get('registry', `msg:pm:${pm.id}:intro:control`);
        if (oldReg?.messageId && oldReg?.channelId) {
          const ch = await ctx.client?.channels?.fetch(oldReg.channelId).catch(() => null);
          if (ch?.messages?.fetch) {
            const oldMsg = await ch.messages.fetch(oldReg.messageId).catch(() => null);
            if (oldMsg && oldMsg.author?.id === ctx.client?.user?.id) {
              await oldMsg.delete().catch(() => {});
            }
          }
          await ctx.store.delete('registry', `msg:pm:${pm.id}:intro:control`).catch(() => {});
        }
      } catch (e) {
        log.warn(`legacy control intro cleanup ignored: ${e.message}`);
      }
    }

    // #<slug>-updates: Announcements
    await ctx.messages.ensure(`pm:${pm.id}:intro:updates`, KEYS.pmUpdates(pm.id), pmUpdatesIntroPayload(pm));

    // #github-activity: Daily status & summaries
    await ctx.messages.ensure(`pm:${pm.id}:dash`, KEYS.pmActivity(pm.id), pmGithubActivityIntroPayload(pm, cfg?.github));

    // Mapped team text channels under PM category
    for (const t of assignedTeams) {
      await ctx.messages.ensure(`pm:${pm.id}:team:${t.id}:intro`, KEYS.pmTeamText(pm.id, t.id), pmTeamTextIntroPayload(pm, t));
    }
  }

  // 7. Send PM onboarding welcome message
  if (welcome && pm.discordUserId && client?.users?.fetch) {
    try {
      const payload = pmOnboardingWelcomePayload(pm, { channels: channelIds, teams: assignedTeams });
      const user = await client.users.fetch(pm.discordUserId).catch(() => null);
      if (user) await user.send(payload).catch(() => log.info(`could not DM PM ${pm.name}; DMs might be closed`));
    } catch (e) {
      log.warn(`welcome notification failed: ${e.message}`);
    }
  }

  // 8. Update PM record in Firestore with provisioning state
  const accessibleResources = assignedTeams.map((t) => ({ teamId: t.id, name: t.name, forumId: channelIds.resources[t.id] }));
  await state.updatePm(pm.id, {
    roleId: pmRoleId,
    teamRoleIds,
    channelIds,
    resourceAccess: accessibleResources,
    provisioningStatus: 'complete',
    provisionedAt: Date.now(),
  });

  if (audit) {
    await audit.log({
      action: 'pm.workspace_provisioned',
      actorId: auditActorId || null,
      targetId: pm.discordUserId,
      details: { pmId: pm.id, name: pm.name, teams: assignedTeams.map((t) => t.name), rolesAdded, rolesRemoved },
    });
  }

  log.info(`workspace provisioned successfully for ${pm.name}`);
  return {
    ok: true,
    pm,
    rolesAdded,
    rolesRemoved,
    channels: channelIds,
    resources: accessibleResources,
  };
}

// ---------------------------------------------------------------------------
// 3. Permission Verification & Audit Engine & Repair
// ---------------------------------------------------------------------------

export async function repairPmWorkspace(ctx, pmId, { auditActorId = null } = {}) {
  return withProvisionLock(pmId, async () => {
    const { state } = ctx;
    const pm = await state.getPm(pmId);
    if (!pm || pm.status === 'removed') {
      throw new Error(`Project Manager "${pmId}" not found or removed.`);
    }

    log.info(`repairing PM workspace for ${pm.name} (${pm.id})`);

    // 1. Backfill all active teams into PM's Firestore record
    const allTeams = await state.teams();
    const activeTeams = allTeams.filter((t) => t.status !== 'removed');
    const activeTeamIds = activeTeams.map((t) => t.id);

    await state.updatePm(pm.id, { teamIds: activeTeamIds });
    pm.teamIds = activeTeamIds;

    // 2. Provision PM workspace using internal helper (already holding lock)
    const provRes = await _provisionPmWorkspaceInternal(ctx, pm.id, {
      welcome: false,
      auditActorId,
      syncGlobal: true,
    });

    // 3. Verify permissions with audit
    const auditRes = await auditPmPermissions(ctx, pm.id);

    return {
      ok: true,
      pm: provRes.pm,
      provision: provRes,
      audit: auditRes,
      repaired: true,
    };
  });
}

export async function auditPmPermissions(ctx, pmId, { auditGlobal = false } = {}) {
  const { state, reconciler, cfg, adapter } = ctx;
  const pm = await state.getPm(pmId);
  if (!pm) throw new Error(`PM "${pmId}" not found.`);

  const allStoredTeams = (ctx.store ? await ctx.store.list('teams') : await state.teams()) || [];
  const allTeams = allStoredTeams;
  const activeTeams = allTeams.filter((t) => t.status !== 'removed');
  const activeTeamIds = activeTeams.map((t) => t.id);
  const assignedTeamIds = pm.teamIds || [];
  const assignedTeams = activeTeams.filter((t) => assignedTeamIds.includes(t.id));
  const unassignedTeams = allTeams.filter((t) => !assignedTeamIds.includes(t.id));
  const otherPms = (await state.pms()).filter((p) => p.id !== pm.id && p.status !== 'removed');

  const missingGlobalTeams = activeTeams.filter((t) => !assignedTeamIds.includes(t.id));

  const checks = [];

  // Helper to test if a subject has ViewChannel allowed on a channel
  const canView = async (channelKey, subjectType, subjectId) => {
    const chId = await reconciler.getObjectId(channelKey);
    if (!chId) return false;
    const chan = await adapter.getChannel(chId);
    if (!chan) return false;
    const ows = await adapter.getOverwrites(chan);

    // Check @everyone deny
    const everyoneOw = ows.get(adapter.everyoneId);
    const everyoneDenied = everyoneOw && (everyoneOw.deny & PermissionFlagsBits.ViewChannel);

    // Check specific overwrite
    const specificOw = ows.get(subjectId);
    if (specificOw) {
      if (specificOw.allow & PermissionFlagsBits.ViewChannel) return true;
      if (specificOw.deny & PermissionFlagsBits.ViewChannel) return false;
    }

    return !everyoneDenied;
  };

  const pmUserId = pm.discordUserId;
  const pmRoleId = await reconciler.getObjectId(KEYS.pmRole(pm.id));

  // 1. Own PM Control
  const ownControlOk = await canView(KEYS.pmControl(pm.id), 'member', pmUserId);
  checks.push({
    name: `Own PM Control (#${pm.slug}-control)`,
    expected: 'ALLOWED',
    actual: ownControlOk ? 'ALLOWED' : 'DENIED',
    pass: ownControlOk,
  });

  // 2. Own PM Updates
  const ownUpdatesOk = await canView(KEYS.pmUpdates(pm.id), 'member', pmUserId);
  checks.push({
    name: `Own PM Updates (#${pm.slug}-updates)`,
    expected: 'ALLOWED',
    actual: ownUpdatesOk ? 'ALLOWED' : 'DENIED',
    pass: ownUpdatesOk,
  });

  // 3. Assigned Team Resources & Channels
  for (const t of assignedTeams) {
    const trId = await reconciler.getObjectId(KEYS.teamRole(t.id));
    const canSee = trId ? await canView(KEYS.resourceForum(t.id), 'role', trId) : false;
    checks.push({
      name: `Assigned Team Resource: ${t.name} (#${slugify(t.name)} forum)`,
      expected: 'ALLOWED',
      actual: canSee ? 'ALLOWED' : 'DENIED',
      pass: canSee,
    });
  }

  // 4. Unassigned Team Resources (must be DENIED)
  for (const t of unassignedTeams) {
    const directAccess = await canView(KEYS.resourceForum(t.id), 'member', pmUserId);
    const roleAccess = pmRoleId ? await canView(KEYS.resourceForum(t.id), 'role', pmRoleId) : false;
    const unauthAccess = directAccess || roleAccess;
    checks.push({
      name: `Unassigned Resource Isolation: ${t.name} (#${slugify(t.name)} forum)`,
      expected: 'DENIED',
      actual: unauthAccess ? 'ALLOWED' : 'DENIED',
      pass: !unauthAccess,
    });
  }

  // 5. Another PM's Control & Updates Channel (must be DENIED)
  for (const other of otherPms.slice(0, 3)) {
    const directAccess = await canView(KEYS.pmControl(other.id), 'member', pmUserId);
    const roleAccess = pmRoleId ? await canView(KEYS.pmControl(other.id), 'role', pmRoleId) : false;
    const leak = directAccess || roleAccess;
    checks.push({
      name: `Other PM Isolation (#${other.slug}-control)`,
      expected: 'DENIED',
      actual: leak ? 'ALLOWED' : 'DENIED',
      pass: !leak,
    });

    const directUpdatesAccess = await canView(KEYS.pmUpdates(other.id), 'member', pmUserId);
    const roleUpdatesAccess = pmRoleId ? await canView(KEYS.pmUpdates(other.id), 'role', pmRoleId) : false;
    const leakUpdates = directUpdatesAccess || roleUpdatesAccess;
    checks.push({
      name: `Other PM Updates Isolation (#${other.slug}-updates)`,
      expected: 'DENIED',
      actual: leakUpdates ? 'ALLOWED' : 'DENIED',
      pass: !leakUpdates,
    });
  }

  // 6. ADMIN CONTROL (#admin-panel) (must be DENIED)
  const adminAccess = (await canView('ch:admin-panel', 'member', pmUserId)) || (pmRoleId ? await canView('ch:admin-panel', 'role', pmRoleId) : false);
  checks.push({
    name: 'ADMIN CONTROL (#admin-panel)',
    expected: 'DENIED',
    actual: adminAccess ? 'ALLOWED' : 'DENIED',
    pass: !adminAccess,
  });

  // 7. IPDC GRID Private Channel (#admin-audit-logs) (must be DENIED)
  const gridAccess = (await canView('ch:admin-audit-logs', 'member', pmUserId)) || (pmRoleId ? await canView('ch:admin-audit-logs', 'role', pmRoleId) : false);
  checks.push({
    name: 'IPDC GRID Channel (#admin-audit-logs)',
    expected: 'DENIED',
    actual: gridAccess ? 'ALLOWED' : 'DENIED',
    pass: !gridAccess,
  });

  // Optional global assignments check
  if (auditGlobal) {
    for (const t of activeTeams) {
      const isAssigned = assignedTeamIds.includes(t.id);
      checks.push({
        name: `Global Team Assignment: ${t.name}`,
        expected: 'ASSIGNED',
        actual: isAssigned ? 'ASSIGNED' : 'MISSING',
        pass: isAssigned,
      });
    }
  }

  const pass = checks.every((c) => c.pass);
  return { pass, checks, missingGlobalTeams };
}
