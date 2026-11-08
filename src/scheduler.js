import cron from 'node-cron';
import { createLogger } from './utils/logger.js';

const log = createLogger('scheduler');

/** Most recent 9:00 PM IST slot (15:30 UTC) at or before `now`. */
export function lastNinePmIst(now = new Date()) {
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 15, 30, 0));
  if (slot > now) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot.getTime();
}

export class Scheduler {
  constructor(ctx) { this.ctx = ctx; this.tasks = []; }
  start() {
    // Timezone-aware: 21:00 Asia/Kolkata every day (heatmap edit, leaderboard, dashboards, PDF reports, alerts).
    this.tasks.push(cron.schedule('0 21 * * *', () => {
      log.info('daily 9 PM IST job starting');
      this.ctx.monitoring.refreshAll({ scheduled: true }).catch((e) => log.error('daily job failed', e));
    }, { timezone: 'Asia/Kolkata' }));
    log.info('scheduler started (daily 21:00 Asia/Kolkata)');
  }
  /** After a restart/downtime, run a missed 9 PM job once (never duplicates messages: they are edited). */
  async catchUp() {
    if (!this.ctx.github.enabled) return false;
    const last = (await this.ctx.store.get('jobs', 'daily'))?.lastRunAt || 0;
    if (last >= lastNinePmIst()) return false;
    log.info('missed daily job detected; running catch-up');
    this.ctx.monitoring.refreshAll({ scheduled: true }).catch((e) => log.error('catch-up failed', e));
    return true;
  }
  stop() { for (const t of this.tasks) t.stop(); this.tasks = []; }
}
