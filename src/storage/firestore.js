import admin from 'firebase-admin';

// Firestore-backed durable store. Document IDs are sanitized (no '/').
const safe = (id) => String(id).replace(/\//g, '_');

export class FirestoreStore {
  constructor({ projectId, clientEmail, privateKey }) {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
    }
    this.db = admin.firestore();
    this.db.settings({ ignoreUndefinedProperties: true });
  }
  async ping() { await this.db.collection('meta').doc('ping').set({ at: Date.now() }); return true; }
  async get(col, id) { const s = await this.db.collection(col).doc(safe(id)).get(); return s.exists ? s.data() : null; }
  async set(col, id, data) { await this.db.collection(col).doc(safe(id)).set(data); }
  async merge(col, id, patch) { await this.db.collection(col).doc(safe(id)).set(patch, { merge: true }); }
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
  async tryLock(name, owner, ttlMs) {
    const ref = this.db.collection('locks').doc(safe(name));
    return this.db.runTransaction(async (t) => {
      const s = await t.get(ref); const now = Date.now();
      if (s.exists) { const d = s.data(); if (d.expiresAt > now && d.owner !== owner) return false; }
      t.set(ref, { owner, expiresAt: now + ttlMs }); return true;
    });
  }
  async unlock(name, owner) {
    const ref = this.db.collection('locks').doc(safe(name));
    await this.db.runTransaction(async (t) => {
      const s = await t.get(ref); if (s.exists && s.data().owner === owner) t.delete(ref);
    });
  }
}
