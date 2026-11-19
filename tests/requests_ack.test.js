import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers/env.js';
import { Auth } from '../src/core/auth.js';
import { RetryQueue } from '../src/core/queue.js';
import { Router } from '../src/core/router.js';
import { KEYS } from '../src/core/structure.js';
import { register as registerRequests } from '../src/features/requests.js';

const GRID = '1568690888413282396';
const ADMIN = '1568690393824891141';

function makeMockInteraction(userId, roleIds, customId, extra = {}) {
  const log = [];
  const ackLog = [];
  return {
    log,
    ackLog,
    user: { id: userId, tag: `${userId}#0` },
    member: { roleIds },
    customId,
    replied: false,
    deferred: false,
    deferReply: async function (opts) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.deferred = true;
      ackLog.push({ type: 'deferReply', opts });
    },
    editReply: async function (p) {
      if (!this.deferred && !this.replied) throw new Error('InteractionNotReplied');
      this.replied = true;
      log.push({ type: 'editReply', payload: p });
      ackLog.push({ type: 'editReply', payload: p });
      return { id: 'msg1' };
    },
    reply: async function (p) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.replied = true;
      log.push({ type: 'reply', payload: p });
      ackLog.push({ type: 'reply', payload: p });
      return { id: 'msg1' };
    },
    followUp: async function (p) {
      log.push({ type: 'followUp', payload: p });
      ackLog.push({ type: 'followUp', payload: p });
      return { id: 'msg2' };
    },
    isButton: () => true,
    isChatInputCommand: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    ...extra,
  };
}

async function setup() {
  const env = makeEnv();
  const { state, store, reconciler, audit } = env;
  const t1 = await state.createTeam({ name: 'Frontend' });
  const t2 = await state.createTeam({ name: 'Backend' });
  const pmA = await state.createPm({ name: 'Asha Rao', discordUserId: 'pmA' });
  const pmB = await state.createPm({ name: 'Ravi K', discordUserId: 'pmB' });
  await state.updatePm(pmA.id, { teamIds: [t1.id, t2.id] });
  await state.updatePm(pmB.id, { teamIds: [t1.id] });
  await reconciler.run('seed');
  reconciler._ipdcId = (await store.get('registry', KEYS.roleIpdc)).id;

  const sent = [];
  const edits = [];
  const dms = [];
  const channelFor = async (key) => ({
    id: `ch-${key}`,
    send: async (p) => {
      sent.push({ key, p });
      return { id: `msg${sent.length}` };
    },
  });

  const applied = [];
  let failRoles = false;
  const roles = {
    idFor: (k) => reconciler.getObjectId(k),
    memberRoleKeys: async ({ pmId, teamId }) => ({
      ipdc: await reconciler.getObjectId(KEYS.roleIpdc),
      ...(pmId && { pm: await reconciler.getObjectId(KEYS.pmRole(pmId)) }),
      ...(teamId && { team: await reconciler.getObjectId(KEYS.teamRole(teamId)) }),
    }),
    apply: async (u, d) => {
      if (failRoles) throw new Error('discord down');
      applied.push({ u, ...d });
    },
  };

  const client = {
    channels: {
      fetch: async () => ({
        messages: { fetch: async () => ({ edit: async (p) => edits.push(p) }) },
        permissionOverwrites: { delete: async () => {} },
      }),
    },
    users: {
      fetch: async (id) => ({
        send: async (p) => dms.push({ id, p }),
      }),
    },
  };

  const queue = new RetryQueue(store);
  const auth = new Auth({
    ids: { grid: GRID, admin: ADMIN, get ipdc() { return reconciler._ipdcId; } },
    getSettings: () => state.settings(),
  });
  const github = { enabled: true };
  const ctx = {
    ...env,
    auth,
    queue,
    roles,
    client,
    messages: { channelFor },
    github,
    cfg: { ...env.cfg, discord: { guildId: 'g' } },
  };

  const router = new Router();
  registerRequests(router, ctx);

  return {
    ...env,
    queue,
    ctx,
    router,
    sent,
    edits,
    dms,
    applied,
    t1,
    t2,
    pmA,
    pmB,
    setFail: (v) => { failRoles = v; },
  };
}

test('Slow Firestore simulation: approve() immediately defers interaction before requests query completes', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu-gh' },
  });

  let deferCalledBeforeGetResolves = false;
  let testInter = null;
  const originalGet = s.store.get.bind(s.store);

  s.store.get = async (col, id) => {
    if (col === 'requests' && id === req.id && testInter) {
      deferCalledBeforeGetResolves = testInter.deferred === true;
      // Simulate slow Firestore network round-trip (50ms)
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return originalGet(col, id);
  };

  testInter = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.router.dispatch(testInter);

  assert.equal(deferCalledBeforeGetResolves, true, 'deferReply was called BEFORE the slow requests get query completed');
  assert.equal(testInter.ackLog[0].type, 'deferReply');
  assert.equal(testInter.ackLog[0].opts.flags, 64, 'deferReply uses ephemeral flags (64)');
  assert.equal(testInter.ackLog[1].type, 'editReply');
  assert.match(JSON.stringify(testInter.ackLog[1].payload), /Approved/);
});

test('Unauthorized user: immediately acknowledged via deferReply and safely rejected via editReply with audit log', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu-gh' },
  });

  const testInter = makeMockInteraction('rand_user', [], `req:approve:${req.id}`);
  await s.router.dispatch(testInter);

  assert.equal(testInter.ackLog[0].type, 'deferReply');
  assert.equal(testInter.ackLog[1].type, 'editReply');
  assert.match(JSON.stringify(testInter.ackLog[1].payload), /not authorized/i);

  // Request must still be pending
  const storedReq = await s.store.get('requests', req.id);
  assert.equal(storedReq.status, 'pending');

  // Audit trail must record authorization denial
  const recent = await s.audit.recent(5);
  const deniedEntry = recent.find((e) => e.action === 'authz.denied' && e.actorId === 'rand_user');
  assert.ok(deniedEntry, 'authz.denied recorded in audit log');
  assert.equal(deniedEntry.details.requestId, req.id);

  // No roles applied
  assert.equal(s.applied.length, 0);
});

test('Non-existent request: immediately acknowledged via deferReply and answered via editReply', async () => {
  const s = await setup();
  const testInter = makeMockInteraction('pmA', [], 'req:approve:non_existent_id');
  await s.router.dispatch(testInter);

  assert.equal(testInter.ackLog[0].type, 'deferReply');
  assert.equal(testInter.ackLog[1].type, 'editReply');
  assert.match(JSON.stringify(testInter.ackLog[1].payload), /no longer exists/i);
});

test('Already decided request: immediately acknowledged via deferReply and answered via editReply', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu-gh' },
  });
  await s.store.set('requests', req.id, { ...req, status: 'approved' });

  const testInter = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.router.dispatch(testInter);

  assert.equal(testInter.ackLog[0].type, 'deferReply');
  assert.equal(testInter.ackLog[1].type, 'editReply');
  assert.match(JSON.stringify(testInter.ackLog[1].payload), /already approved/i);
});

test('Invalid PM/team mapping: immediately acknowledged via deferReply and rejected via editReply', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu',
    pmId: s.pmB.id,
    teamId: s.t1.id,
    github: { username: 'stu-gh' },
  });
  // Invalidate mapping
  await s.state.updatePm(s.pmB.id, { teamIds: [] });

  const testInter = makeMockInteraction('g', [GRID], `req:approve:${req.id}`);
  await s.router.dispatch(testInter);

  assert.equal(testInter.ackLog[0].type, 'deferReply');
  assert.equal(testInter.ackLog[1].type, 'editReply');
  assert.match(JSON.stringify(testInter.ackLog[1].payload), /no longer valid/i);
});

test('Firestore error after deferral: handled gracefully via editReply without unhandled rejection or hang', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu-gh' },
  });

  const originalGet = s.store.get.bind(s.store);
  s.store.get = async (col, id) => {
    if (col === 'requests' && id === req.id) {
      throw new Error('Firestore read timeout');
    }
    return originalGet(col, id);
  };

  const testInter = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.router.dispatch(testInter);

  assert.equal(testInter.ackLog[0].type, 'deferReply');
  assert.equal(testInter.ackLog[1].type, 'editReply');
  assert.match(JSON.stringify(testInter.ackLog[1].payload), /Something went wrong while processing approval: Firestore read timeout/);
});
