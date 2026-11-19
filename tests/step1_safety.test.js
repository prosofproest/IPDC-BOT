import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers/env.js';
import { Auth } from '../src/core/auth.js';
import { RetryQueue } from '../src/core/queue.js';
import { Router } from '../src/core/router.js';
import { Managed } from '../src/core/managed.js';
import { KEYS } from '../src/core/structure.js';
import { register as registerRequests } from '../src/features/requests.js';
import { register as registerAdmin } from '../src/features/admin.js';
import { handleRoleDelete } from '../src/core/dynamicRoles.js';
import { acquireRenewableLock, acquireOrderedLocks, LeaseError, isLeaseError } from '../src/utils/lock.js';
import { FirestoreStore } from '../src/storage/firestore.js';
import { provisionPmWorkspace } from '../src/core/workspace.js';
import { RoleService } from '../src/core/roles.js';

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
    deferUpdate: async function (opts) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.deferred = true;
      ackLog.push({ type: 'deferUpdate', opts });
    },
    editReply: async function (p) {
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
    update: async function (p) {
      this.replied = true;
      log.push({ type: 'update', payload: p });
      ackLog.push({ type: 'update', payload: p });
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
  const { state, store, reconciler, audit, adapter } = env;

  const cfg = {
    ...env.cfg,
    discord: { ...env.cfg.discord, guildId: 'g' },
  };
  reconciler.cfg = cfg;

  const t1 = await state.createTeam({ name: 'Frontend' });
  const t2 = await state.createTeam({ name: 'Backend' });
  const pmA = await state.createPm({ name: 'Asha Rao', discordUserId: 'pmA' });
  const pmB = await state.createPm({ name: 'Ravi K', discordUserId: 'pmB' });

  const guildRoles = new Map();
  const guildChannels = new Map();
  const guildMembers = new Map();

  const mockGuild = {
    id: 'g',
    roles: {
      cache: new Map(),
      fetch: async (id) => {
        if (guildRoles.has(id)) return guildRoles.get(id);
        const r = await adapter.getRole(id);
        if (!r) return null;
        const roleObj = { ...r, delete: async () => adapter.deleteRole(id) };
        return roleObj;
      },
    },
    channels: {
      cache: new Map(),
      fetch: async (id) => {
        if (guildChannels.has(id)) return guildChannels.get(id);
        const c = await adapter.getChannel(id);
        if (!c) return null;
        const chanObj = { ...c, delete: async () => adapter.deleteChannel(id) };
        return chanObj;
      },
    },
    members: {
      fetch: async (uid) => {
        if (guildMembers.has(uid)) return guildMembers.get(uid);
        return {
          id: uid,
          roles: {
            cache: new Map(),
          },
        };
      },
    },
  };

  const client = {
    guilds: {
      cache: new Map([['g', mockGuild]]),
    },
    channels: {
      fetch: async () => ({
        messages: { fetch: async () => ({ edit: async (p) => edits.push(p) }) },
        permissionOverwrites: { delete: async () => {} },
      }),
    },
    users: { fetch: async (id) => ({ send: async (p) => dms.push({ id, p }) }) },
  };

  const managed = new Managed({ client, store, cfg, state });
  reconciler.managed = managed;

  await reconciler.run('seed');
  reconciler._ipdcId = (await store.get('registry', KEYS.roleIpdc)).id;

  // Set PM team assignments
  await state.updatePm(pmA.id, { teamIds: [t1.id, t2.id] });
  await state.updatePm(pmB.id, { teamIds: [t1.id] });

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
  const realRoleService = new RoleService({
    client: { guilds: { cache: new Map([['g', mockGuild]]) } },
    cfg,
    reconciler,
    adapter,
  });
  const roles = {
    idFor: (k, opts) => realRoleService.idFor(k, opts),
    memberRoleKeys: (args, opts) => realRoleService.memberRoleKeys(args, opts),
    apply: async (u, d) => {
      if (failRoles) throw new Error('discord rate limit');
      applied.push({ u, ...d });
    },
    guild: mockGuild,
  };

  const queue = new RetryQueue(store);
  const auth = new Auth({
    ids: { grid: GRID, admin: ADMIN, get ipdc() { return reconciler._ipdcId; } },
    getSettings: () => state.settings(),
  });
  const github = { enabled: true };
  const ctx = {
    ...env,
    managed,
    auth,
    queue,
    roles,
    client,
    messages: { channelFor },
    github,
    cfg,
  };

  const router = new Router();
  registerRequests(router, ctx);
  registerAdmin(router, ctx);

  const handler = (kind, id) => router._find(router.maps[kind], id);
  const run = async (kind, i) => {
    const f = handler(kind, i.customId);
    if (!f) throw new Error(`Handler not found for ${kind} ${i.customId}`);
    await f.fn(i, f.args, ctx);
    return i;
  };

  return {
    ...env,
    managed,
    ctx,
    queue,
    router,
    run,
    sent,
    edits,
    dms,
    applied,
    guildMembers,
    t1,
    t2,
    pmA,
    pmB,
    setFail: (v) => { failRoles = v; },
  };
}

const getPayloadText = (i) => JSON.stringify(i.log);

test('Step 1 Safety: Per-member distributed locking blocks concurrent approval of same member', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu1',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu1-gh' },
  });

  // Manually acquire member lock
  const locked = await s.store.tryLock('member:stu1', 'external-worker', 60_000);
  assert.equal(locked, true);

  const i = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.run('button', i);

  assert.equal(i.deferred, true);
  assert.match(getPayloadText(i), /Another approval or role operation is in progress for this member/i);

  // Request should remain pending
  const freshReq = await s.store.get('requests', req.id);
  assert.equal(freshReq.status, 'pending');

  // Once unlocked, approval succeeds
  await s.store.unlock('member:stu1', 'external-worker');
  const i2 = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.run('button', i2);
  assert.match(getPayloadText(i2), /Approved/);
});

test('Step 1 Safety: Pre-mutation immutable snapshot captures original null state', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu2',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu2-gh' },
  });

  const i = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.run('button', i);

  const approvedReq = await s.store.get('requests', req.id);
  assert.equal(approvedReq.status, 'approved');
  assert.ok(approvedReq.snapshot, 'Snapshot must be captured');
  assert.equal(approvedReq.snapshot.version, 1);
  assert.equal(approvedReq.snapshot.pmId, null, 'Original pmId is null for new join');
  assert.equal(approvedReq.snapshot.teamId, null, 'Original teamId is null for new join');
  assert.equal(approvedReq.snapshot.status, 'unassigned', 'Original status is unassigned for new join');
});

test('Step 1 Safety: Team change uses snapshot to prevent role-diff inversion on retry', async () => {
  const s = await setup();
  // Set up approved member in team 1
  await s.state.saveMember('stu3', {
    status: 'approved',
    pmId: s.pmA.id,
    teamId: s.t1.id,
  });

  const req = await s.ctx.requests.createRequest({
    type: 'team_change',
    userId: 'stu3',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    newTeamId: s.t2.id,
  });

  // Cause role application to fail on first attempt
  s.setFail(true);
  const i = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.run('button', i);

  assert.match(getPayloadText(i), /queued for automatic retry/);

  // Verify member state was updated, but snapshot preserved t1
  const member = await s.state.getMember('stu3');
  assert.equal(member.teamId, s.t2.id);

  const approvedReq = await s.store.get('requests', req.id);
  assert.equal(approvedReq.snapshot.teamId, s.t1.id);
  assert.equal(approvedReq.snapshot.pmId, s.pmA.id);

  // Now process queue with failRoles=false
  s.setFail(false);
  const queueJobs = await s.store.list('queue');
  for (const j of queueJobs) await s.store.merge('queue', j.id, { nextAt: 0 });
  await s.queue.process();

  // Verify roles applied correctly
  assert.ok(s.applied.length > 0);
  const lastApplied = s.applied.at(-1);
  const t2RoleId = await s.reconciler.getObjectId(KEYS.teamRole(s.t2.id));
  assert.ok(lastApplied.add.includes(t2RoleId), 'Must add new team role');
});

test('Step 1 Safety: Stale queue payload does not overwrite newer assignment', async () => {
  const s = await setup();
  // Initial state: approved in t1
  await s.state.saveMember('stu4', {
    status: 'approved',
    pmId: s.pmA.id,
    teamId: s.t1.id,
  });

  // Stale queue payload referencing t1
  await s.queue.enqueue('roles.apply', {
    userId: 'stu4',
    targetRoleIds: ['stale-t1-role'],
  });

  // Before queue runs, member changes to t2 in state
  await s.state.saveMember('stu4', {
    status: 'approved',
    pmId: s.pmA.id,
    teamId: s.t2.id,
  });

  const queueJobs = await s.store.list('queue');
  for (const j of queueJobs) await s.store.merge('queue', j.id, { nextAt: 0 });
  await s.queue.process();

  // The queue handler must derive authoritative roles from current state (t2)
  const lastApplied = s.applied.at(-1);
  const t2RoleId = await s.reconciler.getObjectId(KEYS.teamRole(s.t2.id));
  assert.ok(lastApplied.add.includes(t2RoleId), 'Queue worker must derive target roles from live Firestore state');
});

test('Step 1 Safety: Protected roles (GRID, ADMIN) are never modified by queue convergence', async () => {
  const s = await setup();
  await s.state.saveMember('admin_member', {
    status: 'approved',
    pmId: s.pmA.id,
    teamId: s.t1.id,
  });

  // Configure member holding ADMIN, GRID, and custom manual role
  const memberRolesCache = new Map();
  memberRolesCache.set(GRID, { id: GRID, name: 'IPDC GRID' });
  memberRolesCache.set(ADMIN, { id: ADMIN, name: 'ADMIN' });
  memberRolesCache.set('custom_manual_role', { id: 'custom_manual_role', name: 'Custom' });

  s.guildMembers.set('admin_member', {
    id: 'admin_member',
    roles: {
      cache: memberRolesCache,
    },
  });

  await s.queue.enqueue('roles.apply', { userId: 'admin_member' });
  const queueJobs = await s.store.list('queue');
  for (const j of queueJobs) await s.store.merge('queue', j.id, { nextAt: 0 });
  await s.queue.process();

  const lastApplied = s.applied.at(-1);
  assert.ok(!lastApplied.remove.includes(GRID), 'Must not remove GRID');
  assert.ok(!lastApplied.remove.includes(ADMIN), 'Must not remove ADMIN');
  assert.ok(!lastApplied.remove.includes('custom_manual_role'), 'Must not remove manual unmanaged role');
});

test('Step 1 Safety: PM deletion sets status to deleting, filters from active state, and prevents reconciliation recreation', async () => {
  const s = await setup();
  const pmToDelete = await s.state.createPm({ name: 'Delete Me PM', discordUserId: 'del_pm' });
  await s.reconciler.run('seed');

  // Verify PM is in active state
  let activePms = await s.state.pms();
  assert.ok(activePms.some((p) => p.id === pmToDelete.id));

  // Run admin deletion flow with GRID role
  const i = makeMockInteraction('admin_user', [GRID], `adm:pm-del-ok:${pmToDelete.id}`);
  await s.run('button', i);
  assert.match(getPayloadText(i), /PM .* removed/);

  // PM status should now be removed in Firestore
  const deletedPm = await s.store.get('pms', pmToDelete.id);
  assert.equal(deletedPm.status, 'removed');

  // Active pms list must exclude removed/deleting PMs
  activePms = await s.state.pms();
  assert.ok(!activePms.some((p) => p.id === pmToDelete.id));

  // Running reconciliation should not recreate PM workspace or role
  await s.reconciler.run('maintenance');
  const roleId = await s.reconciler.getObjectId(KEYS.pmRole(pmToDelete.id));
  assert.equal(roleId, null);
});

test('Step 1 Safety: Interrupted deletion recovery sweep completes during reconciliation', async () => {
  const s = await setup();
  const stuckPm = await s.state.createPm({ name: 'Stuck PM', discordUserId: 'stuck_pm' });
  await s.reconciler.run('seed');

  // Simulate process crash during deletion: status set to 'deleting', but registry entries still present
  await s.store.merge('pms', stuckPm.id, { status: 'deleting' });

  // Verify active pms filters it out
  const activePms = await s.state.pms();
  assert.ok(!activePms.some((p) => p.id === stuckPm.id));

  // Run reconciler run, which triggers deletion recovery sweep
  await s.reconciler.run('recovery-test');

  // Stuck PM should now be fully recovered to 'removed'
  const recoveredPm = await s.store.get('pms', stuckPm.id);
  assert.equal(recoveredPm.status, 'removed');

  // Verify registry entries were cleaned up
  const regList = await s.store.list('registry');
  const remaining = regList.filter((r) => r.key === KEYS.pmRole(stuckPm.id));
  assert.equal(remaining.length, 0);
});

test('Step 1 Safety: Audit log failure does not block approval success', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu5',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu5-gh' },
  });

  // Make audit log fail
  s.audit.log = async () => { throw new Error('Audit service unavailable'); };

  const i = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.run('button', i);

  assert.match(getPayloadText(i), /Approved/);
  const approvedReq = await s.store.get('requests', req.id);
  assert.equal(approvedReq.status, 'approved');
});

test('Step 1 Safety: Lock lease renewal keeps lock alive and renewal failure fails closed', async () => {
  const s = await setup();
  const lease = await acquireRenewableLock(s.store, 'test:renewable', 'ownerA', { ttlMs: 60, renewIntervalMs: 20 });
  assert.ok(lease);
  assert.equal(await lease.isAlive(), true);

  // Wait beyond initial TTL; renewal heartbeat should have fired and kept it alive
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await lease.isAlive(), true);

  // Steal the lock in store with another owner to simulate renewal failure
  if (s.store.locks) {
    s.store.locks.set('test:renewable', { owner: 'ownerB', expiresAt: Date.now() + 60_000 });
  } else {
    await s.store.unlock('test:renewable', 'ownerA');
    await s.store.tryLock('test:renewable', 'ownerB', 60_000);
  }

  // Wait for next renewal tick to detect lock loss
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(await lease.isAlive(), false);
  await assert.rejects(async () => await lease.assertAlive(), /lease expired or was lost/);

  await lease.release();
});

test('Step 1 Safety: Approval racing with PM/team deletion fails safely without corrupting state', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu_race1',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu_race1_gh' },
  });

  // Admin deletion holds the PM lock
  const pmLease = await acquireRenewableLock(s.store, `pm:${s.pmA.id}`, 'admin_deletion_worker', { ttlMs: 60_000 });
  assert.ok(pmLease);

  // Concurrently, an approval is attempted for a request targeting pmA
  const i = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.run('button', i);

  // Must fail closed with friendly error and not modify request status or member state
  assert.match(getPayloadText(i), /Another approval or role operation is in progress/);
  const freshReq = await s.store.get('requests', req.id);
  assert.equal(freshReq.status, 'pending');

  await pmLease.release();
});

test('Step 1 Safety: Queue processing racing with PM deletion strips obsolete roles dynamically', async () => {
  const s = await setup();
  // Member was previously assigned to pmA and t1
  await s.state.saveMember('stu_race2', {
    status: 'approved',
    pmId: s.pmA.id,
    teamId: s.t1.id,
  });

  // Enqueue a retry job for stu_race2
  await s.queue.enqueue('roles.apply', {
    userId: 'stu_race2',
    targetPmId: s.pmA.id,
    targetTeamId: s.t1.id,
  });

  // pmA enters 'deleting' state
  await s.store.merge('pms', s.pmA.id, { status: 'deleting' });

  // Process queue job
  const queueJobs = await s.store.list('queue');
  for (const j of queueJobs) await s.store.merge('queue', j.id, { nextAt: 0 });
  await s.queue.process();

  // Under locks, queue detects pmA is deleting, derives empty target roles, and does not grant pmA role
  const pmRoleObj = await s.reconciler.getObjectId(KEYS.pmRole(s.pmA.id));
  const lastApplied = s.applied.at(-1);
  if (lastApplied) {
    assert.ok(!lastApplied.add.includes(pmRoleObj), 'Must not add role for deleting PM');
  }
});

test('Step 1 Safety: Deletion recovery racing with member approval coordinates via member lock', async () => {
  const s = await setup();
  const dyingPm = await s.state.createPm({ name: 'Dying PM', discordUserId: 'dying_pm' });
  await s.reconciler.run('seed');

  await s.state.saveMember('stu_race3', {
    status: 'approved',
    pmId: dyingPm.id,
    teamId: null,
  });

  // PM enters deleting state
  await s.store.merge('pms', dyingPm.id, { status: 'deleting' });

  // Hold lock on member to simulate concurrent approval
  const memLease = await acquireRenewableLock(s.store, 'member:stu_race3', 'active_approval', { ttlMs: 10_000 });
  assert.ok(memLease);

  // Recovery runs while member lock is held
  await s.reconciler.run('recovery_race_test');

  // Verify that member was NOT unassigned and PM was NOT marked removed while member lock was held
  const pmDuringLock = await s.store.get('pms', dyingPm.id);
  assert.equal(pmDuringLock.status, 'deleting', 'PM must remain deleting because member lock was held');
  const memberDuringLock = await s.state.getMember('stu_race3');
  assert.equal(memberDuringLock.status, 'approved', 'Member must remain approved while member lock was held');
  assert.equal(memberDuringLock.pmId, dyingPm.id);

  await memLease.release();

  // Subsequent reconciliation recovers and cleans up
  await s.reconciler.run('recovery_final');
  const recoveredPm = await s.store.get('pms', dyingPm.id);
  assert.equal(recoveredPm.status, 'removed');
  const member = await s.state.getMember('stu_race3');
  assert.equal(member.status, 'unassigned');
});

test('Step 1 Safety: Two reconciler instances coordinate via distributed reconcile lock', async () => {
  const s = await setup();
  // Simulate instance 1 holding the distributed reconcile lock
  const lease1 = await acquireRenewableLock(s.store, 'reconcile', 'instance-1-host', { ttlMs: 60_000 });
  assert.ok(lease1);

  // Instance 2 attempts to run reconciliation
  const res = await s.reconciler.run('instance-2-run');
  assert.deepEqual(res, { skipped: true, reason: 'lock-held' });

  await lease1.release();

  // Now instance 2 can run
  const res2 = await s.reconciler.run('instance-2-resumed');
  assert.equal(res2.skipped, 0);
  assert.ok(res2.reused >= 0);
});

test('Step 1 Safety: Interrupted role deletion leaves entity in deleting state for recovery', async () => {
  const s = await setup();
  const testTeam = await s.state.createTeam({ name: 'Failing Team' });
  await s.reconciler.run('seed');

  // Verify team is active
  let activeTeams = await s.state.teams();
  assert.ok(activeTeams.some((t) => t.id === testTeam.id));

  // Simulate partial failure during Discord role deletion: store.delete fails to delete from registry
  const origDelete = s.store.delete.bind(s.store);
  let simulateFailure = true;
  s.store.delete = async (col, key) => {
    if (simulateFailure && col === 'registry' && key === KEYS.teamRole(testTeam.id)) {
      // Simulate failure to delete registry entry
      return;
    }
    return origDelete(col, key);
  };

  // Role delete event arrives from Discord
  await assert.rejects(
    async () => handleRoleDelete(s.ctx, { id: '9999', name: 'Failing Team' }),
    /Team role deletion incomplete/
  );

  // Restore normal delete so recovery can complete
  simulateFailure = false;

  // Team status must remain 'deleting', NOT 'removed'
  const teamInState = await s.store.get('teams', testTeam.id);
  assert.equal(teamInState.status, 'deleting');
  activeTeams = await s.state.teams();
  assert.ok(!activeTeams.some((t) => t.id === testTeam.id), 'Active teams must filter out deleting');

  // Next reconciliation recovery sweep cleans it up completely
  await s.reconciler.run('recover_interrupted_role');
  const finalTeam = await s.store.get('teams', testTeam.id);
  assert.equal(finalTeam.status, 'removed');
});

test('Step 1 Safety: Lease loss during GitHub linking prevents subsequent member save and role assignment', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu_loss_gh',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu_loss_gh_user' },
  });

  let memberApprovedSaveCalled = false;
  const origLink = s.state.linkGithub.bind(s.state);
  s.state.linkGithub = async (uid, gh) => {
    await origLink(uid, gh);
    // Deliberately steal the lock after GitHub link, before member status approval save
    s.store.locks.set(`member:${uid}`, { owner: 'intruder', expiresAt: Date.now() + 60_000 });
  };
  const origSave = s.state.saveMember.bind(s.state);
  s.state.saveMember = async (uid, data) => {
    if (data?.status === 'approved') {
      memberApprovedSaveCalled = true;
    }
    return origSave(uid, data);
  };

  const i = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.run('button', i);

  assert.match(getPayloadText(i), /lease expired or was lost/);
  assert.equal(memberApprovedSaveCalled, false, 'member approved save must not be called after lease loss');

  // Verify member not approved and request not approved
  const m = await s.state.getMember('stu_loss_gh');
  assert.equal(m?.status, undefined);
  const r = await s.store.get('requests', req.id);
  assert.equal(r.status, 'pending');
});

test('Step 1 Safety: Lease loss during member save prevents subsequent role assignment', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu_loss_save',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu_loss_save_user' },
  });

  let rolesApplyCalled = false;
  const origSave = s.state.saveMember.bind(s.state);
  s.state.saveMember = async (...args) => {
    await origSave(...args);
    // Deliberately steal the member lock right after member save
    s.store.locks.set('member:stu_loss_save', { owner: 'intruder', expiresAt: Date.now() + 60_000 });
  };
  const origApply = s.ctx.roles.apply.bind(s.ctx.roles);
  s.ctx.roles.apply = async (...args) => {
    rolesApplyCalled = true;
    return origApply(...args);
  };

  const i = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.run('button', i);

  assert.match(getPayloadText(i), /lease expired or was lost/);
  assert.equal(rolesApplyCalled, false, 'roles.apply must not be called after lease loss');

  // Request must not be finalized to approved
  const r = await s.store.get('requests', req.id);
  assert.equal(r.status, 'pending');
});

test('Step 1 Safety: Lease loss during PM workspace provisioning prevents subsequent workspace mutations', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'pm_application',
    userId: 'loss_pm_user',
    pmName: 'Loss PM',
    github: { username: 'losspm' },
  });

  let updatePmCompleteCalled = false;
  const origUpdatePm = s.state.updatePm.bind(s.state);
  s.state.updatePm = async (pmId, patch) => {
    if (patch.provisioningStatus === 'complete') {
      updatePmCompleteCalled = true;
    }
    return origUpdatePm(pmId, patch);
  };

  // Steal the member lock when workspace provisioning reconciler runs
  const origReconcileRun = s.reconciler.run.bind(s.reconciler);
  s.reconciler.run = async (reason) => {
    if (reason?.startsWith('pm-workspace:')) {
      s.store.locks.set('member:loss_pm_user', { owner: 'intruder', expiresAt: Date.now() + 60_000 });
    }
    return origReconcileRun(reason);
  };

  const i = makeMockInteraction('adm', [ADMIN], `req:approve:${req.id}`);
  await s.run('button', i);

  assert.equal(updatePmCompleteCalled, false, 'provisioningStatus: complete must not be set after lease loss');
  const pm = await s.state.pmByUser('loss_pm_user');
  assert.notEqual(pm?.provisioningStatus, 'complete');
});

// Helper: Mock Firestore DB for testing FirestoreStore lock transactions
function createMockFirestoreDb() {
  const store = new Map();
  return {
    collection(colName) {
      return {
        doc(docId) {
          const key = `${colName}/${docId}`;
          return {
            async get() {
              const data = store.get(key);
              return {
                exists: Boolean(data),
                data: () => (data ? structuredClone(data) : undefined),
              };
            },
            async set(data, opts = {}) {
              if (opts?.merge) {
                const cur = store.get(key) || {};
                store.set(key, { ...cur, ...structuredClone(data) });
              } else {
                store.set(key, structuredClone(data));
              }
            },
            async delete() {
              store.delete(key);
            },
          };
        },
      };
    },
    async runTransaction(updateFn) {
      const transaction = {
        async get(ref) {
          return await ref.get();
        },
        set(ref, data, opts) {
          ref.set(data, opts);
        },
        delete(ref) {
          ref.delete();
        },
      };
      return await updateFn(transaction);
    },
    _store: store,
  };
}

test('Step 1AC: FirestoreStore lock acquisition, fencing tokens, and ownership checks', async () => {
  const mockDb = createMockFirestoreDb();
  const fsStore = new FirestoreStore({ db: mockDb });

  // 1. Initial lock acquisition by ownerA
  const okA = await fsStore.tryLock('test:lock', 'ownerA', 100);
  assert.equal(okA, true);

  const checkA = await fsStore.checkLock('test:lock', 'ownerA');
  assert.equal(checkA.valid, true);
  assert.equal(checkA.owner, 'ownerA');
  assert.equal(checkA.fencingToken, 1);

  // 2. Competing acquisition by ownerB while active fails
  const okB = await fsStore.tryLock('test:lock', 'ownerB', 100);
  assert.equal(okB, false);

  // 3. Wait past TTL for lock to expire
  await new Promise((r) => setTimeout(r, 110));

  // checkLock reports expired
  const checkExpired = await fsStore.checkLock('test:lock', 'ownerA');
  assert.equal(checkExpired.valid, false);
  assert.equal(checkExpired.reason, 'expired');

  // 4. ownerB acquires after expiry, receiving incremented fencing token
  const okB2 = await fsStore.tryLock('test:lock', 'ownerB', 200);
  assert.equal(okB2, true);

  const checkB = await fsStore.checkLock('test:lock', 'ownerB');
  assert.equal(checkB.valid, true);
  assert.equal(checkB.owner, 'ownerB');
  assert.equal(checkB.fencingToken, 2);

  // 5. ownerA checkLock now reports owner_mismatch
  const checkAAfterTheft = await fsStore.checkLock('test:lock', 'ownerA');
  assert.equal(checkAAfterTheft.valid, false);
  assert.equal(checkAAfterTheft.reason, 'owner_mismatch');
});

test('Step 1AC: Stale owner attempting unlock cannot delete another instance lease', async () => {
  const mockDb = createMockFirestoreDb();
  const fsStore = new FirestoreStore({ db: mockDb });

  // Owner A acquires lock
  await fsStore.tryLock('resource:x', 'ownerA', 50);
  await new Promise((r) => setTimeout(r, 60));

  // Owner B acquires expired lock
  await fsStore.tryLock('resource:x', 'ownerB', 500);

  // Stale Owner A attempts to unlock
  await fsStore.unlock('resource:x', 'ownerA');

  // Verify Owner B's lock was NOT deleted
  const checkB = await fsStore.checkLock('resource:x', 'ownerB');
  assert.equal(checkB.valid, true);
  assert.equal(checkB.owner, 'ownerB');
});

test('Step 1AC: Asynchronous assertAlive detects Firestore lock theft before heartbeat renewal', async () => {
  const mockDb = createMockFirestoreDb();
  const fsStore = new FirestoreStore({ db: mockDb });

  const lease = await acquireRenewableLock(fsStore, 'pm:speed', 'procA', { ttlMs: 10_000, renewIntervalMs: 5_000 });
  assert.ok(lease);
  assert.equal(await lease.isAlive(), true);

  // Another process forcibly overwrites the lock in Firestore
  const lockRef = mockDb.collection('locks').doc('pm:speed');
  await lockRef.set({ owner: 'procB', expiresAt: Date.now() + 60_000, fencingToken: 99 });

  // Calling assertAlive must immediately detect theft via checkLock without waiting 5 seconds
  await assert.rejects(async () => {
    await lease.assertAlive();
  }, (err) => {
    return isLeaseError(err) && /lease expired or was lost/i.test(err.message);
  });

  await lease.release();
});

test('Step 1AC: Approval aborts on lease loss without emitting success audit log or success notification', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'join',
    userId: 'stu_loss_audit',
    pmId: s.pmA.id,
    teamId: s.t1.id,
    github: { username: 'stu_loss_audit_gh' },
  });

  const auditEvents = [];
  const origAuditLog = s.audit.log.bind(s.audit);
  s.audit.log = async (entry) => {
    auditEvents.push(entry);
    return origAuditLog(entry);
  };

  // Steal the lock during applyApproved right after linkGithub
  const origLink = s.state.linkGithub.bind(s.state);
  s.state.linkGithub = async (uid, gh) => {
    await origLink(uid, gh);
    s.store.locks.set(`member:${uid}`, { owner: 'intruder', expiresAt: Date.now() + 60_000 });
  };

  const i = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.run('button', i);

  // 1. Error message was returned to interaction
  assert.match(getPayloadText(i), /Could not apply this request: Lock member:stu_loss_audit lease expired or was lost/);

  // 2. NO success audit log was created
  const approvedAudit = auditEvents.find((e) => e.action?.startsWith('request.approved'));
  assert.equal(approvedAudit, undefined, 'no request.approved audit event must be logged on lease loss');

  // 3. NO notification was sent to user
  assert.equal(s.dms.length, 0, 'no success DM must be sent to user on lease loss');
});

test('Step 1AC: Concurrent workspace provisioning across simulated service instances coordinates safely', async () => {
  const s = await setup();
  const pm = await s.state.createPm({ name: 'Concurrent PM', discordUserId: 'concurrent_pm_user' });

  // Simulate two instances attempting to provision the workspace concurrently
  // Using two distinct caller contexts sharing the same underlying store
  const results = await Promise.allSettled([
    provisionPmWorkspace(s.ctx, pm.id, { welcome: false }),
    provisionPmWorkspace(s.ctx, pm.id, { welcome: false }),
  ]);

  // Both promises settle successfully (via withProvisionLock in-process or distributed lock)
  // And the PM is provisioned exactly once without error
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'fulfilled');

  const updatedPm = await s.state.getPm(pm.id);
  assert.equal(updatedPm.provisioningStatus, 'complete');
});

test('Step 1AE: Fencing token is preserved across renewals and incremented only on new lease', async () => {
  const mockDb = createMockFirestoreDb();
  const fsStore = new FirestoreStore({ db: mockDb });

  // 1. Initial acquisition gets fencingToken = 1
  const ok1 = await fsStore.tryLock('test:res', 'ownerA', 500);
  assert.equal(ok1, true);
  const chk1 = await fsStore.checkLock('test:res', 'ownerA');
  assert.equal(chk1.fencingToken, 1);

  // 2. Renewal by current owner MUST preserve fencingToken = 1
  const renewed = await fsStore.renewLock('test:res', 'ownerA', 500, chk1.fencingToken);
  assert.equal(renewed, true);
  const chk2 = await fsStore.checkLock('test:res', 'ownerA');
  assert.equal(chk2.fencingToken, 1, 'fencing token must not increment on renewal');

  // 3. Expire lock and acquire by new owner -> fencingToken increments to 2
  await new Promise((r) => setTimeout(r, 550));
  const ok2 = await fsStore.tryLock('test:res', 'ownerB', 500);
  assert.equal(ok2, true);
  const chk3 = await fsStore.checkLock('test:res', 'ownerB');
  assert.equal(chk3.fencingToken, 2, 'fencing token must increment on new lease acquisition');

  // Also verify same contract on MemoryStore
  const memStore = new (await import('../src/storage/memory.js')).MemoryStore();
  await memStore.tryLock('res', 'mOwnerA', 500);
  const mChk1 = await memStore.checkLock('res', 'mOwnerA');
  assert.equal(mChk1.fencingToken, 1);
  await memStore.renewLock('res', 'mOwnerA', 500, 1);
  const mChk2 = await memStore.checkLock('res', 'mOwnerA');
  assert.equal(mChk2.fencingToken, 1);
});

test('Step 1AE: Concurrent acquisition with same owner fails without opts.renew', async () => {
  const mockDb = createMockFirestoreDb();
  const fsStore = new FirestoreStore({ db: mockDb });

  const ok1 = await fsStore.tryLock('lock:same', 'owner1', 1000);
  assert.equal(ok1, true);

  // Calling tryLock again with same owner while active must fail (preventing concurrent overlapping leases)
  const okDuplicate = await fsStore.tryLock('lock:same', 'owner1', 1000);
  assert.equal(okDuplicate, false, 'duplicate acquisition without renew:true must return false');
});

test('Step 1AE: Stale owner cannot renew or unlock superseded lease', async () => {
  const mockDb = createMockFirestoreDb();
  const fsStore = new FirestoreStore({ db: mockDb });

  // Owner A acquires with token 1
  await fsStore.tryLock('lock:stale', 'ownerA', 50);
  await new Promise((r) => setTimeout(r, 60));

  // Owner B acquires with token 2
  await fsStore.tryLock('lock:stale', 'ownerB', 1000);

  // Stale Owner A tries to renew with old token
  const renewed = await fsStore.renewLock('lock:stale', 'ownerA', 1000, 1);
  assert.equal(renewed, false, 'stale owner must not be able to renew superseded lease');

  // Stale Owner A tries to unlock with old token
  await fsStore.unlock('lock:stale', 'ownerA', 1);

  // Owner B's lock remains valid and untouched
  const chkB = await fsStore.checkLock('lock:stale', 'ownerB');
  assert.equal(chkB.valid, true);
  assert.equal(chkB.owner, 'ownerB');
  assert.equal(chkB.fencingToken, 2);
});

test('Step 1AE: Transactional write guard rejects mutation if lease is lost', async () => {
  const mockDb = createMockFirestoreDb();
  const fsStore = new FirestoreStore({ db: mockDb });

  // Initial data
  await fsStore.set('members', 'user1', { id: 'user1', status: 'pending' });

  // Acquire lease
  const lease = await acquireRenewableLock(fsStore, 'member:user1', 'worker1', { ttlMs: 10_000 });
  assert.ok(lease);

  // Guarded write succeeds
  await fsStore.merge('members', 'user1', { status: 'approved' }, { lock: lease });
  const doc1 = await fsStore.get('members', 'user1');
  assert.equal(doc1.status, 'approved');

  // Steal the lock in Firestore
  const lockRef = mockDb.collection('locks').doc('member:user1');
  await lockRef.set({ owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });

  // Subsequent guarded write MUST be rejected atomically with LeaseError
  await assert.rejects(async () => {
    await fsStore.merge('members', 'user1', { status: 'overwritten' }, { lock: lease });
  }, (err) => {
    return isLeaseError(err);
  });

  // Verify the write was NOT applied
  const doc2 = await fsStore.get('members', 'user1');
  assert.equal(doc2.status, 'approved', 'data must not be modified if lock validation fails');

  await lease.release();
});

test('Step 1AE: Workspace provisioning acquires locks in strict hierarchy without lock inversion', async () => {
  const s = await setup();
  const pm = await s.state.createPm({ name: 'Hierarchy PM', discordUserId: 'hier_pm_user' });

  const acquiredKeys = [];
  const origAcquire = s.store.tryLock.bind(s.store);
  s.store.tryLock = async (name, owner, ttl, opts) => {
    acquiredKeys.push(name);
    return origAcquire(name, owner, ttl, opts);
  };

  await provisionPmWorkspace(s.ctx, pm.id, { welcome: false });

  // First lock acquired MUST be 'reconcile', followed by 'pm:<id>', then 'member:<id>'
  assert.equal(acquiredKeys[0], 'reconcile', 'reconcile lock must be acquired first');
  assert.equal(acquiredKeys[1], `pm:${pm.id}`, 'PM lock must be acquired second');
  assert.equal(acquiredKeys[2], `member:${pm.discordUserId}`, 'Member lock must be acquired third');
});

test('Step 1AE: Approval failure leaves request in pending status for safe retry', async () => {
  const s = await setup();
  const req = await s.ctx.requests.createRequest({
    type: 'pm_application',
    userId: 'retry_candidate',
    pmName: 'Retry PM',
    notes: 'Testing retry safety',
  });

  let reconcileCount = 0;
  const origRecRun = s.reconciler.run.bind(s.reconciler);
  s.reconciler.run = async (reason, opts) => {
    if (reason === 'pm-approved') reconcileCount++;
    return origRecRun(reason, opts);
  };

  // Simulate a transient workspace provisioning failure on the first approval attempt
  let failWorkspaceOnce = true;
  const origGetPm = s.state.getPm.bind(s.state);
  s.state.getPm = async (id) => {
    const pm = await origGetPm(id);
    if (failWorkspaceOnce && pm && pm.name === 'Retry PM') {
      failWorkspaceOnce = false;
      throw new Error('Simulated transient Discord network error during workspace provisioning');
    }
    return pm;
  };

  const i1 = makeMockInteraction(ADMIN, [ADMIN], `req:approve:${req.id}`);
  await s.run('button', i1);

  // First attempt fails
  assert.match(getPayloadText(i1), /Could not apply this request|Something went wrong while processing approval/);

  // Request MUST STILL be pending!
  const reqAfterFail = await s.store.get('requests', req.id);
  assert.equal(reqAfterFail.status, 'pending', 'request must remain pending on failure');

  // Post-approval reconcile must NOT have run
  assert.equal(reconcileCount, 0, 'post-approval reconcile must not run when approval fails');

  // Second attempt: retry the approval
  const i2 = makeMockInteraction(ADMIN, [ADMIN], `req:approve:${req.id}`);
  await s.run('button', i2);

  // Second attempt succeeds
  assert.match(getPayloadText(i2), /Approved/);

  // Request is now approved
  const reqAfterRetry = await s.store.get('requests', req.id);
  assert.equal(reqAfterRetry.status, 'approved', 'request must be approved after retry');
  assert.equal(reconcileCount, 1, 'post-approval reconcile runs after successful approval');
});

test('Step 1AG: Missing Discord role during team-change approval repairs role without acquiring reconcile lock', async () => {
  const s = await setup();
  await s.state.updatePm(s.pmA.id, { teamIds: [s.t1.id, s.t2.id] });
  const mem = await s.state.saveMember('stu_tc', { id: 'stu_tc', status: 'approved', role: 'member', pmId: s.pmA.id, teamId: s.t1.id });
  const req = await s.ctx.requests.createRequest({
    type: 'team_change',
    userId: 'stu_tc',
    pmId: s.pmA.id,
    newTeamId: s.t2.id,
  });

  // Ensure t2 role exists, then delete it from Discord to simulate an accidental role deletion
  const t2RoleId = await s.ctx.roles.idFor(KEYS.teamRole(s.t2.id));
  assert.ok(t2RoleId);
  await s.adapter.deleteRole(t2RoleId);
  assert.equal(await s.adapter.getRole(t2RoleId), null, 'role must be deleted from Discord');

  // Track all locks acquired
  const acquiredLocks = [];
  const origTryLock = s.store.tryLock.bind(s.store);
  s.store.tryLock = async (name, owner, ttl, opts) => {
    acquiredLocks.push(name);
    return origTryLock(name, owner, ttl, opts);
  };

  const i = makeMockInteraction('pmA', [], `req:approve:${req.id}`);
  await s.run('button', i);

  // Approval must succeed
  assert.match(getPayloadText(i), /Approved/);

  // Assert 'reconcile' lock was NEVER attempted or acquired by team-change approval
  assert.equal(acquiredLocks.includes('reconcile'), false, 'team-change approval must not attempt to acquire reconcile lock');

  // Assert target role was recreated in Discord and assigned to member
  const newT2RoleId = await s.reconciler.getObjectId(KEYS.teamRole(s.t2.id));
  assert.ok(newT2RoleId);
  assert.notEqual(newT2RoleId, t2RoleId, 'new role ID should be generated');
  const roleInDiscord = await s.adapter.getRole(newT2RoleId);
  assert.ok(roleInDiscord);
  assert.equal(roleInDiscord.name, s.t2.name);
});

test('Step 1AG: Missing Discord role during PM-transfer approval repairs role without acquiring reconcile lock', async () => {
  const s = await setup();
  await s.state.updatePm(s.pmB.id, { teamIds: [s.t1.id, s.t2.id] });
  await s.state.saveMember('stu_xfer', { id: 'stu_xfer', status: 'approved', role: 'member', pmId: s.pmA.id, teamId: s.t1.id });
  const req = await s.ctx.requests.createRequest({
    type: 'pm_transfer',
    userId: 'stu_xfer',
    newPmId: s.pmB.id,
    newTeamId: s.t2.id,
  });

  // Delete pmB's role from Discord
  const pmBRoleId = await s.ctx.roles.idFor(KEYS.pmRole(s.pmB.id));
  assert.ok(pmBRoleId);
  await s.adapter.deleteRole(pmBRoleId);
  assert.equal(await s.adapter.getRole(pmBRoleId), null);

  const acquiredLocks = [];
  const origTryLock = s.store.tryLock.bind(s.store);
  s.store.tryLock = async (name, owner, ttl, opts) => {
    acquiredLocks.push(name);
    return origTryLock(name, owner, ttl, opts);
  };

  const i = makeMockInteraction(ADMIN, [ADMIN], `req:approve:${req.id}`);
  await s.run('button', i);

  assert.match(getPayloadText(i), /Approved/);

  // Assert 'reconcile' was NOT acquired
  assert.equal(acquiredLocks.includes('reconcile'), false, 'pm_transfer approval must not acquire reconcile lock');

  // Assert pmB role was repaired
  const repairedPmRoleId = await s.reconciler.getObjectId(KEYS.pmRole(s.pmB.id));
  assert.ok(repairedPmRoleId);
  assert.ok(await s.adapter.getRole(repairedPmRoleId));
});

test('Step 1AG: Missing role during queue processing repairs role without acquiring reconcile lock', async () => {
  const s = await setup();
  await s.state.saveMember('stu_q', { id: 'stu_q', status: 'approved', role: 'member', pmId: s.pmA.id, teamId: s.t1.id });

  // Delete team role from Discord
  const t1RoleId = await s.ctx.roles.idFor(KEYS.teamRole(s.t1.id));
  await s.adapter.deleteRole(t1RoleId);

  const acquiredLocks = [];
  const origTryLock = s.store.tryLock.bind(s.store);
  s.store.tryLock = async (name, owner, ttl, opts) => {
    acquiredLocks.push(name);
    return origTryLock(name, owner, ttl, opts);
  };

  // Enqueue and run queue worker directly
  await s.queue.enqueue('roles.apply', { userId: 'stu_q' });
  await s.queue.process();

  // Assert 'reconcile' was not acquired
  assert.equal(acquiredLocks.includes('reconcile'), false, 'roles.apply queue worker must not acquire reconcile lock');

  // Assert role was repaired in Discord
  const repairedRoleId = await s.reconciler.getObjectId(KEYS.teamRole(s.t1.id));
  assert.ok(repairedRoleId);
  assert.ok(await s.adapter.getRole(repairedRoleId));
});

test('Step 1AG: Lease loss during admin PM deletion aborts mutation and leaves PM in deleting status', async () => {
  const s = await setup();
  const pm = await s.state.createPm({ name: 'Del PM', discordUserId: 'del_pm_u' });
  await s.state.saveMember('del_stu', { id: 'del_stu', status: 'approved', role: 'member', pmId: pm.id });

  // Right after status is set to deleting, simulate lock theft before member cleanup
  const origMerge = s.store.merge.bind(s.store);
  let stolen = false;
  s.store.merge = async (col, id, patch, opts) => {
    if (col === 'members' && !stolen) {
      stolen = true;
      // Steal the member lock or pm lock
      s.store.locks.set(`pm:${pm.id}`, { owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });
      s.store.locks.set(`member:del_stu`, { owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });
    }
    return origMerge(col, id, patch, opts);
  };

  const i = makeMockInteraction('admin_user', [GRID], `adm:pm-del-ok:${pm.id}`);
  await s.run('button', i);

  // Interaction receives error
  assert.match(getPayloadText(i), /PM removal encountered an error/);

  // PM status MUST remain 'deleting' (NOT 'removed') so recovery sweep can retry
  const curPm = await s.state.getPm(pm.id);
  assert.equal(curPm.status, 'deleting', 'PM status must remain deleting on lease loss');
});

test('Step 1AG: Lease loss during admin team deletion aborts mutation and leaves team in deleting status', async () => {
  const s = await setup();
  const team = await s.state.createTeam({ name: 'Del Team' });
  await s.state.saveMember('team_stu', { id: 'team_stu', status: 'approved', role: 'member', teamId: team.id });

  // Simulate lease theft during member cleanup
  const origMerge = s.store.merge.bind(s.store);
  let stolen = false;
  s.store.merge = async (col, id, patch, opts) => {
    if (col === 'members' && !stolen) {
      stolen = true;
      s.store.locks.set(`team:${team.id}`, { owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });
      s.store.locks.set(`member:team_stu`, { owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });
    }
    return origMerge(col, id, patch, opts);
  };

  const i = makeMockInteraction('admin_user', [GRID], `adm:team-del-ok:${team.id}`);
  await s.run('button', i);

  assert.match(getPayloadText(i), /Team role removal encountered an error/);

  const curTeam = await s.state.getTeam(team.id);
  assert.equal(curTeam.status, 'deleting', 'Team status must remain deleting on lease loss');
});

test('Step 1AG: Lease loss during dynamic-role deletion aborts mutation and preserves deleting status', async () => {
  const s = await setup();
  const team = await s.state.createTeam({ name: 'Dyn Del Team' });
  const role = { id: 'dyn_role_del', name: 'Dyn Del Team' };
  await s.state.updateTeam(team.id, { roleId: role.id });
  await s.state.saveMember('dyn_stu', { id: 'dyn_stu', status: 'approved', role: 'member', teamId: team.id });

  // Steal the lock during member cleanup
  const origMerge = s.store.merge.bind(s.store);
  let stolen = false;
  s.store.merge = async (col, id, patch, opts) => {
    if (col === 'members' && !stolen) {
      stolen = true;
      s.store.locks.set(`team:${team.id}`, { owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });
      s.store.locks.set(`member:dyn_stu`, { owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });
    }
    return origMerge(col, id, patch, opts);
  };

  await assert.rejects(async () => {
    await handleRoleDelete(s.ctx, role);
  }, (err) => isLeaseError(err));

  const curTeam = await s.state.getTeam(team.id);
  assert.equal(curTeam.status, 'deleting', 'Team must remain deleting if lease is lost during dynamic role deletion');
});

test('Step 1AG: Lease loss during reconciliation recovery preserves deleting status for next retry', async () => {
  const s = await setup();
  const pm = await s.state.createPm({ name: 'Rec Del PM', discordUserId: 'rec_del_u' });
  await s.state.saveMember('rec_stu', { id: 'rec_stu', status: 'approved', role: 'member', pmId: pm.id });
  await s.store.merge('pms', pm.id, { status: 'deleting' });

  // Steal lock during recovery sweep member cleanup
  const origMerge = s.store.merge.bind(s.store);
  let stolen = false;
  s.store.merge = async (col, id, patch, opts) => {
    if (col === 'members' && !stolen) {
      stolen = true;
      s.store.locks.set(`pm:${pm.id}`, { owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });
      s.store.locks.set(`member:rec_stu`, { owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });
    }
    return origMerge(col, id, patch, opts);
  };

  // Reconcile recovery sweep runs
  await s.reconciler.run('recovery-test');

  // PM status MUST remain 'deleting'
  const curPm = await s.state.getPm(pm.id);
  assert.equal(curPm.status, 'deleting', 'PM must remain deleting if recovery hits lease loss');
});

test('Step 1AI: Parent lease lost while child lease remains valid aborts member cleanup', async () => {
  const s = await setup();
  const pm = await s.state.createPm({ name: 'Del PM P', discordUserId: 'del_pm_up' });
  await s.state.saveMember('del_stu_p', { id: 'del_stu_p', status: 'approved', role: 'member', pmId: pm.id });

  // Steal ONLY parent PM lease before member save; child lease remains valid
  const origMerge = s.store.merge.bind(s.store);
  let stolen = false;
  s.store.merge = async (col, id, patch, opts) => {
    if (col === 'members' && !stolen) {
      stolen = true;
      s.store.locks.set(`pm:${pm.id}`, { owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });
    }
    return origMerge(col, id, patch, opts);
  };

  const i = makeMockInteraction('admin_user', [GRID], `adm:pm-del-ok:${pm.id}`);
  await s.run('button', i);

  assert.match(getPayloadText(i), /PM removal encountered an error/);
  const curPm = await s.state.getPm(pm.id);
  assert.equal(curPm.status, 'deleting', 'PM status must remain deleting on parent lease loss');

  // Member must NOT have been unassigned because transaction aborted
  const curMem = await s.state.getMember('del_stu_p');
  assert.equal(curMem.pmId, pm.id, 'Member must not be unassigned when parent lease was lost');
});

test('Step 1AI: Child lease lost while parent lease remains valid aborts member cleanup', async () => {
  const s = await setup();
  const pm = await s.state.createPm({ name: 'Del PM C', discordUserId: 'del_pm_uc' });
  await s.state.saveMember('del_stu_c', { id: 'del_stu_c', status: 'approved', role: 'member', pmId: pm.id });

  // Steal ONLY child member lease; parent PM lease remains valid
  const origMerge = s.store.merge.bind(s.store);
  let stolen = false;
  s.store.merge = async (col, id, patch, opts) => {
    if (col === 'members' && !stolen) {
      stolen = true;
      s.store.locks.set(`member:del_stu_c`, { owner: 'intruder', expiresAt: Date.now() + 60_000, fencingToken: 99 });
    }
    return origMerge(col, id, patch, opts);
  };

  const i = makeMockInteraction('admin_user', [GRID], `adm:pm-del-ok:${pm.id}`);
  await s.run('button', i);

  assert.match(getPayloadText(i), /PM removal encountered an error/);
  const curPm = await s.state.getPm(pm.id);
  assert.equal(curPm.status, 'deleting', 'PM status must remain deleting on child lease loss');

  const curMem = await s.state.getMember('del_stu_c');
  assert.equal(curMem.pmId, pm.id, 'Member must not be unassigned when child lease was lost');
});

test('Step 1AI: Two concurrent ensureRole() calls for the same missing role create exactly one Discord role', async () => {
  const s = await setup();
  const team = await s.state.createTeam({ name: 'Concurrent Team' });

  // Concurrently ensure the same role
  const [roleId1, roleId2] = await Promise.all([
    s.reconciler.ensureRole(KEYS.teamRole(team.id)),
    s.reconciler.ensureRole(KEYS.teamRole(team.id)),
  ]);

  // Both callers must receive the exact same role ID
  assert.ok(roleId1);
  assert.equal(roleId1, roleId2, 'Both concurrent callers must receive identical role ID');

  // Verify Discord adapter: exactly ONE role created with this name
  const createdRoles = [...s.adapter.roles.values()].filter((r) => r.name === 'Concurrent Team');
  assert.equal(createdRoles.length, 1, 'Exactly one Discord role must be created in Discord guild');
  assert.equal(createdRoles[0].id, roleId1);

  // Registry must record the single role
  const regEntry = await s.store.get('registry', KEYS.teamRole(team.id));
  assert.equal(regEntry.id, roleId1);
});

test('Step 1AI: ensureRole() racing with full reconciliation creates exactly one Discord role', async () => {
  const s = await setup();
  const team = await s.state.createTeam({ name: 'Race Team' });

  // Delete the role if created during seed so it is missing
  const initialRoleId = await s.reconciler.getObjectId(KEYS.teamRole(team.id));
  if (initialRoleId) {
    await s.adapter.deleteRole(initialRoleId);
  }

  // Concurrently run full reconciliation and targeted ensureRole
  const [, ensuredRoleId] = await Promise.all([
    s.reconciler.run('race-reconcile'),
    s.reconciler.ensureRole(KEYS.teamRole(team.id)),
  ]);

  assert.ok(ensuredRoleId);

  // Exactly one Discord role must exist for Race Team
  const raceRoles = [...s.adapter.roles.values()].filter((r) => r.name === 'Race Team');
  assert.equal(raceRoles.length, 1, 'Exactly one Discord role must be created during race with reconciliation');
  assert.equal(raceRoles[0].id, ensuredRoleId);

  // Registry must match the single role
  const reg = await s.store.get('registry', KEYS.teamRole(team.id));
  assert.equal(reg.id, ensuredRoleId);
});

test('Step 1AI: Registry persistence under concurrent updates succeeds without data loss', async () => {
  const s = await setup();
  const entryA = { key: 'team:con_a:role', type: 'role', id: 'role_a', name: 'Team A' };
  const entryB = { key: 'team:con_b:role', type: 'role', id: 'role_b', name: 'Team B' };
  const entryC = { key: 'pm:con_c:role', type: 'role', id: 'role_c', name: 'PM C' };

  await Promise.all([
    s.reconciler.saveEntry(entryA),
    s.reconciler.saveEntry(entryB),
    s.reconciler.saveEntry(entryC),
  ]);

  const [resA, resB, resC] = await Promise.all([
    s.store.get('registry', 'team:con_a:role'),
    s.store.get('registry', 'team:con_b:role'),
    s.store.get('registry', 'pm:con_c:role'),
  ]);

  assert.equal(resA.id, 'role_a');
  assert.equal(resB.id, 'role_b');
  assert.equal(resC.id, 'role_c');
});

test('Step 1AK: Role-lock retry exhaustion throws expected error and prevents duplicate roles', async () => {
  const s = await setup();
  const team = await s.state.createTeam({ name: 'Exhausted Role Team' });
  const key = KEYS.teamRole(team.id);
  const lockKey = `role-ensure:${key}`;

  // Hold role-ensure lock with a foreign owner
  s.store.locks.set(lockKey, {
    owner: 'foreign_worker',
    expiresAt: Date.now() + 60_000,
    fencingToken: 1,
  });

  // Verify retry exhaustion throws the expected error
  await assert.rejects(
    () => s.reconciler.ensureRole(key),
    (err) => {
      assert.match(
        err.message,
        new RegExp(`Could not acquire role coordination lock for ${key}; concurrent role reconciliation in progress`)
      );
      return true;
    }
  );

  // Verify no duplicate Discord role is created
  const matchingDiscordRoles = [...s.adapter.roles.values()].filter((r) => r.name === 'Exhausted Role Team');
  assert.equal(matchingDiscordRoles.length, 0, 'No Discord role should be created if role lock acquisition exhausted retries');

  // Verify registry was not written
  const reg = await s.store.get('registry', key);
  assert.equal(reg, null, 'Registry must not contain an entry when role coordination lock exhausts retries');
});

test('Step 1AK: Same-key conflicting registry writes enforce lease ownership and fencing', async () => {
  const s = await setup();
  const testKey = 'team:conflict_key:role';
  const roleLockKey = `role-ensure:${testKey}`;

  // Worker 1 acquires legitimate lease
  const lease1 = await acquireRenewableLock(s.store, roleLockKey, 'worker_1', { ttlMs: 15_000 });
  assert.ok(lease1);

  // Construct a stale lease (e.g. superseded owner or fencing token mismatch)
  const staleLease = {
    name: roleLockKey,
    owner: 'worker_stale',
    fencingToken: 0,
    assertAlive: async () => {},
  };

  // Run concurrent writes to the same registry key with different role IDs
  const [resStale, resValid] = await Promise.allSettled([
    s.reconciler.saveEntry({ key: testKey, type: 'role', id: 'stale_role_id', name: 'Stale Role' }, { lock: [staleLease] }),
    s.reconciler.saveEntry({ key: testKey, type: 'role', id: 'valid_role_id', name: 'Valid Role' }, { lock: [lease1] }),
  ]);

  // Verify established locking/guarding rules prevent stale or unauthorized writes
  assert.equal(resStale.status, 'rejected', 'Stale/unauthorized write must be rejected');
  assert.ok(isLeaseError(resStale.reason), 'Rejection must be a LeaseError');
  assert.equal(resValid.status, 'fulfilled', 'Authorized write with valid active lease must succeed');

  // Assert the final registry state reflects only the valid write
  const finalEntry = await s.store.get('registry', testKey);
  assert.ok(finalEntry);
  assert.equal(finalEntry.id, 'valid_role_id');
  assert.equal(finalEntry.name, 'Valid Role');

  await lease1.release();
});

test('Step 1AK: Lease loss after Discord role creation fails persistence and recovers on retry without duplicates', async () => {
  const s = await setup();
  const team = await s.state.createTeam({ name: 'Orphan Recovery Team' });
  const key = KEYS.teamRole(team.id);

  // Hook createRole to simulate lease theft/loss right after Discord role creation succeeds,
  // but before registry persistence occurs.
  const origCreateRole = s.adapter.createRole.bind(s.adapter);
  let createCount = 0;
  let createdRoleId = null;
  s.adapter.createRole = async (opts) => {
    const role = await origCreateRole(opts);
    createCount++;
    createdRoleId = role.id;
    // Invalidate the lease by stealing the role lock right before guarded persistence
    s.store.locks.set(`role-ensure:${key}`, {
      owner: 'lock_thief',
      expiresAt: Date.now() + 60_000,
      fencingToken: 999,
    });
    return role;
  };

  // Attempt ensureRole: creation succeeds in Discord, but persistence must fail due to lease loss
  await assert.rejects(
    () => s.reconciler.ensureRole(key),
    (err) => {
      assert.ok(isLeaseError(err), 'Expected LeaseError on guarded registry write');
      return true;
    }
  );

  // Verify Discord role was created in Discord
  assert.equal(createCount, 1);
  const inDiscord = [...s.adapter.roles.values()].filter((r) => r.name === 'Orphan Recovery Team');
  assert.equal(inDiscord.length, 1);
  assert.equal(inDiscord[0].id, createdRoleId);

  // Verify guarded persistence failed: no registry entry exists yet
  const regBefore = await s.store.get('registry', key);
  assert.equal(regBefore, null, 'Registry must not be updated when lease was lost before persistence');

  // Verify team entity roleId was not updated
  const teamBefore = await s.state.getTeam(team.id);
  assert.equal(teamBefore.roleId, null, 'Team roleId must not be set if persistence failed');

  // Now clear the stolen lock to simulate lock expiry/release allowing retry
  s.store.locks.delete(`role-ensure:${key}`);

  // Retry ensureRole: must safely recover/adopt the existing orphaned Discord role without creating a new one
  const recoveredRoleId = await s.reconciler.ensureRole(key);

  // Verify return value matches the orphaned Discord role
  assert.equal(recoveredRoleId, createdRoleId, 'Retry must return the adopted orphaned role ID');

  // Verify no duplicate role was created in Discord (createRole was not called again)
  assert.equal(createCount, 1, 'createRole must not be called again; role was adopted');
  const inDiscordAfter = [...s.adapter.roles.values()].filter((r) => r.name === 'Orphan Recovery Team');
  assert.equal(inDiscordAfter.length, 1, 'Discord must have exactly one role for Orphan Recovery Team');

  // Verify registry was persisted with adopted role
  const regAfter = await s.store.get('registry', key);
  assert.ok(regAfter);
  assert.equal(regAfter.id, createdRoleId);
  assert.equal(regAfter.adopted, true);

  // Verify team in state has the roleId updated
  const teamAfter = await s.state.getTeam(team.id);
  assert.equal(teamAfter.roleId, createdRoleId);
});

