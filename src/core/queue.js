import { createLogger } from '../utils/logger.js';
import { newId } from '../utils/misc.js';

const log = createLogger('queue');

// Durable retry queue (Firestore-backed). Jobs survive restarts; handlers must be idempotent.
export class RetryQueue {
  constructor(store, { maxAttempts = 8, pollMs = 15000 } = {}) {
    this.store = store; this.handlers = new Map(); this.maxAttempts = maxAttempts; this.pollMs = pollMs;
    this.timer = null; this.busy = false; this.onFail = null;
  }
  register(type, fn) { this.handlers.set(type, fn); }
  async enqueue(type, payload, { delayMs = 0, dedupeKey } = {}) {
    const id = dedupeKey ? `${type}_${dedupeKey}`.replace(/[^\w:-]/g, '_') : `${type}_${newId()}`;
    await this.store.set('queue', id, { type, payload, attempts: 0, nextAt: Date.now() + delayMs, status: 'pending', createdAt: Date.now() });
    return id;
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.process().catch((e) => log.error('process failed', e)), this.pollMs); this.timer.unref?.(); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async process() {
    if (this.busy) return 0; this.busy = true; let done = 0;
    try {
      const jobs = (await this.store.list('queue')).filter((j) => j.status === 'pending' && j.nextAt <= Date.now());
      for (const job of jobs) {
        const h = this.handlers.get(job.type);
        if (!h) { log.warn(`no handler for ${job.type}`); continue; }
        try {
          await h(job.payload, job);
          await this.store.delete('queue', job.id); done++;
        } catch (e) {
          const attempts = (job.attempts || 0) + 1;
          if (attempts >= this.maxAttempts) {
            await this.store.merge('queue', job.id, { status: 'failed', attempts, lastError: String(e.message).slice(0, 300) });
            log.error(`job ${job.type} failed permanently`, e);
            try { await this.onFail?.(job, e); } catch { /* ignore */ }
          } else {
            const backoff = Math.min(15 * 60_000, 5000 * 2 ** attempts);
            await this.store.merge('queue', job.id, { attempts, nextAt: Date.now() + backoff, lastError: String(e.message).slice(0, 300) });
            log.warn(`job ${job.type} retry ${attempts} in ${Math.round(backoff / 1000)}s`, e);
          }
        }
      }
    } finally { this.busy = false; }
    return done;
  }
}
