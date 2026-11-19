import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as F } from 'discord.js';
import { makeEnv } from './helpers/env.js';
import { KEYS } from '../src/core/structure.js';
import { provisionPmWorkspace, auditPmPermissions, repairPmWorkspace } from '../src/core/workspace.js';
import { RetryQueue } from '../src/core/queue.js';

const GRID = '1568690888413282396';
const ADMIN = '1568690393824891141';

async function setupWorkspaceEnv() {
  const env = makeEnv();
  const { state, store, reconciler, adapter, audit, cfg } = env;

  const tFrontend = await state.createTeam({ name: 'Frontend' });
  const tBackend = await state.createTeam({ name: 'Backend' });
  const tDatabase = await state.createTeam({ name: 'Database' });

  // Initial seed of server structure
  await reconciler.run('seed');

  const appliedRoles = [];
  const memberRolesMap = new Map();
  let failRoleApplyFn = null;

  const roles = {
    idFor: (k) => reconciler.getObjectId(k),
    memberRoleKeys: async ({ pmId, teamId }) => ({
      ipdc: await reconciler.getObjectId(KEYS.roleIpdc),
      ...(pmId && { pm: await reconciler.getObjectId(KEYS.pmRole(pmId)) }),
      ...(teamId && { team: await reconciler.getObjectId(KEYS.teamRole(teamId)) }),
    }),
    apply: async (userId, { add = [], remove = [] }) => {
      if (failRoleApplyFn && failRoleApplyFn(userId)) {
        throw new Error(`Discord member fetch/apply failed for ${userId}`);
      }
      appliedRoles.push({ userId, add, remove });
      const current = memberRolesMap.get(userId) || new Set();
      for (const r of add) current.add(r);
      for (const r of remove) current.delete(r);
      memberRolesMap.set(userId, current);
      return { added: add, removed: remove };
    },
  };

  const queue = new RetryQueue(store);
  queue.register('roles.apply', async (p) => {
    await roles.apply(p.userId, { add: p.add, remove: p.remove });
  });

  const messagesSaved = new Map();
  const messages = {
    channelFor: async (k) => ({
      id: await reconciler.getObjectId(k),
      send: async (p) => ({ id: `msg_${messagesSaved.size + 1}`, ...p }),
    }),
    ensure: async (key, channelKey, payload) => {
      messagesSaved.set(key, { channelKey, payload });
      return { id: `msg_${key}`, ...payload };
    },
  };

  const dms = [];
  const client = {
    user: { id: 'bot1' },
    guilds: {
      cache: {
        get: () => ({
          id: cfg.discord.guildId,
          roles: { fetch: async (id) => (id ? adapter.getRole(id) : adapter.roles) },
          channels: { fetch: async (id) => adapter.getChannel(id) },
          members: {
            fetch: async (id) => ({
              id,
              roles: {
                cache: { has: (r) => (memberRolesMap.get(id) || new Set()).has(r) },
                add: async () => {},
                remove: async () => {},
              },
            }),
          },
        }),
      },
    },
    users: {
      fetch: async (id) => ({
        id,
        send: async (payload) => { dms.push({ id, payload }); },
      }),
    },
  };

  const ctx = {
    ...env,
    roles,
    queue,
    messages,
    client,
    tFrontend,
    tBackend,
    tDatabase,
    appliedRoles,
    memberRolesMap,
    messagesSaved,
    dms,
    setFailRoleApply: (fn) => { failRoleApplyFn = fn; },
  };

  return ctx;
}

test('PM workspace provisioning creates unique personal role, channels, and intro content for all active teams', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state, tFrontend, tBackend, tDatabase } = ctx;

  const pm = await state.createPm({ name: 'Rahul Sharma', discordUserId: 'user_rahul' });
  // Simulate stale teamIds with only Frontend and Backend; provisioning backfills all active teams
  await state.updatePm(pm.id, { teamIds: [tFrontend.id, tBackend.id] });

  const res = await provisionPmWorkspace(ctx, pm.id, { welcome: true });
  assert.equal(res.ok, true);

  // 1. Unique PM Role created with proper naming
  const pmRoleId = await ctx.reconciler.getObjectId(KEYS.pmRole(pm.id));
  assert.ok(pmRoleId, 'personal PM role ID persisted in registry');
  const roleObj = await ctx.adapter.getRole(pmRoleId);
  assert.match(roleObj.name, /PM - Rahul Sharma|Rahul Sharma/);

  // 2. Personal PM role + ALL active team roles assigned to PM user
  const lastApply = ctx.appliedRoles.find((a) => a.userId === 'user_rahul');
  assert.ok(lastApply, 'roles were applied to the PM user');
  const ipdcRoleId = await ctx.reconciler.getObjectId(KEYS.roleIpdc);
  const feRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tFrontend.id));
  const beRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tBackend.id));
  const dbRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tDatabase.id));
  assert.ok(lastApply.add.includes(ipdcRoleId), 'PM received IPDC role');
  assert.ok(lastApply.add.includes(pmRoleId), 'PM received personal PM role');
  assert.ok(lastApply.add.includes(feRoleId), 'PM received Frontend team role');
  assert.ok(lastApply.add.includes(beRoleId), 'PM received Backend team role');
  assert.ok(lastApply.add.includes(dbRoleId), 'PM received Database team role (global team inheritance)');

  // 3. Channels created
  assert.ok(ctx.adapter.byName('rahul-sharma-control').length >= 1, 'control channel created');
  assert.ok(ctx.adapter.byName('rahul-sharma-updates').length >= 1, 'updates channel created');
  assert.ok(ctx.adapter.byName('github-activity').length >= 1, 'github-activity channel created');
  assert.ok(ctx.adapter.byName('frontend').length >= 1, 'frontend text channel under PM created');
  assert.ok(ctx.adapter.byName('backend').length >= 1, 'backend text channel under PM created');
  assert.ok(ctx.adapter.byName('database').length >= 1, 'database text channel under PM created');

  // 4. Intro messages ensured
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:panel`), 'PM control panel ensured');
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:intro:updates`), 'PM updates formatting intro ensured');
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:dash`), 'PM github activity intro ensured');
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:team:${tFrontend.id}:intro`), 'team frontend intro ensured');
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:team:${tBackend.id}:intro`), 'team backend intro ensured');
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:team:${tDatabase.id}:intro`), 'team database intro ensured');

  // 5. Onboarding DM sent with channel links
  assert.ok(ctx.dms.length >= 1, 'welcome DM sent to PM');
  const dmDesc = ctx.dms[0].payload.embeds[0].data.description;
  assert.match(dmDesc, /Congratulations/);
});

test('Resource Visibility: PM can view all active team resources and is denied removed resources and admin channels', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state, tFrontend, tBackend, tDatabase } = ctx;

  // Create a removed team to test isolation
  const tRemoved = await state.createTeam({ name: 'Deprecated Ops' });
  await state.updateTeam(tRemoved.id, { status: 'removed' });

  const pm = await state.createPm({ name: 'Ananya Verma', discordUserId: 'user_ananya' });
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  const auditResult = await auditPmPermissions(ctx, pm.id);
  assert.equal(auditResult.pass, true, 'all security checks passed');

  const checks = auditResult.checks;
  // Own control allowed
  assert.ok(checks.find((c) => c.name.includes('Own PM Control') && c.pass));
  // Own updates allowed
  assert.ok(checks.find((c) => c.name.includes('Own PM Updates') && c.pass));
  // Active team resources allowed
  assert.ok(checks.find((c) => c.name.includes('Frontend') && c.expected === 'ALLOWED' && c.pass));
  assert.ok(checks.find((c) => c.name.includes('Backend') && c.expected === 'ALLOWED' && c.pass));
  assert.ok(checks.find((c) => c.name.includes('Database') && c.expected === 'ALLOWED' && c.pass));
  // Removed resource denied
  assert.ok(checks.find((c) => c.name.includes('Deprecated Ops') && c.expected === 'DENIED' && c.pass));
  // Admin control denied
  assert.ok(checks.find((c) => c.name.includes('ADMIN CONTROL') && c.expected === 'DENIED' && c.pass));
  // IPDC GRID private denied
  assert.ok(checks.find((c) => c.name.includes('IPDC GRID') && c.expected === 'DENIED' && c.pass));
});

test('Unauthorized PM access: PM A cannot view PM B personal control or updates channels', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state, tFrontend } = ctx;

  const pmA = await state.createPm({ name: 'PM Alice', discordUserId: 'user_alice' });
  const pmB = await state.createPm({ name: 'PM Bob', discordUserId: 'user_bob' });

  await provisionPmWorkspace(ctx, pmA.id, { welcome: false });
  await provisionPmWorkspace(ctx, pmB.id, { welcome: false });

  // Inspect Bob's control channel overwrites
  const bobControlId = await ctx.reconciler.getObjectId(KEYS.pmControl(pmB.id));
  const bobControlChan = await ctx.adapter.getChannel(bobControlId);
  const ows = await ctx.adapter.getOverwrites(bobControlChan);

  // Alice user ID has no allow overwrite on Bob's control
  assert.equal(ows.has('user_alice'), false, "Alice user ID has no overwrite on Bob's control");

  // Alice's PM role ID has no allow overwrite on Bob's control
  const aliceRoleId = await ctx.reconciler.getObjectId(KEYS.pmRole(pmA.id));
  assert.equal(ows.has(aliceRoleId), false, "Alice's PM role has no overwrite on Bob's control");

  // Everyone is denied ViewChannel on Bob's control
  const ev = ows.get(ctx.adapter.everyoneId);
  assert.ok(ev.deny & F.ViewChannel, 'everyone denied on control channel');
});

test('Idempotency: running workspace provisioning multiple times never duplicates objects or records', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state, tFrontend } = ctx;

  const pm = await state.createPm({ name: 'Sameer Khan', discordUserId: 'user_sameer' });

  // Run 1
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });
  const channelCount1 = ctx.adapter.channels.size;
  const roleCount1 = ctx.adapter.roles.size;
  const messagesCount1 = ctx.messagesSaved.size;

  // Run 2
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });
  const channelCount2 = ctx.adapter.channels.size;
  const roleCount2 = ctx.adapter.roles.size;
  const messagesCount2 = ctx.messagesSaved.size;

  assert.equal(channelCount2, channelCount1, 'no duplicate channels created');
  assert.equal(roleCount2, roleCount1, 'no duplicate roles created');
  assert.equal(messagesCount2, messagesCount1, 'no duplicate messages created');
});

test('Multiple PMs and multiple teams: all active PMs receive all active team roles and channels', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state, tFrontend, tBackend, tDatabase } = ctx;

  const pm1 = await state.createPm({ name: 'Vikram Malhotra', discordUserId: 'user_vikram' });
  const pm2 = await state.createPm({ name: 'Priya Patel', discordUserId: 'user_priya' });

  await provisionPmWorkspace(ctx, pm1.id, { welcome: false });
  await provisionPmWorkspace(ctx, pm2.id, { welcome: false });

  const feRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tFrontend.id));
  const beRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tBackend.id));
  const dbRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tDatabase.id));

  // Verify both received all 3 team roles
  const vRoles = ctx.memberRolesMap.get('user_vikram');
  assert.ok(vRoles.has(feRoleId), 'Vikram received Frontend role');
  assert.ok(vRoles.has(beRoleId), 'Vikram received Backend role');
  assert.ok(vRoles.has(dbRoleId), 'Vikram received Database role');

  const pRoles = ctx.memberRolesMap.get('user_priya');
  assert.ok(pRoles.has(feRoleId), 'Priya received Frontend role');
  assert.ok(pRoles.has(beRoleId), 'Priya received Backend role');
  assert.ok(pRoles.has(dbRoleId), 'Priya received Database role');

  // Both have unique control channels
  assert.ok(ctx.adapter.byName('vikram-malhotra-control').length === 1);
  assert.ok(ctx.adapter.byName('priya-patel-control').length === 1);

  // Cross-isolation verified
  const audit1 = await auditPmPermissions(ctx, pm1.id);
  const audit2 = await auditPmPermissions(ctx, pm2.id);
  assert.equal(audit1.pass, true);
  assert.equal(audit2.pass, true);
});

test('New team added after initial workspace creation is provisioned to existing PMs', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state } = ctx;

  const pm = await state.createPm({ name: 'Deepak Joshi', discordUserId: 'user_deepak' });
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  // Now create a 4th team: Mobile App
  const tMobile = await state.createTeam({ name: 'Mobile App' });
  // Re-provision PM workspace
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  const mobileRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tMobile.id));
  assert.ok(ctx.memberRolesMap.get('user_deepak')?.has(mobileRoleId), 'PM received new Mobile App team role');

  assert.ok(ctx.adapter.byName('mobile-app').length >= 1, 'Mobile App text channel created under PM');
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:team:${tMobile.id}:intro`), 'Mobile App intro ensured');

  const audit = await auditPmPermissions(ctx, pm.id);
  assert.equal(audit.pass, true);
  assert.ok(audit.checks.find((c) => c.name.includes('Mobile App') && c.expected === 'ALLOWED' && c.pass));
});

test('Existing PM missing a Discord role receives the missing role upon provisioning', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state, tDatabase } = ctx;

  const pm = await state.createPm({ name: 'Kavita Rao', discordUserId: 'user_kavita' });
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  // Simulate user losing the Database role in Discord
  const dbRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tDatabase.id));
  ctx.memberRolesMap.get('user_kavita')?.delete(dbRoleId);

  // Clear appliedRoles log to check fresh apply
  ctx.appliedRoles.length = 0;

  // Re-run provisioning
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  // Verify missing role was re-applied
  const applyEntry = ctx.appliedRoles.find((a) => a.userId === 'user_kavita');
  assert.ok(applyEntry, 'roles.apply was executed');
  assert.ok(applyEntry.add.includes(dbRoleId), 'missing Database role was added');
  assert.ok(ctx.memberRolesMap.get('user_kavita')?.has(dbRoleId), 'member now has role');
});

test('Obsolete team role cleanup: removed team role is stripped, protected roles untouched', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state } = ctx;

  const tTemp = await state.createTeam({ name: 'Temporary Task' });
  const pm = await state.createPm({ name: 'Sanjay Dutt', discordUserId: 'user_sanjay' });
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  const tempRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tTemp.id));
  assert.ok(ctx.memberRolesMap.get('user_sanjay')?.has(tempRoleId), 'PM had temp role');

  // Mark team as removed
  await state.updateTeam(tTemp.id, { status: 'removed' });

  ctx.appliedRoles.length = 0;
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  const lastApply = ctx.appliedRoles.find((a) => a.userId === 'user_sanjay');
  assert.ok(lastApply, 'roles.apply was called');
  assert.ok(lastApply.remove.includes(tempRoleId), 'temp team role was removed');

  // Protected roles: never removed or added
  assert.equal(lastApply.remove.includes(GRID), false, 'GRID role never removed');
  assert.equal(lastApply.remove.includes(ADMIN), false, 'ADMIN role never removed');
  assert.equal(lastApply.add.includes(GRID), false, 'GRID role never added');
  assert.equal(lastApply.add.includes(ADMIN), false, 'ADMIN role never added');
});

test('Concurrency: concurrent provisioning calls produce zero duplicate objects and execute safely', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state } = ctx;

  const pm = await state.createPm({ name: 'Arjun Singhania', discordUserId: 'user_arjun' });

  // Run 5 concurrent provisioning operations
  const results = await Promise.all([
    provisionPmWorkspace(ctx, pm.id, { welcome: false }),
    provisionPmWorkspace(ctx, pm.id, { welcome: false }),
    provisionPmWorkspace(ctx, pm.id, { welcome: false }),
    provisionPmWorkspace(ctx, pm.id, { welcome: false }),
    provisionPmWorkspace(ctx, pm.id, { welcome: false }),
  ]);

  assert.equal(results.every((r) => r.ok), true, 'all concurrent calls succeeded');

  // Confirm no duplicate channels for Arjun
  const controls = ctx.adapter.byName('arjun-singhania-control');
  assert.equal(controls.length, 1, 'exactly 1 control channel created');

  const updates = ctx.adapter.byName('arjun-singhania-updates');
  assert.equal(updates.length, 1, 'exactly 1 updates channel created');
});

test('Permission synchronization and retry queueing on Discord API failure', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state } = ctx;

  const pm = await state.createPm({ name: 'Meera Nair', discordUserId: 'user_meera' });

  // Simulate Discord API failure for roles.apply
  ctx.setFailRoleApply((userId) => userId === 'user_meera');

  // Provisioning should not throw an unhandled error; it handles gracefully and enqueues retry
  const res = await provisionPmWorkspace(ctx, pm.id, { welcome: false });
  assert.equal(res.ok, true, 'provisioning completed gracefully');

  // Check queue
  const jobs = await ctx.store.list('queue');
  const syncJob = jobs.find((j) => j.payload?.userId === 'user_meera');
  assert.ok(syncJob, 'retry job was enqueued in ctx.queue');
  assert.equal(syncJob.type, 'roles.apply');
  assert.equal(syncJob.payload.userId, 'user_meera');

  // Clear failure flag and process queue
  ctx.setFailRoleApply(null);
  await ctx.queue.process();

  // Verify roles now applied
  const applied = ctx.appliedRoles.find((a) => a.userId === 'user_meera');
  assert.ok(applied, 'roles applied after queue process');
});

test('Audit and repair: auditPmPermissions detects missing teams and repairPmWorkspace reconciles them', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state, tFrontend, tBackend, tDatabase } = ctx;

  const pm = await state.createPm({ name: 'Nikhil Roy', discordUserId: 'user_nikhil' });

  // Manually create stale state with only Frontend
  await state.updatePm(pm.id, { teamIds: [tFrontend.id] });

  // Audit detects missing global teams
  const initialAudit = await auditPmPermissions(ctx, pm.id, { auditGlobal: true });
  assert.equal(initialAudit.missingGlobalTeams.length, 2, 'detects 2 missing global teams');
  assert.ok(initialAudit.missingGlobalTeams.some((t) => t.id === tBackend.id));
  assert.ok(initialAudit.missingGlobalTeams.some((t) => t.id === tDatabase.id));

  // Run repairPmWorkspace
  const repairRes = await repairPmWorkspace(ctx, pm.id);
  assert.equal(repairRes.ok, true);
  assert.equal(repairRes.repaired, true);

  // Fresh audit shows all global teams assigned and passing
  const repairedAudit = await auditPmPermissions(ctx, pm.id, { auditGlobal: true });
  assert.equal(repairedAudit.missingGlobalTeams.length, 0, 'zero missing teams after repair');
  assert.equal(repairedAudit.pass, true, 'all checks passed after repair');
});
