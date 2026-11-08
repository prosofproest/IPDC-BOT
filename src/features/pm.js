import { ActionRowBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { fmtIST, parseRepoRef, truncate } from '../utils/misc.js';
import { makeActor } from '../core/auth.js';
import { say } from '../core/router.js';
import { button, embed, errEmbed, okEmbed, row } from '../ui.js';

const log = createLogger('pm');

export function pmPanelPayload(pm) {
  return {
    embeds: [embed({
      title: `PM CONTROL PANEL — ${pm.name}`,
      description: [
        'Private to the Project Manager and administrators. Incoming applications and change requests for your team appear in this channel for approval.',
        '',
        `Monitored repository: ${pm.repo ? `[${pm.repo.owner}/${pm.repo.name}](${pm.repo.url})` : 'not set'}`,
        'Your team works on one active repository at a time. GitHub access and permissions are managed by IPDC administrators.',
      ].join('\n'),
    })],
    components: [row(
      button(`pm:repo:${pm.id}`, 'SET REPOSITORY', ButtonStyle.Primary),
      button(`pm:team:${pm.id}`, 'TEAM OVERVIEW'),
      button(`pm:pending:${pm.id}`, 'PENDING REQUESTS'),
      button(`pm:refresh:${pm.id}`, 'REFRESH ACTIVITY'),
    )],
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

  router.button('pm:team', async (i, [pmId]) => {
    if (!(await panelOk(i, pmId))) return say(i, { embeds: [errEmbed('Not authorized.')] });
    const [pm, teams, members] = await Promise.all([state.getPm(pmId), state.teams(), state.membersOfPm(pmId)]);
    const byTeam = new Map(teams.map((t) => [t.id, []]));
    for (const m of members) (byTeam.get(m.teamId) || byTeam.set(m.teamId, []).get(m.teamId)).push(m);
    const lines = [...byTeam.entries()].filter(([, v]) => v.length).map(([tid, v]) => `**${teams.find((t) => t.id === tid)?.name || 'Unassigned'}** (${v.length})\n${v.map((m) => `<@${m.id}>${m.github?.username ? ` — [${m.github.username}](https://github.com/${m.github.username})` : ''}`).join('\n')}`);
    await say(i, { embeds: [embed({ title: `TEAM OVERVIEW — ${pm.name}`, description: truncate(lines.join('\n\n') || 'No approved members yet.', 3900) })] });
  });

  router.button('pm:pending', async (i, [pmId]) => {
    if (!(await panelOk(i, pmId))) return say(i, { embeds: [errEmbed('Not authorized.')] });
    const pending = (await store.where('requests', 'pmId', pmId)).filter((r) => r.status === 'pending');
    const g = ctx.cfg.discord.guildId;
    await say(i, { embeds: [embed({ title: 'PENDING REQUESTS', description: pending.map((r) => `• ${r.type.replace('_', ' ')} — <@${r.userId}> — [open](https://discord.com/channels/${g}/${r.ref?.channelId}/${r.ref?.messageId}) (${fmtIST(r.createdAt)})`).join('\n') || 'No pending requests.' })] });
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
