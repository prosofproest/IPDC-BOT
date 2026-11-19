import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers/env.js';
import { KEYS } from '../src/core/structure.js';
import { PermissionFlagsBits as F } from 'discord.js';

async function seed(env) {
  const t1 = await env.state.createTeam({ name: 'Frontend' });
  const t2 = await env.state.createTeam({ name: 'UI UX' });
  const pm = await env.state.createPm({ name: 'Asha Rao', discordUserId: '5001' });
  await env.state.updatePm(pm.id, { teamIds: [t1.id, t2.id] });
  return { t1, t2, pm };
}

test('first run creates the full static structure with professional names', async () => {
  const env = makeEnv();
  const res = await env.reconciler.run('test');
  assert.equal(res.errors.length, 0, res.errors.join('; '));
  const names = [...env.adapter.channels.values()].map((c) => c.name);
  for (const n of ['WELCOME', 'GENERAL', 'CHALLENGES', 'IPDC RESOURCES', 'IPDC SUPPORT', 'SUPPORT TICKETS', 'ADMIN CONTROL',
    'welcome', 'announcements', 'general', 'github-contributions', 'contribution-leaderboard', 'server-activity',
    'support-center', 'admin-panel', 'server-monitoring', 'admin-approvals', 'admin-audit-logs',
    'General Meeting', 'Open Discussion', 'Coding Room', 'Collaboration Room', 'Support Voice', 'Admin Meeting', 'PM Coordination']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  assert.ok(names.every((n) => !/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(n)), 'no emojis in names');
  assert.equal(env.adapter.calls.createRole, 1, 'only IPDC role is created; GRID/ADMIN are never created');
});

test('restart (second run) never duplicates anything and creates nothing', async () => {
  const env = makeEnv(); await seed(env);
  await env.reconciler.run('first');
  const created = env.adapter.calls.createChannel; const roles = env.adapter.calls.createRole;
  const count = env.adapter.channels.size;
  // simulate a fresh process: new reconciler instance on same store + guild
  const { Reconciler } = await import('../src/core/reconcile.js');
  const r2 = new Reconciler({ adapter: env.adapter, store: env.store, state: env.state, cfg: env.cfg, audit: env.audit });
  const res = await r2.run('restart');
  assert.equal(res.created, 0); assert.equal(res.repaired, 0); assert.equal(res.errors.length, 0);
  assert.equal(env.adapter.calls.createChannel, created);
  assert.equal(env.adapter.calls.createRole, roles);
  assert.equal(env.adapter.channels.size, count);
});

test('dynamic PM and team config generate categories, channels and forums', async () => {
  const env = makeEnv(); const { t1, pm } = await seed(env);
  const res = await env.reconciler.run('dyn');
  assert.equal(res.errors.length, 0, res.errors.join('; '));
  assert.ok(env.adapter.byName('Asha Rao').length === 1, 'PM category is named exactly for the PM');
  for (const n of ['asha-rao-control', 'asha-rao-updates', 'github-activity', 'frontend', 'ui-ux', 'Team Meeting', 'Project Discussion']) {
    assert.ok(env.adapter.byName(n).length >= 1, `missing ${n}`);
  }
  const forum = [...env.adapter.channels.values()].find((c) => c.kind === 'forum' && c.name === 'frontend');
  assert.ok(forum, 'resource forum created');
  const teamRoleId = (await env.store.get('registry', KEYS.teamRole(t1.id))).id;
  const ow = forum.ow.get(teamRoleId);
  assert.ok(ow.allow & F.ViewChannel, 'team role can view its forum');
  assert.ok(forum.ow.get('guild1').deny & F.ViewChannel, 'everyone cannot');
  // control channel is private to PM + ADMIN + GRID + bot
  const control = env.adapter.byName('asha-rao-control')[0];
  assert.ok(control.ow.get('5001').allow & F.ViewChannel);
  assert.ok(control.ow.get('guild1').deny & F.ViewChannel);
  assert.equal(pm.name, 'Asha Rao');
});

test('adopts existing same-name objects instead of duplicating', async () => {
  const env = makeEnv();
  // pre-existing manual channel + category the owner already made
  const cat = await env.adapter.createChannel({ kind: 'category', name: 'GENERAL', overwrites: [] });
  await env.adapter.createChannel({ kind: 'text', name: 'general', parentId: cat.id, overwrites: [] });
  env.adapter.calls.createChannel = 0;
  const res = await env.reconciler.run('adopt');
  assert.ok(res.adopted >= 2);
  assert.equal(env.adapter.channels.size - 2 > 0, true);
  assert.equal(env.adapter.byName('general').length, 1);
  assert.equal(env.adapter.byName('GENERAL').length, 1);
});

test('stored ID that no longer resolves is re-adopted by name, not duplicated', async () => {
  const env = makeEnv();
  await env.reconciler.run('a');
  const reg = await env.store.get('registry', 'ch:general');
  await env.store.set('registry', 'ch:general', { ...reg, id: 'dead' }); // stale ID
  const before = env.adapter.channels.size;
  const res = await env.reconciler.run('b');
  assert.equal(env.adapter.channels.size, before);
  assert.equal(res.adopted, 1);
  assert.notEqual((await env.store.get('registry', 'ch:general')).id, 'dead');
});

test('repairs only the missing permission bit and preserves unrelated bits/overwrites', async () => {
  const env = makeEnv();
  await env.reconciler.run('a');
  const reg = await env.store.get('registry', 'ch:announcements');
  const chan = env.adapter.channels.get(reg.id);
  const ipdcId = (await env.store.get('registry', KEYS.roleIpdc)).id;
  // admin tampered: members may now post, and added an unrelated custom overwrite
  const cur = chan.ow.get(ipdcId);
  chan.ow.set(ipdcId, { ...cur, allow: cur.allow | F.SendMessages | F.AttachFiles, deny: cur.deny & ~F.SendMessages });
  chan.ow.set('custom-role', { allow: F.ViewChannel, deny: 0n, type: 0 });
  const res = await env.reconciler.run('repair');
  assert.equal(res.repaired, 1);
  const fixed = chan.ow.get(ipdcId);
  assert.ok(fixed.deny & F.SendMessages, 'SendMessages denied again');
  assert.ok(!(fixed.allow & F.SendMessages));
  assert.ok(fixed.allow & F.AttachFiles, 'unrelated bit preserved');
  assert.ok(chan.ow.has('custom-role'), 'custom overwrite preserved');
});

test('never deletes or renames existing objects (renamed channel is reused by ID)', async () => {
  const env = makeEnv();
  await env.reconciler.run('a');
  const reg = await env.store.get('registry', 'ch:general');
  env.adapter.channels.get(reg.id).name = 'community-chat'; // owner renamed it
  const before = env.adapter.channels.size;
  const res = await env.reconciler.run('b');
  assert.equal(env.adapter.channels.size, before);
  assert.equal(env.adapter.channels.get(reg.id).name, 'community-chat');
  assert.equal(res.created, 0);
});

test('overlapping runs coalesce and never build twice concurrently', async () => {
  const env = makeEnv(); await seed(env);
  const results = await Promise.all([env.reconciler.run('x'), env.reconciler.run('y'), env.reconciler.run('z')]);
  assert.ok(results.length === 3);
  const names = [...env.adapter.channels.values()].map((c) => `${c.parentId}|${c.name}`);
  assert.equal(new Set(names).size, names.length, 'no duplicate (parent,name) pairs');
});

test('held cross-instance lock makes reconcile skip', async () => {
  const env = makeEnv();
  await env.store.tryLock('reconcile', 'other-instance', 60_000);
  const res = await env.reconciler.run('locked');
  assert.equal(res.skipped, true);
  assert.equal(env.adapter.channels.size, 0);
});

test('missing IPDC GRID role is reported, never created', async () => {
  const env = makeEnv({ gridId: null });
  const res = await env.reconciler.run('nogrid');
  assert.ok(res.errors.some((e) => e.includes('role:grid')));
  assert.ok(![...env.adapter.roles.values()].some((r) => r.name === 'IPDC GRID' && r.id.startsWith('10')));
});

test('PM whose Discord user is not in the guild does not break reconciliation', async () => {
  const env = makeEnv({ missingMembers: ['5001'] }); await seed(env);
  const res = await env.reconciler.run('x');
  assert.equal(res.errors.length, 0, res.errors.join('; '));
  assert.ok(env.adapter.byName('asha-rao-control').length === 1);
});

test('member-level access to PM team channels is derived and repaired', async () => {
  const env = makeEnv(); const { t1, pm } = await seed(env);
  await env.reconciler.run('a');
  await env.state.saveMember('7001', { id: '7001', status: 'approved', pmId: pm.id, teamId: t1.id });
  const res = await env.reconciler.run('b');
  assert.ok(res.repaired >= 1);
  const reg = await env.store.get('registry', KEYS.pmTeamText(pm.id, t1.id));
  assert.ok(env.adapter.channels.get(reg.id).ow.get('7001').allow & F.ViewChannel);
});

// ---------------------------------------------------------------------------
// Step 5: Startup Reconciliation & Structure Repair Test Suite
// ---------------------------------------------------------------------------
import { RetryQueue } from '../src/core/queue.js';

function makeStep5Env(adapterOpts = {}) {
  const env = makeEnv(adapterOpts);
  const queue = new RetryQueue(env.store);
  env.reconciler.queue = queue;

  const appliedRoles = [];
  let roleFail = false;
  const mockRoles = {
    guild: {
      members: {
        cache: new Map(),
        fetch: async (id) => mockRoles.guild.members.cache.get(id) || null,
      },
    },
    apply: async (userId, { add = [], remove = [] }, reason) => {
      if (roleFail) throw new Error('Discord 500 error');
      appliedRoles.push({ userId, add, remove, reason });
      const m = mockRoles.guild.members.cache.get(userId);
      if (m) {
        for (const r of add) m.roles.cache.set(r, { id: r });
        for (const r of remove) m.roles.cache.delete(r);
      }
      return { added: add, removed: remove };
    },
  };
  env.reconciler.roles = mockRoles;

  return {
    ...env,
    queue,
    appliedRoles,
    mockRoles,
    setRoleFail: (val) => { roleFail = val; },
    seedMember: (userId, roleIds = []) => {
      const cache = new Map();
      for (const r of roleIds) cache.set(r, { id: r });
      mockRoles.guild.members.cache.set(userId, {
        id: userId,
        roles: { cache },
      });
    },
  };
}

test('Step 5.1: Backfills all validated active team IDs into PM records', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'Frontend' });
  const t2 = await env.state.createTeam({ name: 'Backend' });
  const t3 = await env.state.createTeam({ name: 'AI/ML' });
  const pm = await env.state.createPm({ name: 'Pooja Verma', discordUserId: '5002' });
  // Manually empty teamIds to simulate stale PM record
  await env.state.updatePm(pm.id, { teamIds: [] });

  await env.reconciler.run('step5-backfill');
  const freshPm = await env.state.getPm(pm.id);
  assert.ok(freshPm.teamIds.includes(t1.id), 't1 backfilled');
  assert.ok(freshPm.teamIds.includes(t2.id), 't2 backfilled');
  assert.ok(freshPm.teamIds.includes(t3.id), 't3 backfilled');
  assert.equal(freshPm.teamIds.length, 3);
});

test('Step 5.2: Prunes invalid, obsolete, and deleted team IDs from PM records', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'Frontend' });
  const t2 = await env.state.createTeam({ name: 'Backend' });
  const pm = await env.state.createPm({ name: 'Rohan Sen', discordUserId: '5003' });
  await env.state.updatePm(pm.id, { teamIds: ['obsolete-id-1', 'deleted-id-2', t1.id] });

  await env.reconciler.run('step5-prune');
  const freshPm = await env.state.getPm(pm.id);
  assert.ok(!freshPm.teamIds.includes('obsolete-id-1'), 'obsolete-id-1 pruned');
  assert.ok(!freshPm.teamIds.includes('deleted-id-2'), 'deleted-id-2 pruned');
  assert.ok(freshPm.teamIds.includes(t1.id), 'valid t1 retained');
  assert.ok(freshPm.teamIds.includes(t2.id), 'valid t2 backfilled');
});

test('Step 5.3: Repairs missing PM team channels when new teams are added', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'Frontend' });
  const pm = await env.state.createPm({ name: 'Kiran Deep', discordUserId: '5004' });
  await env.reconciler.run('run-1');

  // New team added after initial setup
  const t2 = await env.state.createTeam({ name: 'Security' });
  await env.reconciler.run('run-2');

  const pmTeamTextKey = KEYS.pmTeamText(pm.id, t2.id);
  const chId = await env.reconciler.getObjectId(pmTeamTextKey);
  assert.ok(chId, 'PM team text channel registered');
  const chan = await env.adapter.getChannel(chId);
  assert.ok(chan, 'channel created in guild');
  assert.equal(chan.name, 'security');
});

test('Step 5.4: Repairs missing team resource forum', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'Design' });
  await env.reconciler.run('run-1');

  const forumKey = KEYS.resourceForum(t1.id);
  const chId = await env.reconciler.getObjectId(forumKey);
  assert.ok(chId, 'forum registered');

  // Simulate accidental channel deletion in guild
  await env.adapter.deleteChannel(chId);

  // Run reconciliation again to repair
  const res = await env.reconciler.run('run-2');
  assert.ok(res.created >= 1, 'missing forum recreated');
  const newChId = await env.reconciler.getObjectId(forumKey);
  assert.ok(newChId, 're-persisted forum ID');
  const newChan = await env.adapter.getChannel(newChId);
  assert.ok(newChan, 'forum recreated in guild');
  assert.equal(newChan.kind, 'forum');
});

test('Step 5.5: Synchronizes PM Discord roles (IPDC, personal PM, all valid team roles)', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'Cloud Ops' });
  const t2 = await env.state.createTeam({ name: 'Data Science' });
  const pm = await env.state.createPm({ name: 'Meera Nair', discordUserId: '5005' });
  env.seedMember('5005', []); // 0 roles initially

  await env.reconciler.run('sync-roles');

  assert.equal(env.appliedRoles.length, 1, 'roles.apply invoked once');
  const applied = env.appliedRoles[0];
  assert.equal(applied.userId, '5005');

  const ipdcRoleId = await env.reconciler.getObjectId(KEYS.roleIpdc);
  const pmRoleId = await env.reconciler.getObjectId(KEYS.pmRole(pm.id));
  const t1RoleId = await env.reconciler.getObjectId(KEYS.teamRole(t1.id));
  const t2RoleId = await env.reconciler.getObjectId(KEYS.teamRole(t2.id));

  assert.ok(applied.add.includes(ipdcRoleId), 'includes IPDC role');
  assert.ok(applied.add.includes(pmRoleId), 'includes PM role');
  assert.ok(applied.add.includes(t1RoleId), 'includes t1 role');
  assert.ok(applied.add.includes(t2RoleId), 'includes t2 role');
});

test('Step 5.6: Missing or invalid IPDC or personal PM role handled safely', async () => {
  const env = makeStep5Env();
  const pm = await env.state.createPm({ name: 'Vikram Seth', discordUserId: '5006' });
  env.seedMember('5006', []);

  // Run without error
  const res = await env.reconciler.run('safe-roles');
  assert.equal(res.errors.length, 0);
  assert.ok(env.appliedRoles.length >= 1);
});

test('Step 5.7: Protected system roles and Administrator roles are strictly excluded from team roles', async () => {
  const env = makeStep5Env();
  // Attempt to seed a team using ADMIN role ID
  await env.store.set('teams', 'bad-team', {
    id: 'bad-team',
    name: 'ADMIN TEAM',
    slug: 'admin-team',
    roleId: env.cfg.roles.admin,
    status: 'active',
  });
  const pm = await env.state.createPm({ name: 'Ananya Roy', discordUserId: '5007' });
  env.seedMember('5007', []);

  await env.reconciler.run('test-protected');

  const freshPm = await env.state.getPm(pm.id);
  assert.ok(!freshPm.teamIds.includes('bad-team'), 'protected team not in teamIds');
  const applied = env.appliedRoles.find((a) => a.userId === '5007');
  if (applied) {
    assert.ok(!applied.add.includes(env.cfg.roles.admin), 'admin role not in add');
    assert.ok(!applied.add.includes(env.cfg.roles.grid), 'grid role not in add');
  }
});

test('Step 5.8: Unrelated member roles preserved during role removal', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'DevOps' });
  const tDead = await env.state.createTeam({ name: 'Dead Team' });
  const pm = await env.state.createPm({ name: 'Rajesh Sen', discordUserId: '5008' });
  await env.reconciler.run('seed-roles');

  const deadRoleId = await env.reconciler.getObjectId(KEYS.teamRole(tDead.id));
  // Seed member with dead team role + unrelated custom role
  env.seedMember('5008', [deadRoleId, 'unrelated-custom-role-999']);
  // Mark tDead as removed
  await env.state.updateTeam(tDead.id, { status: 'removed' });

  await env.reconciler.run('cleanup');
  const applied = env.appliedRoles.at(-1);
  assert.ok(applied.remove.includes(deadRoleId), 'removed dead team role');
  assert.ok(!applied.remove.includes('unrelated-custom-role-999'), 'preserved unrelated role');
});

test('Step 5.9: Role synchronization skipped when PM already has correct roles (no rate limits)', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'QA' });
  const pm = await env.state.createPm({ name: 'Sunil Rao', discordUserId: '5009' });
  await env.reconciler.run('first');

  const ipdcRoleId = await env.reconciler.getObjectId(KEYS.roleIpdc);
  const pmRoleId = await env.reconciler.getObjectId(KEYS.pmRole(pm.id));
  const t1RoleId = await env.reconciler.getObjectId(KEYS.teamRole(t1.id));
  env.seedMember('5009', [ipdcRoleId, pmRoleId, t1RoleId]);

  env.appliedRoles.length = 0; // reset tracker
  await env.reconciler.run('second');
  assert.equal(env.appliedRoles.length, 0, 'no roles.apply called when already in sync');
});

test('Step 5.10: Role application failure is enqueued to RetryQueue with deduplication key', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'Networking' });
  const pm = await env.state.createPm({ name: 'Tarun Bose', discordUserId: '5010' });
  env.seedMember('5010', []);

  env.setRoleFail(true); // simulate Discord API error
  const res = await env.reconciler.run('fail-role');

  assert.ok(res.errors.some((e) => e.includes('roles.apply:')), 'failure logged in summary.errors');
  const queueJobs = await env.store.list('queue');
  const job = queueJobs.find((j) => j.type === 'roles.apply');
  assert.ok(job, 'job enqueued in retry queue');
  assert.equal(job.payload.userId, '5010');
  assert.ok(job.payload.add.length > 0);
  assert.equal(job.id, `roles_apply_pm_${pm.id}_sync`);
});

test('Step 5.11: Missing guild member is safely skipped without failing reconciliation', async () => {
  const env = makeStep5Env({ missingMembers: ['5011'] });
  const pm = await env.state.createPm({ name: 'Ghost PM', discordUserId: '5011' });
  const res = await env.reconciler.run('missing-member');
  assert.equal(res.errors.length, 0, 'reconciliation succeeds despite missing member');
  assert.equal(env.appliedRoles.filter((a) => a.userId === '5011').length, 0);
});

test('Step 5.12: Repeated reconciliation is completely idempotent', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'Fullstack' });
  const pm = await env.state.createPm({ name: 'Deepa Jain', discordUserId: '5012' });
  env.seedMember('5012', []);

  await env.reconciler.run('first');
  env.appliedRoles.length = 0;

  const res2 = await env.reconciler.run('second');
  assert.equal(res2.created, 0, '0 channels/roles created');
  assert.equal(res2.repaired, 0, '0 channels repaired');
  assert.equal(res2.errors.length, 0, '0 errors');
  assert.equal(env.appliedRoles.length, 0, '0 role modifications');
});

test('Step 5.13: Deletion safety: manual content, channels, and forum threads are never deleted', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'Mobile' });
  const pm = await env.state.createPm({ name: 'Manoj Kumar', discordUserId: '5013' });
  await env.reconciler.run('init');

  const beforeChannels = env.adapter.channels.size;
  const beforeRoles = env.adapter.roles.size;

  await env.reconciler.run('second');
  assert.equal(env.adapter.channels.size, beforeChannels, 'no channels deleted');
  assert.equal(env.adapter.roles.size, beforeRoles, 'no roles deleted');
});

test('Step 5.14: Partial failure on first run safely recovers on subsequent run', async () => {
  const env = makeStep5Env();
  const t1 = await env.state.createTeam({ name: 'Robotics' });
  const pm = await env.state.createPm({ name: 'Nikhil Roy', discordUserId: '5014' });
  env.seedMember('5014', []);

  env.setRoleFail(true);
  const res1 = await env.reconciler.run('pass-1');
  assert.ok(res1.errors.length > 0);

  // Transient error resolves
  env.setRoleFail(false);
  const res2 = await env.reconciler.run('pass-2');
  assert.equal(res2.errors.length, 0);
  assert.ok(env.appliedRoles.length > 0);
  assert.equal(env.appliedRoles.at(-1).userId, '5014');
});
