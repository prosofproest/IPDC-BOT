// In-memory store with the same interface as the Firestore store. Used by tests only
// (production always uses Firestore; state must never live only in memory).
export class MemoryStore {
  constructor() { this.cols = new Map(); this.locks = new Map(); this.seq = new Map(); }
  _c(col) { if (!this.cols.has(col)) this.cols.set(col, new Map()); return this.cols.get(col); }
  async get(col, id) { const v = this._c(col).get(String(id)); return v === undefined ? null : structuredClone(v); }
  async set(col, id, data) { this._c(col).set(String(id), structuredClone(data)); }
  async merge(col, id, patch) {
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
  async tryLock(name, owner, ttlMs) {
    const now = Date.now(); const cur = this.locks.get(name);
    if (cur && cur.expiresAt > now && cur.owner !== owner) return false;
    this.locks.set(name, { owner, expiresAt: now + ttlMs }); return true;
  }
  async unlock(name, owner) { const cur = this.locks.get(name); if (cur && cur.owner === owner) this.locks.delete(name); }
}
