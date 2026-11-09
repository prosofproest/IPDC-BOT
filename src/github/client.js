import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createLogger } from '../utils/logger.js';
import { mapLimit, sleep } from '../utils/misc.js';

const log = createLogger('github');

/**
 * Read-only GitHub access. Uses a GitHub App installation (preferred) or a read-only fine-grained token.
 * Without credentials only public profile lookups work (low rate limit) and monitoring is disabled.
 */
export class GitHubClient {
  constructor(cfg = {}) {
    this.cfg = cfg; this.enabled = !!cfg.enabled; this.cache = new Map();
    this.health = { lastOkAt: null, lastError: null, rateRemaining: null, rateResetAt: null, calls: 0, errors: 0 };
    const requestOptions = { timeout: 10_000 };
    if (this.enabled && cfg.appId && cfg.privateKey && cfg.installationId) {
      this.mode = 'app';
      this.octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId: cfg.appId, privateKey: cfg.privateKey, installationId: cfg.installationId }, userAgent: 'ipdc-discord-bot', request: requestOptions });
    } else if (this.enabled && cfg.token) {
      this.mode = 'token';
      this.octokit = new Octokit({ auth: cfg.token, userAgent: 'ipdc-discord-bot', request: requestOptions });
    } else {
      this.mode = 'public';
      this.octokit = new Octokit({ userAgent: 'ipdc-discord-bot', request: requestOptions });
    }
    this.octokit.hook.after('request', (res) => {
      this.health.calls++; this.health.lastOkAt = Date.now();
      const h = res.headers || {};
      if (h['x-ratelimit-remaining'] !== undefined) { this.health.rateRemaining = Number(h['x-ratelimit-remaining']); this.health.rateResetAt = Number(h['x-ratelimit-reset']) * 1000; }
    });
    this.octokit.hook.error('request', (err) => { this.health.errors++; this.health.lastError = `${err.status || ''} ${String(err.message).slice(0, 120)}`; throw err; });
  }

  async _call(fn, { attempts = 3 } = {}) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        const retryAfter = Number(e.response?.headers?.['retry-after']);
        const limited = (e.status === 403 || e.status === 429) && (retryAfter || /rate limit/i.test(e.message));
        if (limited && i < attempts - 1) { await sleep(Math.min(30_000, (retryAfter || 2 ** i * 2) * 1000)); continue; }
        const transient = !e.status || e.status >= 500 || e.code === 'ETIMEDOUT' || e.name === 'AbortError';
        if (transient && i < attempts - 1) { await sleep(500 * 2 ** i); continue; }
        break;
      }
    }
    throw last;
  }

  /** Drop cached data for a repository (called on webhook events so refreshes see new commits). */
  invalidate(owner, name) {
    const needle = `${owner}/${name}`.toLowerCase();
    for (const k of this.cache.keys()) if (k.toLowerCase().includes(needle)) this.cache.delete(k);
  }

  async _cached(key, ttlMs, fn) {
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    const v = await fn(); this.cache.set(key, { v, exp: Date.now() + ttlMs });
    if (this.cache.size > 500) for (const [k, x] of this.cache) if (x.exp < Date.now()) this.cache.delete(k);
    return v;
  }

  /** Verify a GitHub user profile exists. Returns normalized info or null when not found. */
  async verifyUser(username) {
    try {
      const { data } = await this._call(() => this.octokit.users.getByUsername({ username }));
      if (data.type !== 'User') return null;
      return { login: data.login, id: data.id, url: data.html_url, avatar: data.avatar_url, createdAt: data.created_at };
    } catch (e) {
      if (e.status === 404) return null;
      // If authenticated lookup failed with an auth/permission or server error, fallback to public lookup
      if (this.mode !== 'public' && (e.status === 401 || e.status === 403 || !e.status || e.status >= 500)) {
        log.warn(`GitHub profile lookup for "${username}" failed (${e.status || e.code || e.message}) in ${this.mode} mode, falling back to public lookup`);
        try {
          const publicOctokit = new Octokit({ userAgent: 'ipdc-discord-bot', request: { timeout: 10_000 } });
          const { data } = await publicOctokit.users.getByUsername({ username });
          if (data.type !== 'User') return null;
          return { login: data.login, id: data.id, url: data.html_url, avatar: data.avatar_url, createdAt: data.created_at };
        } catch (pubErr) {
          if (pubErr.status === 404) return null;
          throw pubErr;
        }
      }
      throw e;
    }
  }

  async getRepo(owner, name) {
    const { data } = await this._call(() => this.octokit.repos.get({ owner, repo: name }));
    return { owner: data.owner.login, name: data.name, fullName: data.full_name, defaultBranch: data.default_branch, private: data.private, url: data.html_url, archived: data.archived };
  }

  async listBranches(owner, name, max = 30) {
    return this._cached(`br:${owner}/${name}`, 60_000, async () => {
      const items = await this._call(() => this.octokit.paginate(this.octokit.repos.listBranches, { owner, repo: name, per_page: 100 }, (r) => r.data));
      return items.slice(0, max).map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected }));
    });
  }

  /** Commits across all branches since a date, de-duplicated by SHA, each tagged with its branches. */
  async listCommits({ owner, name, since, until, maxBranches = 20, maxPerBranch = 300 }) {
    const key = `cm:${owner}/${name}:${since}:${until || ''}`;
    return this._cached(key, 60_000, async () => {
      const branches = await this.listBranches(owner, name, maxBranches);
      const bySha = new Map();
      await mapLimit(branches, 4, async (b) => {
        let items = [];
        try {
          items = await this._call(() => this.octokit.paginate(this.octokit.repos.listCommits,
            { owner, repo: name, sha: b.name, since, until, per_page: 100 }, (r) => r.data));
        } catch (e) { log.warn(`commits failed for ${owner}/${name}@${b.name}`, e); return; }
        for (const c of items.slice(0, maxPerBranch)) {
          const cur = bySha.get(c.sha);
          if (cur) { cur.branches.push(b.name); continue; }
          bySha.set(c.sha, {
            sha: c.sha, message: (c.commit.message || '').split('\n')[0], url: c.html_url,
            authorLogin: c.author?.login || null, authorName: c.commit.author?.name || null,
            date: c.commit.author?.date || c.commit.committer?.date, parents: c.parents?.length || 0, branches: [b.name],
          });
        }
      });
      return [...bySha.values()].sort((a, b) => new Date(b.date) - new Date(a.date));
    });
  }

  async listPulls({ owner, name, since }) {
    return this._cached(`pr:${owner}/${name}:${since}`, 60_000, async () => {
      const out = [];
      const iter = this.octokit.paginate.iterator(this.octokit.pulls.list, { owner, repo: name, state: 'all', sort: 'updated', direction: 'desc', per_page: 50 });
      for await (const page of iter) {
        let stop = false;
        for (const p of page.data) {
          if (new Date(p.updated_at) < new Date(since)) { stop = true; break; }
          out.push({ number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, author: p.user?.login, url: p.html_url, createdAt: p.created_at, updatedAt: p.updated_at, mergedAt: p.merged_at, head: p.head?.ref, base: p.base?.ref });
        }
        if (stop || out.length >= 200) break;
      }
      return out;
    });
  }

  async commitDetail(owner, name, sha) {
    return this._cached(`cd:${owner}/${name}:${sha}`, 10 * 60_000, async () => {
      const { data } = await this._call(() => this.octokit.repos.getCommit({ owner, repo: name, ref: sha }));
      return {
        additions: data.stats?.additions ?? 0, deletions: data.stats?.deletions ?? 0, total: data.stats?.total ?? 0,
        files: (data.files || []).slice(0, 25).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
        filesTotal: (data.files || []).length,
      };
    });
  }

  /** Public contribution calendar for a user (GraphQL). Returns { total, days:[{date,count}] }. */
  async contributionCalendar(username, from, to) {
    return this._cached(`cal:${username}:${from}`, 5 * 60_000, async () => {
      const q = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}`;
      const res = await this._call(() => this.octokit.graphql(q, { login: username, from, to }));
      const cal = res.user?.contributionsCollection?.contributionCalendar;
      if (!cal) throw new Error('calendar unavailable');
      const days = cal.weeks.flatMap((w) => w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount })));
      return { total: cal.totalContributions, days };
    });
  }
}
