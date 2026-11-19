import { ActionRowBuilder, ButtonStyle, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { fmtIST, parseRepoRef, truncate } from '../utils/misc.js';
import { makeActor } from '../core/auth.js';
import { say } from '../core/router.js';
import { button, embed, errEmbed, okEmbed, row } from '../ui.js';
import { BRAND } from '../config/constants.js';
import { provisionPmWorkspace } from '../core/workspace.js';
import { getValidActiveTeams } from '../core/dynamicRoles.js';

const log = createLogger('pm');

export function pmPanelPayload(pm) {
  return {
    embeds: [embed({
      title: 'PM CONTROL PANEL',
      color: BRAND.accent,
      description: [
        'Your private project management channel.',
        '',
        'Use the buttons below to:',
        '- Manage your teams',
        '- Set your repository',
        '- Review requests',
        '- View team overview',
      ].join('\n'),
    })],
    components: [
      row(
        button(`pm:repo:${pm.id}`, 'SET REPOSITORY', ButtonStyle.Primary),
        button(`pm:manage-teams:${pm.id}`, 'MANAGE TEAMS', ButtonStyle.Success),
        button(`pm:team:${pm.id}`, 'TEAM OVERVIEW'),
      ),
      row(
        button(`pm:pending:${pm.id}`, 'PENDING REQUESTS'),
        button(`pm:refresh:${pm.id}`, 'REFRESH ACTIVITY'),
      ),
    ],
  };
}

export function register(router, ctx) {
  const { state, auth, audit, store } = ctx;

  async function load(i, pmId, action = 'pm.panel') {
    const pm = await state.getPm(pmId);
    if (!pm || pm.status === 'removed') { await say(i, { embeds: [errEmbed('This PM no longer exists.')] }); return null; }
    if (!(await auth.can(action, makeActor(i.member, i.user.id), { pm }))) {
      await audit.log({ action: 'authz.denied', actorId: i.user.id, level: 'warn', details: { area: action, pmId } });
      await say(i, { embeds: [errEmbed('This control is restricted to the Project Manager of this team.', 'Not Authorized')] }); return null;
    }
    return pm;
  }
  const panelOk = async (i, pmId) => (await auth.can('pm.panel', makeActor(i.member, i.user.id), { pm: await state.getPm(pmId) })) || auth.isGrid(makeActor(i.member, i.user.id)) || auth.isAdminRole(makeActor(i.member, i.user.id));

  router.button('pm:repo', async (i, [pmId]) => {
    const pm = await load(i, pmId, 'repo.change'); if (!pm) return;
    if (!ctx.github.enabled) return say(i, { embeds: [errEmbed('GitHub monitoring is not configured yet. An administrator must add the GitHub App credentials.')] });
    const m = new ModalBuilder().setCustomId(`pm:repom:${pmId}`).setTitle('Monitored Repository').addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('repo').setLabel('Repository (owner/name or GitHub URL)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(120).setValue(pm.repo ? `${pm.repo.owner}/${pm.repo.name}` : '')));
    await i.showModal(m);
  });

  router.modal('pm:repom', async (i, [pmId]) => {
    await i.deferReply({ flags: 64 });
    const pm = await load(i, pmId, 'repo.change'); if (!pm) return;
    const ref = parseRepoRef(i.fields.getTextInputValue('repo'));
    if (!ref) return say(i, { embeds: [errEmbed('Enter a repository as owner/name or a github.com URL.')] });
    let info;
    try { info = await ctx.github.getRepo(ref.owner, ref.name); } catch (e) {
      return say(i, { embeds: [errEmbed(e.status === 404 ? 'The repository was not found or the IPDC GitHub App has no access to it. Ask an administrator to grant the app read access to this repository.' : 'GitHub could not be reached. Try again shortly.')] });
    }
    if (info.archived) return say(i, { embeds: [errEmbed('That repository is archived.')] });
    const prev = pm.repo ? `${pm.repo.owner}/${pm.repo.name}` : null;
    await state.updatePm(pmId, { repo: { owner: info.owner, name: info.name, url: info.url, defaultBranch: info.defaultBranch, private: info.private, setAt: Date.now(), setBy: i.user.id } });
    await audit.log({ action: 'pm.repo_changed', actorId: i.user.id, details: { pmId, from: prev, to: info.fullName } });
    await ctx.panels?.refreshPm?.(pmId);
    ctx.monitoring?.refreshPm?.(pmId).catch((e) => log.warn('post-repo refresh failed', e));
    await say(i, { embeds: [okEmbed(`Monitoring **${info.fullName}**. The team activity dashboard will refresh shortly.`, 'Repository Updated')] });
  });

  router.button('pm:team', async (i, [pmId, pageStr]) => {
    if (!(await panelOk(i, pmId))) return say(i, { embeds: [errEmbed('Not authorized.')] });
    const pm = await state.getPm(pmId);
    if (!pm) return say(i, { embeds: [errEmbed('PM not found.')] });

    const validTeams = await getValidActiveTeams(ctx);
    if (!validTeams.length) {
      const payload = { embeds: [embed({ title: `TEAM OVERVIEW — ${pm.name}`, description: 'No team roles configured yet.' })], components: [] };
      if (pageStr && typeof i.update === 'function') return i.update(payload);
      return say(i, payload);
    }

    const members = await state.membersOfPm(pmId);
    const byTeam = new Map(validTeams.map((t) => [t.id, []]));
    const unassigned = [];

    for (const m of members) {
      if (m.teamId && byTeam.has(m.teamId)) {
        byTeam.get(m.teamId).push(m);
      } else {
        unassigned.push(m);
      }
    }

    const PAGE_SIZE = 8;
    const totalPages = Math.max(1, Math.ceil(validTeams.length / PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, parseInt(pageStr || '1', 10) || 1), totalPages);

    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const pageTeams = validTeams.slice(startIdx, startIdx + PAGE_SIZE);

    const lines = [];
    for (const t of pageTeams) {
      const tMembers = byTeam.get(t.id) || [];
      if (tMembers.length > 0) {
        const memberList = tMembers.map((m) => `<@${m.id}>${m.github?.username ? ` — [${m.github.username}](https://github.com/${m.github.username})` : ''}`).join('\n');
        lines.push(`**${t.name}** (${tMembers.length})\n${memberList}`);
      } else {
        lines.push(`**${t.name}** (0)\n*No members assigned yet*`);
      }
    }

    if (currentPage === totalPages && unassigned.length > 0) {
      const unassignedList = unassigned.map((m) => `<@${m.id}>${m.github?.username ? ` — [${m.github.username}](https://github.com/${m.github.username})` : ''}`).join('\n');
      lines.push(`**Unassigned** (${unassigned.length})\n${unassignedList}`);
    }

    const title = totalPages > 1
      ? `TEAM OVERVIEW — ${pm.name} (Page ${currentPage} of ${totalPages})`
      : `TEAM OVERVIEW — ${pm.name}`;

    const components = [];
    if (totalPages > 1) {
      const prevBtn = button(`pm:team:${pm.id}:${currentPage - 1}`, '◀ PREV', ButtonStyle.Secondary);
      if (currentPage <= 1) prevBtn.setDisabled(true);
      const nextBtn = button(`pm:team:${pm.id}:${currentPage + 1}`, 'NEXT ▶', ButtonStyle.Secondary);
      if (currentPage >= totalPages) nextBtn.setDisabled(true);
      components.push(row(prevBtn, nextBtn));
    }

    const payload = {
      embeds: [embed({ title, description: truncate(lines.join('\n\n') || 'No approved members yet.', 3900) })],
      components,
    };

    if (pageStr && typeof i.update === 'function') {
      return i.update(payload);
    }
    return say(i, payload);
  });

  router.button('pm:pending', async (i, [pmId]) => {
    if (!(await panelOk(i, pmId))) return say(i, { embeds: [errEmbed('Not authorized.')] });
    const pending = (await store.where('requests', 'pmId', pmId)).filter((r) => r.status === 'pending');
    const g = ctx.cfg.discord.guildId;
    await say(i, { embeds: [embed({ title: 'PENDING REQUESTS', description: pending.map((r) => `• ${r.type.replace('_', ' ')} — <@${r.userId}> — [open](https://discord.com/channels/${g}/${r.ref?.channelId}/${r.ref?.messageId}) (${fmtIST(r.createdAt)})`).join('\n') || 'No pending requests.' })] });
  });

  router.button('pm:manage-teams', async (i, [pmId, pageStr]) => {
    if (!(await panelOk(i, pmId))) return say(i, { embeds: [errEmbed('Not authorized.')] });
    const pm = await state.getPm(pmId);
    if (!pm) return say(i, { embeds: [errEmbed('PM not found.')] });

    const validTeams = await getValidActiveTeams(ctx);
    if (!validTeams.length) return say(i, { embeds: [errEmbed('No team roles configured yet.')] });

    // Under Option B, active teams are authoritative: ensure pm.teamIds has all valid teams and prune obsolete
    const validTeamIds = validTeams.map((t) => t.id);
    const currentTeamIds = pm.teamIds || [];
    const needsSync = validTeamIds.some((id) => !currentTeamIds.includes(id)) || currentTeamIds.some((id) => !validTeamIds.includes(id));
    if (needsSync) {
      await state.updatePm(pmId, { teamIds: validTeamIds });
    }

    // Discord limits:
    // Max 5 ActionRows per message.
    // Max 25 options per StringSelectMenu.
    // If <= 100 teams: chunk into select menus of 25 options each (up to 4 rows).
    // If > 100 teams: paginate across pages (4 select menu rows per page + 1 row for PREV/NEXT navigation).
    const TEAMS_PER_PAGE = 100;
    const totalPages = Math.max(1, Math.ceil(validTeams.length / TEAMS_PER_PAGE));
    const currentPage = Math.min(Math.max(1, parseInt(pageStr || '1', 10) || 1), totalPages);

    const startIdx = (currentPage - 1) * TEAMS_PER_PAGE;
    const pageTeams = validTeams.slice(startIdx, startIdx + TEAMS_PER_PAGE);

    const CHUNK_SIZE = 25;
    const components = [];

    for (let c = 0; c < pageTeams.length && components.length < 4; c += CHUNK_SIZE) {
      const slice = pageTeams.slice(c, c + CHUNK_SIZE);
      const rowIdx = components.length + 1;
      const opts = slice.map((t) => ({
        label: t.name.slice(0, 100),
        value: t.id,
        default: true,
      }));
      const rangeLabel = totalPages > 1
        ? `Teams ${startIdx + c + 1}–${startIdx + c + slice.length}`
        : slice.length > 25 ? `Teams ${c + 1}–${c + slice.length}` : 'Select assigned team roles';

      components.push(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(`pm:set-teams:${pm.id}:${currentPage}:${rowIdx}`)
            .setPlaceholder(rangeLabel)
            .setMinValues(0)
            .setMaxValues(opts.length)
            .addOptions(opts)
        )
      );
    }

    if (totalPages > 1) {
      const prevBtn = button(`pm:manage-teams:${pm.id}:${currentPage - 1}`, '◀ PREV', ButtonStyle.Secondary);
      if (currentPage <= 1) prevBtn.setDisabled(true);
      const nextBtn = button(`pm:manage-teams:${pm.id}:${currentPage + 1}`, 'NEXT ▶', ButtonStyle.Secondary);
      if (currentPage >= totalPages) nextBtn.setDisabled(true);
      components.push(row(prevBtn, nextBtn));
    }

    const content = `Active team roles for **${pm.name}** (Option B: All active team roles are globally assigned to your workspace). Use the menus below to review your assigned teams.${totalPages > 1 ? ` (Page ${currentPage} of ${totalPages})` : ''}`;

    const payload = { content, components };
    if (pageStr && typeof i.update === 'function') {
      return i.update(payload);
    }
    return say(i, payload);
  });

  router.select('pm:set-teams', async (i, [pmId]) => {
    await i.deferUpdate();
    if (!(await panelOk(i, pmId))) return;
    const pm = await state.getPm(pmId);
    if (!pm) return;

    // Under Option B, all active teams are authoritative.
    // Submitting the selector cannot remove active teams.
    const validTeams = await getValidActiveTeams(ctx);
    const validTeamIds = validTeams.map((t) => t.id);

    await state.updatePm(pmId, { teamIds: validTeamIds });

    let prov = { rolesAdded: [], rolesRemoved: [], resources: [] };
    try {
      prov = await provisionPmWorkspace(ctx, pmId, { welcome: false, auditActorId: i.user.id });
    } catch (e) {
      log.warn(`workspace sync failed: ${e.message}`);
    }

    await audit.log({
      action: 'pm.teams_assigned',
      actorId: i.user.id,
      details: { pmId, teamIds: validTeamIds },
    });

    const teamNames = prov.resources?.length ? prov.resources.map((r) => r.name) : validTeams.map((t) => t.name);
    const activeTeamsSummary = teamNames.length > 15
      ? `${teamNames.slice(0, 15).join(', ')} ... (+${teamNames.length - 15} more)`
      : (teamNames.join(', ') || 'None');

    await i.editReply({
      content: null,
      embeds: [okEmbed(
        truncate(
          `Assigned team roles updated for **${pm.name}**.\n\n` +
          `• **Active Teams** (${validTeamIds.length} total): ${activeTeamsSummary}\n` +
          `• **Channels Synchronized**: Team text channels and resource visibility remain synchronized.`,
          3900
        ),
        'Teams Synchronized'
      )],
      components: [],
    });
  });

  router.button('pm:refresh', async (i, [pmId]) => {
    if (!(await panelOk(i, pmId))) return say(i, { embeds: [errEmbed('Not authorized.')] });
    const pm = await state.getPm(pmId);
    if (!pm?.repo) return say(i, { embeds: [errEmbed('Set a repository first.')] });
    await i.deferReply({ flags: 64 });
    try { await ctx.monitoring.refreshPm(pmId); await say(i, { embeds: [okEmbed('Team activity refreshed.')] }); }
    catch (e) { log.warn('manual refresh failed', e); await say(i, { embeds: [errEmbed('GitHub data could not be refreshed right now.')] }); }
  });
}
