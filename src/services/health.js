import { fmtIST } from '../utils/misc.js';

// Aggregates monitoring health for the Admin dashboard and #server-monitoring.
export class Health {
  constructor() { this.items = new Map(); this.startedAt = Date.now(); this.github = null; this.queue = null; }
  record(name, ok, detail = '') { this.items.set(name, { ok, detail: String(detail).slice(0, 160), at: Date.now() }); }
  get(name) { return this.items.get(name) || null; }
  snapshot() {
    const lines = [];
    for (const [n, v] of [...this.items.entries()].sort()) lines.push(`${v.ok ? 'OK' : 'FAIL'} ${n}${v.detail ? ` (${v.detail})` : ''} — ${fmtIST(v.at)}`);
    const g = this.github?.health;
    if (g) lines.push(`GitHub API: ${g.rateRemaining ?? 'n/a'} requests left${g.lastError ? `, last error: ${g.lastError}` : ''}`);
    lines.push(`Uptime: ${Math.round((Date.now() - this.startedAt) / 60000)} min`);
    return lines.join('\n').slice(0, 1000);
  }
}
