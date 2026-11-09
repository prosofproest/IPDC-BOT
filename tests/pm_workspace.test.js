import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as F } from 'discord.js';
import { makeEnv } from './helpers/env.js';
import { KEYS } from '../src/core/structure.js';
import { provisionPmWorkspace, auditPmPermissions } from '../src/core/workspace.js';

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
  const roles = {
    idFor: (k) => reconciler.getObjectId(k),
    memberRoleKeys: async ({ pmId, teamId }) => ({
      ipdc: await reconciler.getObjectId(KEYS.roleIpdc),
      ...(pmId && { pm: await reconciler.getObjectId(KEYS.pmRole(pmId)) }),
      ...(teamId && { team: await reconciler.getObjectId(KEYS.teamRole(teamId)) }),
    }),
    apply: async (userId, { add = [], remove = [] }) => {
      appliedRoles.push({ userId, add, remove });
      // Simulate member role cache in adapter/guild
      return { added: add, removed: remove };
    },
  };

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
                cache: { has: (r) => appliedRoles.some((a) => a.userId === id && a.add.includes(r)) },
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
    messages,
    client,
    tFrontend,
    tBackend,
    tDatabase,
    appliedRoles,
    messagesSaved,
    dms,
  };

  return ctx;
}

test('PM workspace provisioning creates unique personal role, channels, and intro content', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state, tFrontend, tBackend } = ctx;

  const pm = await state.createPm({ name: 'Rahul Sharma', discordUserId: 'user_rahul' });
  await state.updatePm(pm.id, { teamIds: [tFrontend.id, tBackend.id] });

  const res = await provisionPmWorkspace(ctx, pm.id, { welcome: true });
  assert.equal(res.ok, true);

  // 1. Unique PM Role created with proper naming
  const pmRoleId = await ctx.reconciler.getObjectId(KEYS.pmRole(pm.id));
  assert.ok(pmRoleId, 'personal PM role ID persisted in registry');
  const roleObj = await ctx.adapter.getRole(pmRoleId);
  assert.match(roleObj.name, /PM - Rahul Sharma|Rahul Sharma/);

  // 2. Personal PM role + assigned team roles assigned to PM user
  const lastApply = ctx.appliedRoles.find((a) => a.userId === 'user_rahul');
  assert.ok(lastApply, 'roles were applied to the PM user');
  const ipdcRoleId = await ctx.reconciler.getObjectId(KEYS.roleIpdc);
  const feRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tFrontend.id));
  const beRoleId = await ctx.reconciler.getObjectId(KEYS.teamRole(tBackend.id));
  assert.ok(lastApply.add.includes(ipdcRoleId), 'PM received IPDC role');
  assert.ok(lastApply.add.includes(pmRoleId), 'PM received personal PM role');
  assert.ok(lastApply.add.includes(feRoleId), 'PM received Frontend team role');
  assert.ok(lastApply.add.includes(beRoleId), 'PM received Backend team role');

  // 3. Channels created
  assert.ok(ctx.adapter.byName('rahul-sharma-control').length >= 1, 'control channel created');
  assert.ok(ctx.adapter.byName('rahul-sharma-updates').length >= 1, 'updates channel created');
  assert.ok(ctx.adapter.byName('github-activity').length >= 1, 'github-activity channel created');
  assert.ok(ctx.adapter.byName('frontend').length >= 1, 'frontend text channel under PM created');
  assert.ok(ctx.adapter.byName('backend').length >= 1, 'backend text channel under PM created');

  // 4. Intro messages ensured
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:panel`), 'PM control panel ensured');
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:intro:updates`), 'PM updates formatting intro ensured');
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:dash`), 'PM github activity intro ensured');
  assert.ok(ctx.messagesSaved.has(`pm:${pm.id}:team:${tFrontend.id}:intro`), 'team frontend intro ensured');

  // 5. Onboarding DM sent with channel links
  assert.ok(ctx.dms.length >= 1, 'welcome DM sent to PM');
  const dmDesc = ctx.dms[0].payload.embeds[0].data.description;
  assert.match(dmDesc, /Congratulations/);
});

test('Resource Visibility: PM can view assigned team resources and is denied unassigned resources', async () => {
  const ctx = await setupWorkspaceEnv();
  const { state, tFrontend, tDatabase } = ctx;

  // PM Ananya manages Frontend only
  const pm = await state.createPm({ name: 'Ananya Verma', discordUserId: 'user_ananya' });
  await state.updatePm(pm.id, { teamIds: [tFrontend.id] });

  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  const auditResult = await auditPmPermissions(ctx, pm.id);
  assert.equal(auditResult.pass, true, 'all security checks passed');

  const checks = auditResult.checks;
  // Own control allowed
  assert.ok(checks.find((c) => c.name.includes('Own PM Control') && c.pass));
  // Own updates allowed
  assert.ok(checks.find((c) => c.name.includes('Own PM Updates') && c.pass));
  // Assigned resource allowed
  assert.ok(checks.find((c) => c.name.includes('Frontend') && c.expected === 'ALLOWED' && c.pass));
  // Unassigned resource denied
  assert.ok(checks.find((c) => c.name.includes('Database') && c.expected === 'DENIED' && c.pass));
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
  await state.updatePm(pmA.id, { teamIds: [tFrontend.id] });
  await state.updatePm(pmB.id, { teamIds: [tFrontend.id] });

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
  await state.updatePm(pm.id, { teamIds: [tFrontend.id] });

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

