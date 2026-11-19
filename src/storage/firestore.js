import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { LeaseError } from '../utils/lock.js';

// Firestore-backed durable store. Document IDs are sanitized (no '/').
const safe = (id) => String(id).replace(/\//g, '_');

export class FirestoreStore {
  constructor({ projectId, clientEmail, privateKey, db } = {}) {
    if (db) {
      this.db = db;
    } else {
      if (!getApps().length) {
        initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
      }
      this.db = getFirestore();
      this.db.settings({ ignoreUndefinedProperties: true });
    }
  }
  async ping() { await this.db.collection('meta').doc('ping').set({ at: Date.now() }); return true; }
  async get(col, id) { const s = await this.db.collection(col).doc(safe(id)).get(); return s.exists ? s.data() : null; }

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

    return this.db.runTransaction(async (t) => {
      const now = Date.now();
      for (const l of lockList) {
        if (!l.name) continue;
        const lockRef = this.db.collection('locks').doc(safe(l.name));
        const s = await t.get(lockRef);
        if (!s.exists) {
          throw new LeaseError(`Lock ${l.name} lease expired or was lost during processing (not_found)`);
        }
        const d = s.data();
        if (l.owner && d.owner !== l.owner) {
          throw new LeaseError(`Lock ${l.name} lease expired or was lost during processing (owner_mismatch)`);
        }
        if (d.expiresAt <= now) {
          throw new LeaseError(`Lock ${l.name} lease expired or was lost during processing (expired)`);
        }
        if (l.fencingToken != null && d.fencingToken !== l.fencingToken) {
          throw new LeaseError(`Lock ${l.name} lease fencing token mismatch`);
        }
      }

      const txStore = {
        get: async (col, id) => {
          const s = await t.get(this.db.collection(col).doc(safe(id)));
          return s.exists ? s.data() : null;
        },
        set: (col, id, data) => {
          t.set(this.db.collection(col).doc(safe(id)), data);
        },
        merge: (col, id, patch) => {
          t.set(this.db.collection(col).doc(safe(id)), patch, { merge: true });
        },
        delete: (col, id) => {
          t.delete(this.db.collection(col).doc(safe(id)));
        },
      };

      return await mutationFn(txStore);
    });
  }

  async set(col, id, data, opts = {}) {
    if (opts.lock) {
      return this.runGuarded(opts.lock, (tx) => tx.set(col, id, data));
    }
    await this.db.collection(col).doc(safe(id)).set(data);
  }

  async merge(col, id, patch, opts = {}) {
    if (opts.lock) {
      return this.runGuarded(opts.lock, (tx) => tx.merge(col, id, patch));
    }
    await this.db.collection(col).doc(safe(id)).set(patch, { merge: true });
  }

  async delete(col, id) { await this.db.collection(col).doc(safe(id)).delete(); }
  async list(col, { limit } = {}) {
    let q = this.db.collection(col); if (limit) q = q.limit(limit);
    const s = await q.get(); return s.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  async where(col, field, value, { limit } = {}) {
    let q = this.db.collection(col).where(field, '==', value); if (limit) q = q.limit(limit);
    const s = await q.get(); return s.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  async nextSeq(name) {
    const ref = this.db.collection('counters').doc(safe(name));
    return this.db.runTransaction(async (t) => {
      const s = await t.get(ref); const n = (s.exists ? s.data().value : 0) + 1;
      t.set(ref, { value: n }); return n;
    });
  }
  // Lease lock so overlapping instances/restarts cannot run reconciliation concurrently.
  async tryLock(name, owner, ttlMs, opts = {}) {
    const ref = this.db.collection('locks').doc(safe(name));
    return this.db.runTransaction(async (t) => {
      const s = await t.get(ref); const now = Date.now();
      if (s.exists) {
        const d = s.data();
        if (d.expiresAt > now) {
          if (d.owner === owner && opts.renew === true) {
            if (opts.expectedToken != null && d.fencingToken !== opts.expectedToken) return false;
            t.set(ref, { owner, expiresAt: now + ttlMs, fencingToken: d.fencingToken, updatedAt: now });
            return true;
          }
          return false;
        }
        const newToken = (d.fencingToken || 0) + 1;
        t.set(ref, { owner, expiresAt: now + ttlMs, fencingToken: newToken, updatedAt: now });
        return true;
      }
      t.set(ref, { owner, expiresAt: now + ttlMs, fencingToken: 1, updatedAt: now });
      return true;
    });
  }
  async renewLock(name, owner, ttlMs, expectedToken = null) {
    return this.tryLock(name, owner, ttlMs, { renew: true, expectedToken });
  }
  async unlock(name, owner, expectedToken = null) {
    const ref = this.db.collection('locks').doc(safe(name));
    await this.db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (s.exists && s.data().owner === owner) {
        if (expectedToken != null && s.data().fencingToken !== expectedToken) return;
        t.delete(ref);
      }
    });
  }
  async checkLock(name, owner, expectedToken = null) {
    const ref = this.db.collection('locks').doc(safe(name));
    const s = await ref.get();
    if (!s.exists) return { valid: false, reason: 'not_found' };
    const d = s.data();
    const now = Date.now();
    if (d.owner !== owner) return { valid: false, reason: 'owner_mismatch', currentOwner: d.owner };
    if (d.expiresAt <= now) return { valid: false, reason: 'expired', expiresAt: d.expiresAt };
    if (expectedToken != null && d.fencingToken !== expectedToken) return { valid: false, reason: 'token_mismatch', fencingToken: d.fencingToken, expectedToken };
    return { valid: true, owner: d.owner, expiresAt: d.expiresAt, fencingToken: d.fencingToken };
  }
}
