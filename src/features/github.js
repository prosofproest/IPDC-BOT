import { AttachmentBuilder, ButtonStyle } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { fmtIST, parseGithubUsername, truncate } from '../utils/misc.js';
import { makeActor } from '../core/auth.js';
import { say } from '../core/router.js';
import { embed, errEmbed, okEmbed } from '../ui.js';

const log = createLogger('github-ui');
const DAY = 86400000;

export function register(router, ctx) {
  const { state, store, auth, audit } = ctx;

  async function recentFor(userId, days = 14) {
    const m = await state.getMember(userId);
    if (!m?.github?.username) return { error: 'This member has not linked a GitHub account.' };
    const pm = m.pmId ? await state.getPm(m.pmId) : null;
    if (!pm?.repo) return { error: 'This member’s team has no monitored repository yet.', m };
    const data = await ctx.activity.collectPm(pm, { days });
    if (!data.ok) return { error: `GitHub data is unavailable (${data.error}).`, m };
    const commits = data.commits.filter((c) => c.userId === userId).slice(0, 10);
    const prs = data.pulls.filter((p) => p.userId === userId).slice(0, 5);
    return { m, pm, data, commits, prs, days };
  }

  const detailEmbed = (r, userId) => embed({
    title: 'RECENT GITHUB ACTIVITY',
    description: `<@${userId}> — [${r.m.github.username}](https://github.com/${r.m.github.username}) in ${r.data.repo}\nLast ${r.days} days`,
    fields: [
      { name: `Commits (${r.commits.length})`, value: truncate(r.commits.map((c) => `[\`${c.sha.slice(0, 7)}\`](${c.url}) ${truncate(c.message, 80)} — ${fmtIST(c.date)}`).join('\n') || 'None', 1000) },
      { name: `Pull Requests (${r.prs.length})`, value: truncate(r.prs.map((p) => `[#${p.number}](${p.url}) ${truncate(p.title, 70)} (${p.state})`).join('\n') || 'None', 1000) },
    ],
    footer: 'Activity counts are evidence of GitHub activity, not a productivity score.',
  });

  router.button('gh:mine', async (i) => {
    await i.deferReply({ flags: 64 });
    const r = await recentFor(i.user.id);
    if (r.error) return say(i, { embeds: [errEmbed(r.error)] });
    await say(i, { embeds: [detailEmbed(r, i.user.id)], allowedMentions: { parse: [] } });
  });

  router.select('gh:member', async (i) => {
    await i.deferReply({ flags: 64 });
    const r = await recentFor(i.values[0]);
    if (r.error) return say(i, { embeds: [errEmbed(r.error)] });
    await say(i, { embeds: [detailEmbed(r, i.values[0])], allowedMentions: { parse: [] } });
  });

  router.button('gh:browse', async (i, [p]) => {
    const page = Math.max(0, Number(p) || 0);
    const { cals } = await ctx.monitoring.loadStats();
    const members = (await state.members()).filter((m) => m.github?.username && m.status === 'approved');
    const payload = await ctx.monitoring.heatmapPayload(cals, members, { page, per: 8, ephemeral: true });
    delete payload.hashExtra;
    if (i.message?.flags?.has?.(64)) return i.update({ ...payload, attachments: [] });
    await i.deferReply({ flags: 64 });
    return i.editReply(payload);
  });

  // ---- slash command: /ipdc ----
  router.command('ipdc', async (i) => {
    const sub = i.options.getSubcommand();
    if (sub === 'help') {
      return say(i, { embeds: [embed({ title: 'IPDC BOT', description: '`/ipdc status` — your roles, PM, team and GitHub link\n`/ipdc link-github` — link or update your GitHub profile\n`/ipdc reconcile` — repair server structure (IPDC GRID only)\n\nUse #support-center for tickets and role changes.' })] });
    }
    if (sub === 'status') {
      const m = await state.getMember(i.user.id);
      const [pm, team] = await Promise.all([m?.pmId ? state.getPm(m.pmId) : null, m?.teamId ? state.getTeam(m.teamId) : null]);
      return say(i, { embeds: [embed({ title: 'YOUR IPDC STATUS', fields: [
        { name: 'Status', value: m?.status || 'not onboarded', inline: true }, { name: 'PM', value: pm?.name || 'none', inline: true }, { name: 'Team Role', value: team?.name || 'none', inline: true },
        { name: 'GitHub', value: m?.github?.username ? `[${m.github.username}](https://github.com/${m.github.username})` : 'not linked' }] })] });
    }
    if (sub === 'link-github') {
      await i.deferReply({ flags: 64 });
      const m = await state.getMember(i.user.id);
      if (!m || m.status !== 'approved') return say(i, { embeds: [errEmbed('Only approved members can update their GitHub link. New members add it during the role application.')] });
      const username = parseGithubUsername(i.options.getString('url', true));
      if (!username) return say(i, { embeds: [errEmbed('Enter a profile URL like https://github.com/your-username')] });
      const info = await ctx.github.verifyUser(username).catch(() => null);
      if (!info) return say(i, { embeds: [errEmbed('That GitHub profile could not be verified.')] });
      try { await state.linkGithub(i.user.id, info.login); } catch (e) { return say(i, { embeds: [errEmbed(e.message)] }); }
      await audit.log({ action: 'github.linked', actorId: i.user.id, details: { username: info.login } });
      return say(i, { embeds: [okEmbed(`Linked to GitHub user **${info.login}**.`)] });
    }
    if (sub === 'reconcile') {
      if (!(await auth.can('admin.panel', makeActor(i.member, i.user.id)))) { await audit.log({ action: 'authz.denied', actorId: i.user.id, level: 'warn', details: { cmd: 'reconcile' } }); return say(i, { embeds: [errEmbed('Restricted to the IPDC GRID role.', 'Not Authorized')] }); }
      await i.deferReply({ flags: 64 });
      const r = await ctx.reconciler.run('slash-command');
      return say(i, { embeds: [okEmbed(r.skipped ? 'Another reconciliation is running.' : `Reused ${r.reused}, adopted ${r.adopted}, created ${r.created}, repaired ${r.repaired}, errors ${r.errors.length}. Nothing was deleted.`, 'Reconciliation')] });
    }
  });
}

export const slashCommands = [{
  name: 'ipdc', description: 'IPDC bot commands',
  options: [
    { type: 1, name: 'help', description: 'Show what the bot can do' },
    { type: 1, name: 'status', description: 'Show your IPDC status' },
    { type: 1, name: 'link-github', description: 'Link or update your GitHub profile', options: [{ type: 3, name: 'url', description: 'https://github.com/your-username', required: true }] },
    { type: 1, name: 'reconcile', description: 'Repair server structure (IPDC GRID only)' },
  ],
}];
void AttachmentBuilder; void ButtonStyle; void log; void DAY;
