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
    'welcome', 'announcements', 'general', 'github-contributions', 'contribution-leaderboard', 'server-activity', 'github-challenges',
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
