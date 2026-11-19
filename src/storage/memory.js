import { LeaseError } from '../utils/lock.js';

// In-memory store with the same interface as the Firestore store. Used by tests only
// (production always uses Firestore; state must never live only in memory).
export class MemoryStore {
  constructor() { this.cols = new Map(); this.locks = new Map(); this.seq = new Map(); }
  _c(col) { if (!this.cols.has(col)) this.cols.set(col, new Map()); return this.cols.get(col); }
  async get(col, id) { const v = this._c(col).get(String(id)); return v === undefined ? null : structuredClone(v); }

  async runGuarded(locks, mutationFn) {
    const flattenLocks = (item) => {
      if (!item) return [];
      if (Array.isArray(item)) return item.flatMap(flattenLocks);
      if (item.leases && Array.isArray(item.leases)) return item.leases.flatMap(flattenLocks);
      return [item];
    };
    const raw = flattenLocks(locks);
    const lockList = raw.map((l) => ({
      name: l.name || l,
      owner: l.owner,
      fencingToken: l.fencingToken,
    }));
    const now = Date.now();
    for (const l of lockList) {
      if (!l.name) continue;
      const cur = this.locks.get(l.name);
      if (!cur) {
        throw new LeaseError(`Lock ${l.name} lease expired or was lost during processing (not_found)`);
      }
      if (l.owner && cur.owner !== l.owner) {
        throw new LeaseError(`Lock ${l.name} lease expired or was lost during processing (owner_mismatch)`);
      }
      if (cur.expiresAt <= now) {
        throw new LeaseError(`Lock ${l.name} lease expired or was lost during processing (expired)`);
      }
      if (l.fencingToken != null && cur.fencingToken !== l.fencingToken) {
        throw new LeaseError(`Lock ${l.name} lease fencing token mismatch`);
      }
    }
    return await mutationFn(this);
  }

  async set(col, id, data, opts = {}) {
    if (opts.lock) {
      return this.runGuarded(opts.lock, () => {
        this._c(col).set(String(id), structuredClone(data));
      });
    }
    this._c(col).set(String(id), structuredClone(data));
  }

  async merge(col, id, patch, opts = {}) {
    if (opts.lock) {
      return this.runGuarded(opts.lock, () => {
        const cur = this._c(col).get(String(id)) || {};
        this._c(col).set(String(id), { ...cur, ...structuredClone(patch) });
      });
    }
    const cur = this._c(col).get(String(id)) || {};
    this._c(col).set(String(id), { ...cur, ...structuredClone(patch) });
  }

  async delete(col, id) { this._c(col).delete(String(id)); }
  async list(col, { limit } = {}) {
    const out = [...this._c(col).entries()].map(([id, v]) => ({ id, ...structuredClone(v) }));
    return limit ? out.slice(0, limit) : out;
  }
  async where(col, field, value, { limit } = {}) {
    const all = await this.list(col);
    const out = all.filter((d) => d[field] === value);
    return limit ? out.slice(0, limit) : out;
  }
  async nextSeq(name) { const n = (this.seq.get(name) || 0) + 1; this.seq.set(name, n); return n; }
  async tryLock(name, owner, ttlMs, opts = {}) {
    const now = Date.now(); const cur = this.locks.get(name);
    if (cur) {
      if (cur.expiresAt > now) {
        if (cur.owner === owner && opts.renew === true) {
          if (opts.expectedToken != null && cur.fencingToken !== opts.expectedToken) return false;
          this.locks.set(name, { owner, expiresAt: now + ttlMs, fencingToken: cur.fencingToken, updatedAt: now });
          return true;
        }
        return false;
      }
      const newToken = (cur.fencingToken || 0) + 1;
      this.locks.set(name, { owner, expiresAt: now + ttlMs, fencingToken: newToken, updatedAt: now });
      return true;
    }
    this.locks.set(name, { owner, expiresAt: now + ttlMs, fencingToken: 1, updatedAt: now });
    return true;
  }
  async renewLock(name, owner, ttlMs, expectedToken = null) {
    return this.tryLock(name, owner, ttlMs, { renew: true, expectedToken });
  }
  async unlock(name, owner, expectedToken = null) {
    const cur = this.locks.get(name);
    if (cur && cur.owner === owner) {
      if (expectedToken != null && cur.fencingToken !== expectedToken) return;
      this.locks.delete(name);
    }
  }
  async checkLock(name, owner, expectedToken = null) {
    const now = Date.now();
    const cur = this.locks.get(name);
    if (!cur) return { valid: false, reason: 'not_found' };
    if (cur.owner !== owner) return { valid: false, reason: 'owner_mismatch', currentOwner: cur.owner };
    if (cur.expiresAt <= now) return { valid: false, reason: 'expired', expiresAt: cur.expiresAt };
    if (expectedToken != null && cur.fencingToken !== expectedToken) return { valid: false, reason: 'token_mismatch', fencingToken: cur.fencingToken, expectedToken };
    return { valid: true, owner: cur.owner, expiresAt: cur.expiresAt, fencingToken: cur.fencingToken };
  }
}
