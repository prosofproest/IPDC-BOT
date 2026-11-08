import { MemoryStore } from '../../src/storage/memory.js';
import { State } from '../../src/core/state.js';
import { Reconciler } from '../../src/core/reconcile.js';
import { Audit } from '../../src/core/audit.js';
import { loadConfig } from '../../src/config/env.js';
import { FakeAdapter } from './fakeAdapter.js';

export function makeEnv(adapterOpts) {
  const cfg = loadConfig({}, { strict: false });
  const store = new MemoryStore();
  const state = new State(store);
  const adapter = new FakeAdapter(adapterOpts);
  const audit = new Audit(store);
  const reconciler = new Reconciler({ adapter, store, state, cfg, audit });
  return { cfg, store, state, adapter, audit, reconciler };
}
