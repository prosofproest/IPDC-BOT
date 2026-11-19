import { createLogger } from './logger.js';

const log = createLogger('lock');

/**
 * Global IPDC Lock Hierarchy (Enforce strict ascending acquisition order):
 *
 * 1. Global: 'reconcile'
 * 2. PMs:    'pm:<pmId>'         (lexicographically sorted if multiple)
 * 3. Teams:  'team:<teamId>'     (lexicographically sorted if multiple)
 * 4. Members:'member:<userId>'   (lexicographically sorted if multiple)
 *
 * All multi-resource operations MUST acquire locks in this exact order.
 * All releases MUST occur in reverse order.
 */
export function getLockPriority(key) {
  if (key === 'reconcile') return 1;
  if (key.startsWith('pm:')) return 2;
  if (key.startsWith('team:')) return 3;
  if (key.startsWith('member:')) return 4;
  return 5;
}

export function sortLockKeys(keys = []) {
  const unique = [...new Set(keys.filter(Boolean))];
  return unique.sort((a, b) => {
    const pA = getLockPriority(a);
    const pB = getLockPriority(b);
    if (pA !== pB) return pA - pB;
    return a.localeCompare(b);
  });
}

export class LeaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LeaseError';
    this.isLeaseError = true;
  }
}

export function isLeaseError(err) {
  return Boolean(
    err && (
      err.isLeaseError === true ||
      err.name === 'LeaseError' ||
      err.message?.includes('lease expired or was lost') ||
      err.message?.includes('has already been released') ||
      err.message?.includes('lease fencing token mismatch')
    )
  );
}

export class RenewableLease {
  constructor({ store, name, owner, ttlMs = 15_000, renewIntervalMs = 5_000, fencingToken = null }) {
    this.store = store;
    this.name = name;
    this.owner = owner;
    this.ttlMs = ttlMs;
    this.renewIntervalMs = renewIntervalMs;
    this.fencingToken = fencingToken;
    this.released = false;
    this.lost = false;
    this._timer = null;
    this._pendingRenewal = null;
  }

  start() {
    this._schedule();
  }

  _schedule() {
    if (this.released || this.lost) return;
    this._timer = setTimeout(async () => {
      if (this.released || this.lost) return;
      try {
        const renewFn = this.store.renewLock
          ? this.store.renewLock.bind(this.store)
          : (n, o, t, tok) => this.store.tryLock(n, o, t, { renew: true, expectedToken: tok });
        this._pendingRenewal = renewFn(this.name, this.owner, this.ttlMs, this.fencingToken);
        const ok = await this._pendingRenewal;
        if (!ok) {
          this.lost = true;
          log.warn(`lock renewal failed for ${this.name} (${this.owner}); marked lost`);
          return;
        }
      } catch (err) {
        this.lost = true;
        log.warn(`lock renewal error for ${this.name} (${this.owner}); marked lost`, err);
        return;
      } finally {
        this._pendingRenewal = null;
      }
      this._schedule();
    }, this.renewIntervalMs);
    if (this._timer?.unref) this._timer.unref();
  }

  async isAlive() {
    if (this.released || this.lost) return false;
    if (typeof this.store?.checkLock === 'function') {
      try {
        const check = await this.store.checkLock(this.name, this.owner, this.fencingToken);
        if (!check?.valid) {
          this.lost = true;
          return false;
        }
        return true;
      } catch {
        this.lost = true;
        return false;
      }
    }
    if (this.store?.locks instanceof Map) {
      const cur = this.store.locks.get(this.name);
      if (!cur || cur.owner !== this.owner || cur.expiresAt <= Date.now()) {
        this.lost = true;
        return false;
      }
    }
    return true;
  }

  async assertAlive() {
    if (this.released) throw new LeaseError(`Lock ${this.name} has already been released`);
    if (this.lost) throw new LeaseError(`Lock ${this.name} lease expired or was lost during processing`);
    if (typeof this.store?.checkLock === 'function') {
      const check = await this.store.checkLock(this.name, this.owner, this.fencingToken);
      if (!check?.valid) {
        this.lost = true;
        throw new LeaseError(`Lock ${this.name} lease expired or was lost during processing (${check?.reason || 'invalid'})`);
      }
    } else if (this.store?.locks instanceof Map) {
      const cur = this.store.locks.get(this.name);
      if (!cur || cur.owner !== this.owner || cur.expiresAt <= Date.now()) {
        this.lost = true;
        throw new LeaseError(`Lock ${this.name} lease expired or was lost during processing`);
      }
    }
  }

  async release() {
    if (this.released) return;
    this.released = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._pendingRenewal) {
      try { await this._pendingRenewal; } catch {}
      this._pendingRenewal = null;
    }
    try {
      await this.store.unlock(this.name, this.owner, this.fencingToken);
    } catch (e) {
      log.warn(`unlock failed for ${this.name}`, e);
    }
  }
}

export async function acquireRenewableLock(store, name, owner, opts = {}) {
  const ttlMs = opts.ttlMs ?? 15_000;
  const renewIntervalMs = opts.renewIntervalMs ?? 5_000;
  const ok = await store.tryLock(name, owner, ttlMs);
  if (!ok) return null;
  let fencingToken = null;
  if (typeof store.checkLock === 'function') {
    try {
      const chk = await store.checkLock(name, owner);
      if (chk?.valid && chk.fencingToken != null) {
        fencingToken = chk.fencingToken;
      }
    } catch {}
  }
  const lease = new RenewableLease({ store, name, owner, ttlMs, renewIntervalMs, fencingToken });
  lease.start();
  return lease;
}

export async function acquireOrderedLocks(store, owner, rawKeys = [], opts = {}) {
  const sortedKeys = sortLockKeys(rawKeys);
  const leases = [];

  for (const key of sortedKeys) {
    const lease = await acquireRenewableLock(store, key, owner, opts);
    if (!lease) {
      // Release in reverse order of acquisition
      for (let i = leases.length - 1; i >= 0; i--) {
        await leases[i].release();
      }
      return null;
    }
    leases.push(lease);
  }

  return {
    leases,
    isAlive: async () => {
      for (const l of leases) {
        if (!(await l.isAlive())) return false;
      }
      return true;
    },
    assertAlive: async () => {
      for (const l of leases) {
        await l.assertAlive();
      }
    },
    release: async () => {
      // Strict reverse-order release
      for (let i = leases.length - 1; i >= 0; i--) {
        await leases[i].release();
      }
    },
  };
}

