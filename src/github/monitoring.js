import { AttachmentBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { dayKeyIST, fmtIST, mapLimit, sha, truncate } from '../utils/misc.js';
import { KEYS } from '../core/structure.js';
import { BRAND } from '../config/constants.js';
import { bar, button, embed, row } from '../ui.js';
import { Activity } from './activity.js';
import { renderHeatmaps } from './render.js';
import { pmGithubActivityIntroPayload } from '../core/workspace.js';

const log = createLogger('monitoring');
const DAY = 86400000;
const NOTE = 'Activity counts are evidence of GitHub activity, not a definitive productivity score.';

export class Monitoring {
  constructor(ctx) { this.ctx = ctx; this.running = null; this.debounce = new Map(); this.lastRun = null; this.reportStatus = new Map(); }
  get c() { return this.ctx; }

  // ------------------------------------------------------------------ data
  async loadCalendars(members, weeks, snapshots) {
    const out = new Map(); const from = new Date(Date.now() - (weeks * 7 + 7) * DAY).toISOString(); const to = new Date().toISOString();
    const commitsByUser = new Map();
    for (const d of snapshots) if (d.ok) for (const c of d.commits) if (c.userId) (commitsByUser.get(c.userId) || commitsByUser.set(c.userId, []).get(c.userId)).push(c);
    await mapLimit(members, 4, async (m) => {
      const username = m.github.username;
      try {
        const cal = await this.c.github.contributionCalendar(username, from, to);
        out.set(m.id, { username, source: 'github', total: cal.total, counts: new Map(cal.days.filter((d) => d.count > 0).map((d) => [d.date, d.count])) });
      } catch (e) {
        const list = commitsByUser.get(m.id) || [];
        const counts = Activity.dayCountsFromCommits(list.map((x) => ({ ...x, userId: m.id })), m.id);
        out.set(m.id, { username, source: 'repo', total: list.length, counts });
        log.debug(`calendar fallback for member (${e.message})`);
      }
    });
    return out;
  }

  async saveStats(cals) {
    const members = {};
    for (const [id, v] of cals) members[id] = { username: v.username, source: v.source, total: v.total, days: Object.fromEntries(v.counts) };
    await this.c.store.set('stats', 'heatmap', { updatedAt: Date.now(), members });
  }
  async loadStats() {
    const s = await this.c.store.get('stats', 'heatmap'); const out = new Map();
    for (const [id, v] of Object.entries(s?.members || {})) out.set(id, { ...v, counts: new Map(Object.entries(v.days || {})) });
    return { updatedAt: s?.updatedAt || null, cals: out };
  }

  async names(ids) {
    const g = this.c.client.guilds.cache.get(this.c.cfg.discord.guildId); const out = new Map();
    try { if (ids.length) await g.members.fetch({ user: ids }); } catch { /* partial ok */ }
    for (const id of ids) out.set(id, g.members.cache.get(id)?.displayName || id);
    return out;
  }

  windowTotal(cal, days) {
    const cut = dayKeyIST(new Date(Date.now() - days * DAY)); let t = 0;
    for (const [d, n] of cal.counts) if (d >= cut) t += n; return t;
  }

  // ------------------------------------------------------------------ payload builders
  async heatmapPayload(cals, members, { page = 0, per = null, ephemeral = false } = {}) {
    const s = await this.c.state.settings(); const per_ = per ?? s.maxHeatmapMembersInline;
    const names = await this.names(members.map((m) => m.id));
    const ranked = members.filter((m) => cals.has(m.id)).sort((a, b) => cals.get(b.id).total - cals.get(a.id).total);
    const slice = ranked.slice(page * per_, page * per_ + per_);
    const rows = slice.map((m) => ({ label: names.get(m.id), sub: `github.com/${m.github.username}`, total: cals.get(m.id).total, counts: cals.get(m.id).counts }));
    const png = renderHeatmaps(rows, { weeks: s.heatmapWeeks, note: NOTE });
    const file = new AttachmentBuilder(png, { name: 'heatmaps.png' });
    const pages = Math.max(1, Math.ceil(ranked.length / per_));
    const e = embed({ title: 'GITHUB CONTRIBUTION HEATMAPS', description: `${ranked.length} registered member${ranked.length === 1 ? '' : 's'}${ephemeral ? ` — page ${page + 1} of ${pages}` : pages > 1 ? ` — showing top ${per_}; use Browse Members for everyone` : ''}\nUpdated ${fmtIST(Date.now())} (refreshed daily at 9:00 PM IST)`, color: BRAND.accent, footer: NOTE });
    e.setImage('attachment://heatmaps.png');
    const mem = new UserSelectMenuBuilder().setCustomId('gh:member').setPlaceholder('View a member’s recent commits');
    const components = ephemeral
      ? [row(button(`gh:browse:${page - 1}`, 'PREVIOUS', ButtonStyle.Secondary, page <= 0), button(`gh:browse:${page + 1}`, 'NEXT', ButtonStyle.Secondary, page >= pages - 1))]
      : [row(button('gh:browse:0', 'BROWSE MEMBERS', ButtonStyle.Primary), button('gh:mine', 'MY RECENT ACTIVITY')), row(mem)];
    return { embeds: [e], files: [file], components, hashExtra: sha(png) };
  }

  leaderboardPayload(cals, members, names, days) {
    const ranked = members.filter((m) => cals.has(m.id)).map((m) => ({ m, n: this.windowTotal(cals.get(m.id), days), src: cals.get(m.id).source }))
      .sort((a, b) => b.n - a.n).slice(0, 15);
    const max = ranked[0]?.n || 0;
    const lines = ranked.map((r, i) => `**${i + 1}.** <@${r.m.id}> — ${r.n} \`${bar(r.n, max, 10)}\``);
    return { embeds: [embed({ title: `CONTRIBUTION LEADERBOARD — LAST ${days} DAYS`, color: BRAND.accent, description: truncate(lines.join('\n') || 'No linked GitHub activity yet.', 3800) + `\n\nUpdated ${fmtIST(Date.now())}`, footer: NOTE })], allowedMentions: { parse: [] } };
  }

  async serverActivityPayload(snaps, aiLine) {
    const rows = snaps.map((d) => ({ d, s: Activity.summarize(d) }));
    const max = Math.max(1, ...rows.filter((r) => r.s.ok).map((r) => r.s.commits7));
    const fields = rows.map(({ d, s }) => ({ name: d.pmName, value: s.ok ? `\`${bar(s.commits7, max)}\` ${s.commits7} commits (7d)\nPRs merged (7d): ${s.prsMerged7} | open: ${s.prsOpen} | active branches: ${s.activeBranches7}` : `Monitoring unavailable: ${s.error}` }));
    const total = rows.reduce((a, r) => a + (r.s.ok ? r.s.commits7 : 0), 0);
    const e = embed({ title: 'SERVER ACTIVITY', color: BRAND.accent, description: `${snaps.length} PM team${snaps.length === 1 ? '' : 's'} — ${total} commits across all monitored repositories in the last 7 days.${aiLine ? `\n\n${aiLine}` : ''}\n\nUpdated ${fmtIST(Date.now())}`, fields: fields.slice(0, 24), footer: NOTE });
    return { embeds: [e] };
  }

  async pmActivityPayload(pm, data, members, aiLine) {
    const s = Activity.summarize(data);
    const rep = this.reportStatus.get(pm.id) || (await this.c.store.get('reportStatus', pm.id));
    if (!s.ok) {
      if (!pm.repo) return pmGithubActivityIntroPayload(pm, this.c.cfg?.github);
      return {
        embeds: [embed({
          title: `GITHUB ACTIVITY — ${pm.name}`,
          color: BRAND.color,
          description: `Repository: [${pm.repo.owner}/${pm.repo.name}](${pm.repo.url || `https://github.com/${pm.repo.owner}/${pm.repo.name}`})\n\n⚠️ Activity collection status: **${s.error}**\n\n` +
            '• The bot attempted to collect commits and PRs for this repository.\n' +
            '• Ensure the IPDC GitHub App has read permissions (Contents, Metadata, Pull Requests) on this repository.\n' +
            '• Refreshed daily at 9:00 PM IST or manually by clicking **REFRESH ACTIVITY** in the PM Control Panel.',
          footer: NOTE,
        })],
      };
    }
    const top = [...s.perMember.values()].sort((a, b) => b.commits7 - a.commits7).slice(0, 8)
      .map((m) => `${m.userId ? `<@${m.userId}>` : m.login} — ${m.commits7} (7d)`);
    const recent = data.commits.slice(0, 6).map((c) => `[\`${c.sha.slice(0, 7)}\`](${c.url}) ${truncate(c.message, 70)}`);
    const e = embed({ title: `GITHUB ACTIVITY — ${pm.name}`, color: BRAND.accent, description: `Repository: [${data.repo}](https://github.com/${data.repo})${aiLine ? `\n\n${aiLine}` : ''}`, footer: NOTE, fields: [
      { name: 'Commits', value: `24h: ${s.commits24}\n7d: ${s.commits7}`, inline: true }, { name: 'Pull Requests', value: `Open: ${s.prsOpen}\nMerged (7d): ${s.prsMerged7}`, inline: true }, { name: 'Branches', value: `Total: ${s.branches}\nActive (7d): ${s.activeBranches7}`, inline: true },
      { name: 'Contributors (7 days)', value: top.join('\n') || 'No commits in the last 7 days.' }, { name: 'Latest Commits', value: recent.join('\n') || 'None' },
      { name: 'Daily Report', value: rep ? `${rep.status.toUpperCase()} — ${fmtIST(rep.at)}${rep.error ? `\n${truncate(rep.error, 120)}` : ''}` : 'Sent daily at 9:00 PM IST' },
    ] });
    e.setTimestamp();
    return { embeds: [e], allowedMentions: { parse: [] } };
  }

  async monitoringPayloads(snaps, cals) {
    const pms = await this.c.state.pms(); const settings = await this.c.state.settings();
    const [reqs, tickets] = await Promise.all([this.c.store.list('requests'), this.c.store.list('tickets')]);
    const embeds = [];
    for (const pm of pms) {
      const d = snaps.find((x) => x.pmId === pm.id) || { ok: false, error: 'not collected yet', commits: [] };
      const members = await this.c.state.membersOfPm(pm.id); const s = Activity.summarize(d);
      const last = d.ok ? Activity.lastActivity(d) : new Map();
      const inactive = members.filter((m) => this.isInactive(m, last, cals, settings.inactivityDays));
      embeds.push(embed({ title: `PM TEAM — ${pm.name}`, footer: NOTE, fields: [
        { name: 'PM', value: `<@${pm.discordUserId}>`, inline: true }, { name: 'Members', value: String(members.length), inline: true }, { name: 'Repository', value: d.repo ? `[${d.repo}](https://github.com/${d.repo})` : 'not set', inline: true },
        { name: 'Activity', value: s.ok ? `Commits 24h/7d: ${s.commits24}/${s.commits7}\nBranches: ${s.branches} (${s.activeBranches7} active)\nPRs open/merged 7d: ${s.prsOpen}/${s.prsMerged7}` : `Unavailable: ${s.error}` },
        { name: `Inactive > ${settings.inactivityDays} days (${inactive.length})`, value: truncate(inactive.map((m) => `<@${m.id}>`).join(' ') || 'None', 900) },
        { name: 'Pending', value: `Applications: ${reqs.filter((r) => r.status === 'pending' && r.pmId === pm.id).length}`, inline: true },
      ] }));
    }
    const g = embed({ title: 'SERVER MONITORING — HEALTH', color: BRAND.accent, description: `Updated ${fmtIST(Date.now())}`, fields: [
      { name: 'Pending Requests', value: String(reqs.filter((r) => r.status === 'pending').length), inline: true }, { name: 'Open Tickets', value: String(tickets.filter((t) => t.status !== 'closed').length), inline: true },
      { name: 'Linked GitHub Members', value: String(cals.size), inline: true }, { name: 'Health', value: this.c.health.snapshot() },
    ], footer: 'Privileged view: IPDC GRID only' });
    return [g, ...embeds];
  }

  isInactive(member, lastByUser, cals, days) {
    if (!member.github?.username) return false;
    let last = lastByUser.get(member.id) || 0;
    const cal = cals.get(member.id);
    if (cal) for (const d of cal.counts.keys()) last = Math.max(last, new Date(`${d}T12:00:00Z`).getTime());
    const since = member.approvedAt || 0;
    return Date.now() - Math.max(last, since) > days * DAY;
  }

  // ------------------------------------------------------------------ publishing
  async aiLine(key, data) {
    try {
      const s = Activity.summarize(data); if (!s.ok || !s.commits7) return null;
      const dayKey = `${key}:${dayKeyIST()}`;
      const cached = await this.c.store.get('aiSummaries', dayKey.replace(/[:/]/g, '_')); if (cached) return cached.text;
      const r = await this.c.ai.summarizeActivity({ repo: data.repo, days: 7, commits: s.commits7, prs: s.prs7, subjects: Activity.within(data.commits, 'date', 7 * DAY).map((c) => c.message) });
      if (!r.text) return null;
      const text = truncate(r.text, 600); await this.c.store.set('aiSummaries', dayKey.replace(/[:/]/g, '_'), { text, provider: r.provider, at: Date.now() }); return text;
    } catch (e) { log.warn('ai line failed', e); return null; }
  }

  async publish(snaps, cals, { pmIds } = {}) {
    const { messages, state } = this.c; const members = (await state.members()).filter((m) => m.github?.username && m.status === 'approved');
    const s = await state.settings(); const names = await this.names(members.map((m) => m.id));
    if (!pmIds) {
      await messages.ensure('dash:heatmap', 'ch:github-contributions', await this.heatmapPayload(cals, members));
      await messages.ensure('dash:leaderboard', 'ch:contribution-leaderboard', this.leaderboardPayload(cals, members, names, s.leaderboardDays));
    }
    const ai = snaps.length ? await this.aiLine('server', { ok: true, repo: 'all PM repositories', commits: snaps.flatMap((d) => (d.ok ? d.commits : [])), pulls: snaps.flatMap((d) => (d.ok ? d.pulls : [])) }) : null;
    await messages.ensure('dash:server-activity', 'ch:server-activity', await this.serverActivityPayload(snaps, ai));
    const pms = await state.pms();
    for (const pm of pms.filter((p) => !pmIds || pmIds.includes(p.id))) {
      const d = snaps.find((x) => x.pmId === pm.id); if (!d) continue;
      const line = await this.aiLine(`pm_${pm.id}`, d);
      await messages.ensure(`pm:${pm.id}:dash`, KEYS.pmActivity(pm.id), await this.pmActivityPayload(pm, d, members, line));
    }
    const embeds = await this.monitoringPayloads(snaps, cals);
    for (let i = 0, n = 0; i < Math.max(embeds.length, (await this.monitoringMsgCount())); i += 10, n++) {
      const chunk = embeds.slice(i, i + 10);
      await messages.ensure(`dash:monitoring:${n}`, 'ch:server-monitoring', { embeds: chunk.length ? chunk : [embed({ title: 'SERVER MONITORING', description: 'No additional data.' })], allowedMentions: { parse: [] } });
    }
    await this.c.store.set('config', 'monitoringCount', { n: Math.ceil(embeds.length / 10) });
  }
  async monitoringMsgCount() { return ((await this.c.store.get('config', 'monitoringCount'))?.n || 0) * 10; }

  // ------------------------------------------------------------------ orchestration
  async refreshAll({ scheduled = false } = {}) {
    if (this.running) return this.running;
    this.running = this._refreshAll(scheduled).finally(() => { this.running = null; });
    return this.running;
  }

  async _refreshAll(scheduled) {
    const t0 = Date.now();
    try {
      const { state, store } = this.c; const s = await state.settings();
      const members = (await state.members()).filter((m) => m.github?.username && m.status === 'approved');
      const snaps = await this.c.activity.collectAll();
      const cals = this.c.github.enabled ? await this.loadCalendars(members, s.heatmapWeeks, snaps) : new Map();
      await this.saveStats(cals);
      await this.publish(snaps, cals);
      if (scheduled) { await this.inactivityAlerts(snaps, cals, s); await this.c.reports.runAll(snaps); }
      await store.set('jobs', 'daily', { lastRunAt: Date.now(), scheduled, ms: Date.now() - t0 });
      this.lastRun = Date.now(); this.c.health.record('job:refresh', true, `${Math.round((Date.now() - t0) / 1000)}s`);
      log.info(`refresh complete in ${Date.now() - t0}ms (${snaps.length} PMs, ${members.length} members)`);
    } catch (e) { this.c.health.record('job:refresh', false, e.message); log.error('refresh failed', e); throw e; }
  }

  async refreshPm(pmId) {
    const pm = await this.c.state.getPm(pmId); if (!pm) return;
    const d = await this.c.activity.collectPm(pm);
    const { cals } = await this.loadStats();
    const snaps = [...this.c.activity.snapshot.values()];
    await this.publish(snaps, cals, { pmIds: [pmId] });
    return d;
  }

  /** Webhook-driven near-live refresh, debounced per PM. */
  scheduleRefreshPm(pmId, ms = 20_000) {
    clearTimeout(this.debounce.get(pmId));
    this.debounce.set(pmId, setTimeout(() => this.refreshPm(pmId).catch((e) => log.warn('webhook refresh failed', e)), ms));
  }

  /** Alerts go to the PM's private control channel (never public) and only when the set changes. */
  async inactivityAlerts(snaps, cals, settings) {
    for (const pm of await this.c.state.pms()) {
      const d = snaps.find((x) => x.pmId === pm.id); if (!d?.ok) continue;
      const members = await this.c.state.membersOfPm(pm.id); const last = Activity.lastActivity(d);
      const inactive = members.filter((m) => this.isInactive(m, last, cals, settings.inactivityDays)).map((m) => m.id);
      const prev = (await this.c.store.get('alerts', pm.id)) || { ids: [], at: 0 };
      const fresh = inactive.filter((id) => !prev.ids.includes(id));
      if (!inactive.length) { if (prev.ids.length) await this.c.store.set('alerts', pm.id, { ids: [], at: Date.now() }); continue; }
      if (!fresh.length && Date.now() - prev.at < 7 * DAY) continue;
      const ch = await this.c.messages.channelFor(KEYS.pmControl(pm.id));
      if (!ch) { log.warn(`inactivity alert channel unavailable for PM ${pm.name}`); continue; }
      try {
        await ch.send({ embeds: [embed({ title: 'INACTIVITY NOTICE', description: `No GitHub activity from these team members in the last ${settings.inactivityDays} days:\n${inactive.map((id) => `<@${id}>`).join(' ')}\n\nThis is a private check-in prompt for the PM, not a performance judgement. Members may be working offline, on other branches, or on non-code tasks.`, footer: NOTE })], allowedMentions: { users: [pm.discordUserId] } });
        await this.c.store.set('alerts', pm.id, { ids: inactive, at: Date.now() });
        await this.c.audit.log({ action: 'monitoring.inactivity_alert', details: { pmId: pm.id, count: inactive.length } });
      } catch (e) {
        log.warn(`alert post failed for PM ${pm.name}`, e);
      }
    }
  }
}
