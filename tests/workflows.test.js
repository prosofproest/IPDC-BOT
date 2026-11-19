import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers/env.js';
import { Auth } from '../src/core/auth.js';
import { RetryQueue } from '../src/core/queue.js';
import { Router } from '../src/core/router.js';
import { KEYS } from '../src/core/structure.js';
import { register as registerRequests } from '../src/features/requests.js';

const GRID = '1568690888413282396'; const ADMIN = '1568690393824891141';

async function setup() {
  const env = makeEnv(); const { state, store, reconciler, audit } = env;
  const t1 = await state.createTeam({ name: 'Frontend' }); const t2 = await state.createTeam({ name: 'Backend' });
  const pmA = await state.createPm({ name: 'Asha Rao', discordUserId: 'pmA' }); const pmB = await state.createPm({ name: 'Ravi K', discordUserId: 'pmB' });
  await state.updatePm(pmA.id, { teamIds: [t1.id, t2.id] }); await state.updatePm(pmB.id, { teamIds: [t1.id] });
  await reconciler.run('seed');
  reconciler._ipdcId = (await store.get('registry', KEYS.roleIpdc)).id;
  const sent = []; const edits = []; const dms = [];
  const channelFor = async (key) => ({ id: `ch-${key}`, send: async (p) => { sent.push({ key, p }); return { id: `msg${sent.length}` }; } });
  const applied = []; let failRoles = false;
  const roles = {
    idFor: (k) => reconciler.getObjectId(k),
    memberRoleKeys: async ({ pmId, teamId }) => ({ ipdc: await reconciler.getObjectId(KEYS.roleIpdc), ...(pmId && { pm: await reconciler.getObjectId(KEYS.pmRole(pmId)) }), ...(teamId && { team: await reconciler.getObjectId(KEYS.teamRole(teamId)) }) }),
    apply: async (u, d) => { if (failRoles) throw new Error('discord down'); applied.push({ u, ...d }); },
  };
  const client = { channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async (p) => edits.push(p) }) }, permissionOverwrites: { delete: async () => {} } }) }, users: { fetch: async (id) => ({ send: async (p) => dms.push({ id, p }) }) } };
  const queue = new RetryQueue(store);
  const auth = new Auth({ ids: { grid: GRID, admin: ADMIN, get ipdc() { return reconciler._ipdcId; } }, getSettings: () => state.settings() });
  const github = { enabled: true };
  const ctx = { ...env, auth, queue, roles, client, messages: { channelFor }, github, cfg: { ...env.cfg, discord: { guildId: 'g' } } };
  const router = new Router(); registerRequests(router, ctx);
  const handler = (kind, id) => router._find(router.maps[kind], id);
  const inter = (userId, roleIds, customId, extra = {}) => { const log = []; return { log, user: { id: userId, tag: `${userId}#0` }, member: { roleIds }, customId, replied: false, deferred: false, deferReply: async function () { this.deferred = true; }, editReply: async function (p) { log.push(p); }, reply: async function (p) { log.push(p); this.replied = true; }, followUp: async (p) => log.push(p), showModal: async (m) => log.push({ modal: m }), ...extra }; };
  return { ...env, queue, ctx, router, sent, edits, dms, applied, handler, inter, t1, t2, pmA, pmB, setFail: (v) => { failRoles = v; } };
}
const text = (i) => JSON.stringify(i.log);
const run = async (s, kind, i) => { const f = s.handler(kind, i.customId); await f.fn(i, f.args, s.ctx); return i; };

test('join: only the assigned PM can approve; roles = IPDC + team + PM; github linked; double-approve blocked', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({ type: 'join', userId: 'stu', pmId: s.pmA.id, teamId: s.t1.id, github: { username: 'stu-gh' } });
  assert.equal(s.sent[0].key, KEYS.pmControl(s.pmA.id), 'routed to the selected PM control channel only');
  // other PM, plain member, and ADMIN (no grant) are denied
  for (const [uid, roles] of [['pmB', []], ['rand', []], ['adm', [ADMIN]]]) {
    const i = await run(s, 'button', s.inter(uid, roles, `req:approve:${req.id}`));
    assert.match(text(i), /not authorized/i, `${uid} denied`);
  }
  assert.equal(s.applied.length, 0);
  const ok = await run(s, 'button', s.inter('pmA', [], `req:approve:${req.id}`));
  assert.match(text(ok), /Roles and access have been applied/);
  const ids = s.applied[0]; assert.equal(ids.u, 'stu');
  assert.equal(ids.add.length, 3);
  assert.ok(ids.add.includes(await s.reconciler.getObjectId(KEYS.roleIpdc)) && ids.add.includes(await s.reconciler.getObjectId(KEYS.teamRole(s.t1.id))) && ids.add.includes(await s.reconciler.getObjectId(KEYS.pmRole(s.pmA.id))));
  const m = await s.state.getMember('stu'); assert.equal(m.status, 'approved'); assert.equal(m.pmId, s.pmA.id);
  assert.equal((await s.state.githubOwner('stu-gh')).userId, 'stu');
  assert.equal((await s.store.get('requests', req.id)).status, 'approved');
  assert.match(text(await run(s, 'button', s.inter('pmA', [], `req:approve:${req.id}`))), /already approved/);
  assert.equal(s.dms.length, 1, 'applicant notified');
});

test('join: GRID can override; mapping removed before approval blocks it', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({ type: 'join', userId: 'stu', pmId: s.pmB.id, teamId: s.t1.id, github: { username: 'x1' } });
  await s.state.updatePm(s.pmB.id, { teamIds: [] });
  assert.match(text(await run(s, 'button', s.inter('g', [GRID], `req:approve:${req.id}`))), /no longer valid/);
  assert.equal((await s.store.get('requests', req.id)).status, 'pending');
  await s.state.updatePm(s.pmB.id, { teamIds: [s.t1.id] });
  assert.match(text(await run(s, 'button', s.inter('g', [GRID], `req:approve:${req.id}`))), /Approved/);
});

test('role assignment failure is queued for retry instead of lost', async () => {
  const s = await setup(); s.setFail(true);
  const req = await s.ctx.requests.createRequest({ type: 'join', userId: 'stu', pmId: s.pmA.id, teamId: s.t2.id, github: { username: 'q' } });
  const i = await run(s, 'button', s.inter('pmA', [], `req:approve:${req.id}`));
  assert.match(text(i), /queued for automatic retry/);
  const jobs = await s.store.list('queue'); assert.equal(jobs.filter((j) => j.type === 'roles.apply').length, 1);
  s.setFail(false); for (const j of jobs) await s.store.merge('queue', j.id, { nextAt: 0 });
  assert.equal(await s.queue.process(), 1); assert.equal(s.applied.length, 1);
});

test('PM application goes to #admin-approvals; PMs and members cannot approve; ADMIN can; PM entity + roles created', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({ type: 'pm_application', userId: 'newpm', pmName: 'Neha Shah', github: { username: 'nehas' } });
  assert.equal(s.sent.at(-1).key, 'ch:admin-approvals');
  assert.match(text(await run(s, 'button', s.inter('pmA', [], `req:approve:${req.id}`))), /not authorized/i);
  assert.match(text(await run(s, 'button', s.inter('stu', [], `req:approve:${req.id}`))), /not authorized/i);
  assert.match(text(await run(s, 'button', s.inter('adm', [ADMIN], `req:approve:${req.id}`))), /Approved/);
  const pm = await s.state.pmByUser('newpm'); assert.equal(pm.name, 'Neha Shah');
  assert.ok(await s.reconciler.getObjectId(KEYS.pmRole(pm.id)), 'PM-name role created');
  assert.ok(s.adapter.byName('Neha Shah').length >= 1, 'PM category created');
  assert.equal(s.applied.at(-1).add.length, 4, 'IPDC + PM-name role + all valid active team roles');
});

test('same-PM team change: current PM decides; old role removed, IPDC/PM roles untouched', async () => {
  const s = await setup();
  await s.state.saveMember('stu', { id: 'stu', status: 'approved', role: 'member', pmId: s.pmA.id, teamId: s.t1.id });
  const req = await s.ctx.requests.createRequest({ type: 'team_change', userId: 'stu', pmId: s.pmA.id, teamId: s.t1.id, newTeamId: s.t2.id });
  assert.equal(s.sent.at(-1).key, KEYS.pmControl(s.pmA.id));
  assert.match(text(await run(s, 'button', s.inter('pmB', [], `req:approve:${req.id}`))), /not authorized/i);
  await run(s, 'button', s.inter('pmA', [], `req:approve:${req.id}`));
  const a = s.applied.at(-1); assert.equal(a.add.length, 1); assert.equal(a.remove.length, 1);
  assert.equal(a.add[0], await s.reconciler.getObjectId(KEYS.teamRole(s.t2.id))); assert.equal(a.remove[0], await s.reconciler.getObjectId(KEYS.teamRole(s.t1.id)));
  assert.equal((await s.state.getMember('stu')).teamId, s.t2.id);
});

test('cross-PM transfer: admin approval; removes old PM+team roles, adds new; PM A cannot approve', async () => {
  const s = await setup();
  await s.state.saveMember('stu', { id: 'stu', status: 'approved', role: 'member', pmId: s.pmA.id, teamId: s.t2.id });
  const req = await s.ctx.requests.createRequest({ type: 'pm_transfer', userId: 'stu', pmId: s.pmA.id, teamId: s.t2.id, newPmId: s.pmB.id, newTeamId: s.t1.id });
  assert.equal(s.sent.at(-1).key, 'ch:admin-approvals');
  assert.match(text(await run(s, 'button', s.inter('pmA', [], `req:approve:${req.id}`))), /not authorized/i);
  assert.equal((await s.state.getMember('stu')).pmId, s.pmA.id, 'old assignment intact until approval');
  await run(s, 'button', s.inter('g', [GRID], `req:approve:${req.id}`));
  const a = s.applied.at(-1); assert.equal(a.add.length, 2); assert.equal(a.remove.length, 2);
  assert.ok(a.remove.includes(await s.reconciler.getObjectId(KEYS.pmRole(s.pmA.id))));
  assert.ok(a.add.includes(await s.reconciler.getObjectId(KEYS.pmRole(s.pmB.id))));
  assert.equal((await s.state.getMember('stu')).pmId, s.pmB.id);
});

test('rejection opens a modal for authorized users only and records the audit trail', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({ type: 'join', userId: 'stu', pmId: s.pmA.id, teamId: s.t1.id, github: { username: 'zz' } });
  assert.match(text(await run(s, 'button', s.inter('rand', [], `req:reject:${req.id}`))), /not authorized/i);
  const i = await run(s, 'button', s.inter('pmA', [], `req:reject:${req.id}`)); assert.ok(i.log[0].modal);
  const sub = s.inter('pmA', [], `req:rejectm:${req.id}`, { fields: { getTextInputValue: () => 'Not a fit' } });
  await run(s, 'modal', sub);
  const r = await s.store.get('requests', req.id); assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'Not a fit');
  assert.equal(s.applied.length, 0, 'no roles on rejection');
  const actions = (await s.audit.recent(50)).map((e) => e.action);
  assert.ok(actions.includes('request.created.join') && actions.includes('request.rejected.join') && actions.includes('authz.denied'));
});
