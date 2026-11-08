import { createLogger } from '../utils/logger.js';
import { dayKeyIST, mapLimit } from '../utils/misc.js';

const log = createLogger('activity');
const DAY = 86400000;

/**
 * Collects real GitHub data per PM repository and maps it to linked Discord members.
 * Counts are evidence of GitHub activity, not a productivity score.
 */
export class Activity {
  constructor({ github, state, store, health }) { this.github = github; this.state = state; this.store = store; this.health = health; this.snapshot = new Map(); }

  async windowDays() {
    const s = await state_settings(this.state);
    return Math.min(180, Math.max(s.inactivityDays, s.leaderboardDays, s.heatmapWeeks * 7, 14));
  }

  async linkMap() {
    const m = new Map();
    for (const mem of await this.state.members()) if (mem.github?.username && mem.status === 'approved') m.set(mem.github.username.toLowerCase(), mem.id);
    return m;
  }

  async collectPm(pm, { days, links } = {}) {
    const out = { pmId: pm.id, pmName: pm.name, ok: false, repo: pm.repo ? `${pm.repo.owner}/${pm.repo.name}` : null, at: Date.now() };
    if (!pm.repo) { out.error = 'repository not set'; return out; }
    if (!this.github.enabled) { out.error = 'GitHub not configured'; return out; }
    days ??= await this.windowDays(); links ??= await this.linkMap();
    const since = new Date(Date.now() - days * DAY).toISOString();
    try {
      const { owner, name } = pm.repo;
      const [commits, branches, pulls] = await Promise.all([
        this.github.listCommits({ owner, name, since }), this.github.listBranches(owner, name), this.github.listPulls({ owner, name, since }),
      ]);
      for (const c of commits) c.userId = c.authorLogin ? links.get(c.authorLogin.toLowerCase()) || null : null;
      for (const p of pulls) p.userId = p.author ? links.get(p.author.toLowerCase()) || null : null;
      Object.assign(out, { ok: true, since, days, commits, branches, pulls });
      this.health?.record(`github:${pm.slug}`, true);
    } catch (e) {
      out.error = e.status === 404 ? 'repository not accessible to the GitHub App' : e.message;
      this.health?.record(`github:${pm.slug}`, false, out.error);
      log.warn(`collect failed for ${pm.name}`, e);
    }
    this.snapshot.set(pm.id, out);
    return out;
  }

  async collectAll() {
    const [pms, links, days] = await Promise.all([this.state.pms(), this.linkMap(), this.windowDays()]);
    const res = await mapLimit(pms, 2, (pm) => this.collectPm(pm, { days, links }));
    return res;
  }

  static within(items, field, ms, now = Date.now()) { return items.filter((x) => now - new Date(x[field]).getTime() <= ms); }

  /** Summaries used by dashboards. */
  static summarize(data, { now = Date.now() } = {}) {
    if (!data.ok) return { ok: false, error: data.error };
    const c24 = Activity.within(data.commits, 'date', DAY, now); const c7 = Activity.within(data.commits, 'date', 7 * DAY, now);
    const p7 = data.pulls.filter((p) => now - new Date(p.updatedAt).getTime() <= 7 * DAY);
    const perMember = new Map();
    for (const c of data.commits) {
      const k = c.userId || `ext:${(c.authorLogin || c.authorName || 'unknown').toLowerCase()}`;
      const cur = perMember.get(k) || { userId: c.userId, login: c.authorLogin || c.authorName, commits: 0, commits7: 0, last: 0 };
      cur.commits++; if (now - new Date(c.date) <= 7 * DAY) cur.commits7++;
      cur.last = Math.max(cur.last, new Date(c.date).getTime()); perMember.set(k, cur);
    }
    return {
      ok: true, commits24: c24.length, commits7: c7.length, commitsAll: data.commits.length,
      prsOpen: data.pulls.filter((p) => p.state === 'open').length, prsMerged7: p7.filter((p) => p.state === 'merged').length, prs7: p7.length,
      branches: data.branches.length, activeBranches7: new Set(c7.flatMap((c) => c.branches)).size, perMember,
    };
  }

  /** last activity (ms) per member for a PM from repo commits. */
  static lastActivity(data) {
    const m = new Map();
    for (const c of data.commits || []) if (c.userId) m.set(c.userId, Math.max(m.get(c.userId) || 0, new Date(c.date).getTime()));
    return m;
  }

  /** Daily contribution counts for a member from repo commits (fallback heatmap source). */
  static dayCountsFromCommits(commits, userId) {
    const d = new Map();
    for (const c of commits) if (c.userId === userId) { const k = dayKeyIST(new Date(c.date)); d.set(k, (d.get(k) || 0) + 1); }
    return d;
  }
}

async function state_settings(state) { return state.settings(); }
