import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as F } from 'discord.js';
import { makeEnv } from './helpers/env.js';
import { KEYS } from '../src/core/structure.js';
import { provisionPmWorkspace, auditPmPermissions } from '../src/core/workspace.js';
import { handleRoleCreate, handleRoleUpdate, handleRoleDelete, isProtectedRole } from '../src/core/dynamicRoles.js';
import { Managed } from '../src/core/managed.js';

async function setupDynamicEnv() {
  const env = makeEnv();
  const { state, store, reconciler, adapter, audit, cfg } = env;

  const tFrontend = await state.createTeam({ name: 'Frontend' });
  const tBackend = await state.createTeam({ name: 'Backend' });

  await reconciler.run('seed');

  const appliedRoles = [];
  const roles = {
    idFor: (k) => reconciler.getObjectId(k),
    apply: async (userId, { add = [], remove = [] }) => {
      appliedRoles.push({ userId, add, remove });
      return { added: add, removed: remove };
    },
  };

  const messagesSaved = new Map();
  const threadsCreated = [];
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

  const client = {
    user: { id: 'bot1', tag: 'IPDC#3219' },
    channels: {
      fetch: async (id) => {
        const ch = adapter.channels.get(id);
        if (!ch) return null;
        return {
          id: ch.id,
          name: ch.name,
          type: ch.kind === 'forum' ? 15 : 0,
          threads: {
            fetchActive: async () => ({ threads: threadsCreated.filter((th) => th.channelId === id) }),
            create: async (opts) => {
              const th = { id: `th_${threadsCreated.length + 1}`, channelId: id, name: opts.name, message: opts.message };
              threadsCreated.push(th);
              return th;
            },
          },
        };
      },
    },
    guilds: {
      cache: {
        get: () => ({
          id: cfg.discord.guildId,
          roles: {
            fetch: async (id) => {
              if (id) {
                const r = adapter.roles.get(id);
                return r ? { ...r, setName: async (n) => adapter.renameRole(id, n), delete: async () => adapter.deleteRole(id) } : null;
              }
              return new Map([...adapter.roles.entries()].map(([k, v]) => [k, { ...v, setName: async (n) => adapter.renameRole(k, n), delete: async () => adapter.deleteRole(k) }]));
            },
          },
          channels: {
            fetch: async (id) => {
              if (id) {
                const c = adapter.channels.get(id);
                return c ? { ...c, setName: async (n) => { c.name = n; }, delete: async () => adapter.deleteChannel(id) } : null;
              }
              return adapter.channels;
            },
          },
          members: {
            fetch: async (id) => ({
              id,
              roles: {
                cache: { has: (r) => appliedRoles.some((a) => a.userId === id && a.add.includes(r)) },
              },
            }),
          },
        }),
      },
    },
  };

  const managed = new Managed({ client, store, cfg, state });

  return {
    ...env,
    roles,
    messages,
    client,
    managed,
    tFrontend,
    tBackend,
    appliedRoles,
    messagesSaved,
    threadsCreated,
  };
}

test('Dynamic Role Lifecycle: automatic detection and Firestore registration', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter } = ctx;

  // 1. Admin creates a new Discord role "AI/ML"
  const discordRole = await adapter.createRole({ name: 'AI/ML' });
  assert.ok(discordRole.id);

  // 2. Trigger role creation handler
  const res = await handleRoleCreate(ctx, discordRole);
  assert.equal(res.handled, true);
  assert.equal(res.type, 'team');

  // 3. Verify Firestore registration
  const teamInDb = await state.teamByRole(discordRole.id);
  assert.ok(teamInDb, 'team registered in Firestore');
  assert.equal(teamInDb.name, 'AI/ML');
  assert.equal(teamInDb.slug, 'aiml');
  assert.equal(teamInDb.status, 'active');

  // 4. Verify Resource Forum created under IPDC RESOURCES
  const forum = adapter.byName(teamInDb.slug).find((c) => c.kind === 'forum');
  assert.ok(forum, 'resource forum created');

  // 5. Verify Permissions: @everyone denied, AI/ML role allowed
  const ows = await adapter.getOverwrites(forum);
  const everyoneOw = ows.get(adapter.everyoneId);
  assert.ok(everyoneOw && (everyoneOw.deny & F.ViewChannel), '@everyone denied ViewChannel');

  const roleOw = ows.get(discordRole.id);
  assert.ok(roleOw && (roleOw.allow & F.ViewChannel), 'AI/ML role allowed ViewChannel');

  // 6. Verify resource forum is kept empty (no automatic/dummy posts created) and ready for manual posting
  const forumThreads = ctx.threadsCreated.filter((th) => th.channelId === forum.id);
  assert.equal(forumThreads.length, 0, 'resource forum is kept empty ready for manual admin posting');

  // 7. Verify Admin Panel reflection
  const allTeams = await state.teams();
  assert.ok(allTeams.some((t) => t.id === teamInDb.id), 'Admin Panel team list includes AI/ML');
});

test('Dynamic PM Integration: PM can manage and assign the new dynamic role', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter } = ctx;

  // Create dynamic role AI/ML
  const discordRole = await adapter.createRole({ name: 'AI/ML' });
  const { team: teamAiMl } = await handleRoleCreate(ctx, discordRole);

  // PM Hruthwick assigns AI/ML to their workspace
  const pm = await state.createPm({ name: 'Hruthwick T N', discordUserId: 'user_hruthwick' });
  await state.updatePm(pm.id, { teamIds: [teamAiMl.id] });

  // Provision workspace
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  // 1. Team channel created inside PM category
  const pmTeamChan = adapter.byName(teamAiMl.slug).find((c) => c.kind === 'text');
  assert.ok(pmTeamChan, 'team channel created under PM');

  // 2. PM received the AI/ML role
  const lastApply = ctx.appliedRoles.find((a) => a.userId === pm.discordUserId);
  assert.ok(lastApply.add.includes(discordRole.id), 'PM received the AI/ML team role');

  // 3. Permission audit: PM can view AI/ML resource forum
  const audit = await auditPmPermissions(ctx, pm.id);
  assert.equal(audit.pass, true);
  const aiMlCheck = audit.checks.find((c) => c.name.includes('AI/ML'));
  assert.ok(aiMlCheck && aiMlCheck.pass && aiMlCheck.expected === 'ALLOWED');

  // 4. Unauthorized PM cannot view AI/ML
  const otherPm = await state.createPm({ name: 'Other PM', discordUserId: 'user_other' });
  await state.updatePm(otherPm.id, { teamIds: [ctx.tFrontend.id] });
  await provisionPmWorkspace(ctx, otherPm.id, { welcome: false });

  const otherAudit = await auditPmPermissions(ctx, otherPm.id);
  const unauthCheck = otherAudit.checks.find((c) => c.name.includes('AI/ML'));
  assert.ok(unauthCheck && unauthCheck.pass && unauthCheck.expected === 'DENIED');
});

test('Dynamic Role Lifecycle: role renaming updates team, slug, and channels', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter } = ctx;

  const discordRole = await adapter.createRole({ name: 'DevOps' });
  const { team } = await handleRoleCreate(ctx, discordRole);

  const pm = await state.createPm({ name: 'DevOps Lead', discordUserId: 'user_devops' });
  await state.updatePm(pm.id, { teamIds: [team.id] });
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  // Rename role in Discord to "Cloud & DevOps"
  const oldRole = { id: discordRole.id, name: 'DevOps' };
  const newRole = { id: discordRole.id, name: 'Cloud & DevOps' };
  adapter.roles.get(discordRole.id).name = newRole.name;

  const res = await handleRoleUpdate(ctx, oldRole, newRole);
  assert.equal(res.handled, true);

  // Firestore updated
  const updatedTeam = await state.getTeam(team.id);
  assert.equal(updatedTeam.name, 'Cloud & DevOps');
  assert.equal(updatedTeam.slug, 'cloud-devops');
});

test('Dynamic Role Lifecycle: role deletion safely cleans up resources without losing user data', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter } = ctx;

  const discordRole = await adapter.createRole({ name: 'Cybersecurity' });
  const { team } = await handleRoleCreate(ctx, discordRole);

  const pm = await state.createPm({ name: 'Security Lead', discordUserId: 'user_sec' });
  await state.updatePm(pm.id, { teamIds: [team.id] });
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  // Save a member assigned to this team
  await state.saveMember('student_sec', { id: 'student_sec', status: 'approved', pmId: pm.id, teamId: team.id });

  // Delete role in Discord
  adapter.roles.delete(discordRole.id);
  const res = await handleRoleDelete(ctx, discordRole);
  assert.equal(res.handled, true);

  // 1. Team marked removed in Firestore
  const deletedTeam = await state.getTeam(team.id);
  assert.equal(deletedTeam.status, 'removed');

  // 2. Resource forum removed
  assert.equal(adapter.byName('cybersecurity').filter((c) => c.kind === 'forum').length, 0);

  // 3. Member user record preserved, teamId safely unassigned
  const member = await state.getMember('student_sec');
  assert.ok(member, 'member record intact');
  assert.equal(member.teamId, null, 'teamId safely unassigned');

  // 4. PM teamIds updated
  const updatedPm = await state.getPm(pm.id);
  assert.ok(!updatedPm.teamIds.includes(team.id), 'deleted team unlinked from PM');
});

test('Security: Protected roles (IPDC GRID, ADMIN, IPDC, @everyone) are never modified', async () => {
  const ctx = await setupDynamicEnv();

  assert.equal(isProtectedRole({ id: '1568690888413282396', name: 'IPDC GRID' }, ctx.cfg), true);
  assert.equal(isProtectedRole({ id: '1568690393824891141', name: 'ADMIN' }, ctx.cfg), true);
  assert.equal(isProtectedRole({ id: 'guild1', name: '@everyone', guild: { id: 'guild1' } }, ctx.cfg), true);
  assert.equal(isProtectedRole({ id: 'managed_role', name: 'Bot Role', managed: true }, ctx.cfg), true);

  // handleRoleCreate ignores them
  const res = await handleRoleCreate(ctx, { id: '1568690888413282396', name: 'IPDC GRID' });
  assert.equal(res.ignored, true);
  assert.equal(res.reason, 'protected');
});

test('Dynamic Member Role Update: assigning a new team role directly to a PM member in Discord automatically provisions the channel in their category without restart', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter, reconciler } = ctx;

  const discordRole = await adapter.createRole({ name: 'Embedded Systems' });
  const { team } = await handleRoleCreate(ctx, discordRole);

  const pm = await state.createPm({ name: 'Robotics PM', discordUserId: 'user_robotics' });
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  // Initially, channel does not exist in PM category
  const slug = team.slug;
  assert.equal(adapter.byName(slug).filter((c) => c.kind === 'text').length, 0);

  // Administrator assigns the role directly to the PM member in Discord
  const oldMember = { id: pm.discordUserId, roles: { cache: new Map() } };
  const newMember = {
    id: pm.discordUserId,
    user: { tag: 'Robotics#0001' },
    roles: { cache: new Map([[discordRole.id, { id: discordRole.id, name: 'Embedded Systems' }]]) },
  };

  const { handleMemberUpdate } = await import('../src/core/dynamicRoles.js');
  const res = await handleMemberUpdate(ctx, oldMember, newMember);
  assert.equal(res.handled, true);
  assert.ok(res.teamIds.includes(team.id));

  // Channel now exists inside PM category immediately
  const pmChan = adapter.byName(slug).find((c) => c.kind === 'text');
  assert.ok(pmChan, 'channel immediately created inside PM category upon Discord member role assignment');

  const pmCatId = await reconciler.getObjectId(KEYS.pmCategory(pm.id));
  assert.equal(pmChan.parentId, pmCatId, 'channel parent is PM category');
});

test('Idempotency: multiple reconciliation runs produce zero duplicate objects', async () => {
  const ctx = await setupDynamicEnv();
  const { adapter, reconciler } = ctx;

  const discordRole = await adapter.createRole({ name: 'Data Science' });
  await handleRoleCreate(ctx, discordRole);

  const initialRoleCount = adapter.roles.size;
  const initialChanCount = adapter.channels.size;

  // Run reconciliation 3 times in a row
  await reconciler.run('verify-idempotency-1');
  await reconciler.run('verify-idempotency-2');
  await reconciler.run('verify-idempotency-3');

  assert.equal(adapter.roles.size, initialRoleCount, 'no duplicate roles created');
  assert.equal(adapter.channels.size, initialChanCount, 'no duplicate channels created');
});
