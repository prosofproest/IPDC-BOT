import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as F } from 'discord.js';
import { makeEnv } from './helpers/env.js';
import { KEYS } from '../src/core/structure.js';
import { provisionPmWorkspace, auditPmPermissions } from '../src/core/workspace.js';
import { handleRoleCreate, handleRoleUpdate, handleRoleDelete, isProtectedRole } from '../src/core/dynamicRoles.js';
import { Managed } from '../src/core/managed.js';
import { RetryQueue } from '../src/core/queue.js';

async function setupDynamicEnv() {
  const env = makeEnv();
  const { state, store, reconciler, adapter, audit, cfg } = env;

  const tFrontend = await state.createTeam({ name: 'Frontend' });
  const tBackend = await state.createTeam({ name: 'Backend' });

  await reconciler.run('seed');

  const appliedRoles = [];
  let shouldFailRoleApply = null;
  const roles = {
    idFor: (k) => reconciler.getObjectId(k),
    apply: async (userId, { add = [], remove = [] }) => {
      if (shouldFailRoleApply && shouldFailRoleApply(userId)) {
        throw new Error(`Discord member fetch/apply failed for ${userId}`);
      }
      appliedRoles.push({ userId, add, remove });
      return { added: add, removed: remove };
    },
  };

  const queue = new RetryQueue(store);
  queue.register('roles.apply', async (p) => {
    await roles.apply(p.userId, { add: p.add, remove: p.remove });
  });

  const messagesSaved = new Map();
  const threadsCreated = [];
  const archivedPublicThreads = [];
  const archivedPrivateThreads = [];
  let failActiveThreadFetch = false;
  let failArchivedThreadFetch = false;
  let failChannelFetch = false;

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
        if (failChannelFetch) throw new Error('Simulated Discord channel fetch error');
        const ch = adapter.channels.get(id);
        if (!ch) return null;
        return {
          id: ch.id,
          name: ch.name,
          type: ch.kind === 'forum' ? 15 : 0,
          threads: {
            fetchActive: async () => {
              if (failActiveThreadFetch) throw new Error('Simulated Discord active thread fetch error');
              return { threads: threadsCreated.filter((th) => th.channelId === id) };
            },
            fetchArchived: async ({ type } = {}) => {
              if (failArchivedThreadFetch) throw new Error('Simulated Discord archived thread fetch error');
              return {
                threads: type === 'private'
                  ? archivedPrivateThreads.filter((th) => th.channelId === id)
                  : archivedPublicThreads.filter((th) => th.channelId === id),
              };
            },
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
              if (failChannelFetch) throw new Error('Simulated Discord guild channel fetch error');
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
    queue,
    messages,
    client,
    managed,
    tFrontend,
    tBackend,
    appliedRoles,
    messagesSaved,
    threadsCreated,
    archivedPublicThreads,
    archivedPrivateThreads,
    setFailRoleApply: (fn) => { shouldFailRoleApply = fn; },
    setFailActiveThreadFetch: (v) => { failActiveThreadFetch = v; },
    setFailArchivedThreadFetch: (v) => { failArchivedThreadFetch = v; },
    setFailChannelFetch: (v) => { failChannelFetch = v; },
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

  // Under global assignment, channel is created on initial provisioning
  const slug = team.slug;
  const initialChan = adapter.byName(slug).find((c) => c.kind === 'text');
  assert.ok(initialChan, 'channel initially exists after creation');

  // Safely simulate a missing team channel before triggering the member update
  adapter.deleteChannel(initialChan.id);
  assert.equal(adapter.byName(slug).filter((c) => c.kind === 'text').length, 0, 'channel is missing before member update');

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
  assert.ok(pmChan, 'channel immediately recreated inside PM category upon Discord member role assignment');

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

test('Global assignment: role creation assigns Discord role and Firestore team to every existing active PM', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter } = ctx;

  // 1. Create two existing active PMs
  const pm1 = await state.createPm({ name: 'Alice Smith', discordUserId: 'user_alice' });
  const pm2 = await state.createPm({ name: 'Bob Jones', discordUserId: 'user_bob' });
  await provisionPmWorkspace(ctx, pm1.id, { welcome: false });
  await provisionPmWorkspace(ctx, pm2.id, { welcome: false });

  // 2. Admin creates a new Discord team role
  const discordRole = await adapter.createRole({ name: 'Cloud Architecture' });
  const res = await handleRoleCreate(ctx, discordRole);
  assert.equal(res.handled, true);
  assert.equal(res.type, 'team');

  // 3. Verify Firestore team registration
  const team = await state.teamByRole(discordRole.id);
  assert.ok(team, 'team registered in Firestore');
  assert.equal(team.name, 'Cloud Architecture');

  // 4. Verify both existing PMs now have the new team in their Firestore teamIds
  const updatedPm1 = await state.getPm(pm1.id);
  const updatedPm2 = await state.getPm(pm2.id);
  assert.ok(updatedPm1.teamIds.includes(team.id), 'PM1 inherited Cloud Architecture');
  assert.ok(updatedPm2.teamIds.includes(team.id), 'PM2 inherited Cloud Architecture');

  // 5. Verify Discord role was applied to both PM users
  const aliceApply = ctx.appliedRoles.find((a) => a.userId === 'user_alice' && a.add.includes(discordRole.id));
  const bobApply = ctx.appliedRoles.find((a) => a.userId === 'user_bob' && a.add.includes(discordRole.id));
  assert.ok(aliceApply, 'Discord role applied to Alice');
  assert.ok(bobApply, 'Discord role applied to Bob');

  // 6. Verify team text channel created inside both PM categories
  const teamChannels = adapter.byName(team.slug).filter((c) => c.kind === 'text');
  assert.equal(teamChannels.length, 2, 'channel created in both PM workspaces');
});

test('Global assignment: duplicate role-create events are handled idempotently without duplicate assignments', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter } = ctx;

  const pm = await state.createPm({ name: 'Charlie Day', discordUserId: 'user_charlie' });
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  const discordRole = await adapter.createRole({ name: 'QA & Testing' });

  // Call handleRoleCreate twice (duplicate events)
  const res1 = await handleRoleCreate(ctx, discordRole);
  const res2 = await handleRoleCreate(ctx, discordRole);

  assert.equal(res1.handled, true);
  assert.equal(res2.handled, true);

  // Exactly 1 team exists for this role
  const teams = (await state.teams()).filter((t) => t.roleId === discordRole.id);
  assert.equal(teams.length, 1, 'only one team record exists');

  // PM teamIds contains the team ID exactly once
  const updatedPm = await state.getPm(pm.id);
  const teamOccurrences = updatedPm.teamIds.filter((tid) => tid === teams[0].id).length;
  assert.equal(teamOccurrences, 1, 'team ID is not duplicated in PM teamIds');
});

test('Role deletion: removes team assignment from all PMs in Firestore and Discord roles safely', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter } = ctx;

  const pm1 = await state.createPm({ name: 'David Miller', discordUserId: 'user_david' });
  const pm2 = await state.createPm({ name: 'Emma Watson', discordUserId: 'user_emma' });

  const discordRole = await adapter.createRole({ name: 'Embedded AI' });
  const { team } = await handleRoleCreate(ctx, discordRole);

  // Both have it
  assert.ok((await state.getPm(pm1.id)).teamIds.includes(team.id));
  assert.ok((await state.getPm(pm2.id)).teamIds.includes(team.id));

  // Role deleted in Discord
  adapter.roles.delete(discordRole.id);
  const res = await handleRoleDelete(ctx, discordRole);
  assert.equal(res.handled, true);

  // Firestore status updated to removed
  const deletedTeam = await state.getTeam(team.id);
  assert.equal(deletedTeam.status, 'removed');

  // Team removed from all PMs
  const p1After = await state.getPm(pm1.id);
  const p2After = await state.getPm(pm2.id);
  assert.ok(!p1After.teamIds.includes(team.id), 'removed from PM1');
  assert.ok(!p2After.teamIds.includes(team.id), 'removed from PM2');

  // Discord role removal attempted
  const dRemoval = ctx.appliedRoles.find((a) => a.userId === 'user_david' && a.remove.includes(discordRole.id));
  const eRemoval = ctx.appliedRoles.find((a) => a.userId === 'user_emma' && a.remove.includes(discordRole.id));
  assert.ok(dRemoval, 'role removal applied to David');
  assert.ok(eRemoval, 'role removal applied to Emma');
});

test('Role deletion: preserves resource forum when active threads exist', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter, reconciler } = ctx;

  const discordRole = await adapter.createRole({ name: 'Systems Architecture' });
  const { team } = await handleRoleCreate(ctx, discordRole);

  const forumId = await reconciler.getObjectId(KEYS.resourceForum(team.id));
  assert.ok(forumId, 'forum exists');

  // Simulate active thread in forum
  ctx.threadsCreated.push({
    id: 'thread_active_1',
    channelId: forumId,
    name: 'Active Design RFC',
    message: 'Proposal content',
  });

  adapter.roles.delete(discordRole.id);
  const res = await handleRoleDelete(ctx, discordRole);
  assert.equal(res.handled, true);

  // Forum channel PRESERVED
  assert.ok(adapter.channels.get(forumId), 'resource forum preserved when active threads exist');
  assert.equal((await state.getTeam(team.id)).status, 'removed');
});

test('Role deletion: preserves resource forum when archived public threads exist', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter, reconciler, archivedPublicThreads } = ctx;

  const discordRole = await adapter.createRole({ name: 'Compiler Engineering' });
  const { team } = await handleRoleCreate(ctx, discordRole);

  const forumId = await reconciler.getObjectId(KEYS.resourceForum(team.id));
  assert.ok(forumId, 'forum exists');

  // 0 active threads, but 1 archived public thread
  archivedPublicThreads.push({
    id: 'thread_archived_pub',
    channelId: forumId,
    name: 'LLVM IR Discussion (Archived)',
    message: 'Historical design docs',
  });

  adapter.roles.delete(discordRole.id);
  const res = await handleRoleDelete(ctx, discordRole);
  assert.equal(res.handled, true);

  // Forum channel PRESERVED
  assert.ok(adapter.channels.get(forumId), 'resource forum preserved when public archived threads exist');
  assert.equal((await state.getTeam(team.id)).status, 'removed');
});

test('Role deletion: preserves resource forum when archived private threads exist', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter, reconciler, archivedPrivateThreads } = ctx;

  const discordRole = await adapter.createRole({ name: 'Kernel Internals' });
  const { team } = await handleRoleCreate(ctx, discordRole);

  const forumId = await reconciler.getObjectId(KEYS.resourceForum(team.id));
  assert.ok(forumId, 'forum exists');

  // 0 active threads, 0 public archived threads, 1 private archived thread
  archivedPrivateThreads.push({
    id: 'thread_archived_priv',
    channelId: forumId,
    name: 'Security Vulnerability Discussion (Private Archived)',
    message: 'Private audit details',
  });

  adapter.roles.delete(discordRole.id);
  const res = await handleRoleDelete(ctx, discordRole);
  assert.equal(res.handled, true);

  // Forum channel PRESERVED
  assert.ok(adapter.channels.get(forumId), 'resource forum preserved when private archived threads exist');
  assert.equal((await state.getTeam(team.id)).status, 'removed');
});

test('Role deletion: preserves resource forum when inspection API fails (conservative fail-safe)', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter, reconciler, setFailActiveThreadFetch } = ctx;

  const discordRole = await adapter.createRole({ name: 'Distributed Systems' });
  const { team } = await handleRoleCreate(ctx, discordRole);

  const forumId = await reconciler.getObjectId(KEYS.resourceForum(team.id));
  assert.ok(forumId, 'forum exists');

  // Simulate Discord API 500 error when inspecting active threads
  setFailActiveThreadFetch(true);

  adapter.roles.delete(discordRole.id);
  const res = await handleRoleDelete(ctx, discordRole);
  assert.equal(res.handled, true);

  // Forum channel PRESERVED conservatively despite API failure
  assert.ok(adapter.channels.get(forumId), 'resource forum preserved when inspection API fails');
  assert.equal((await state.getTeam(team.id)).status, 'removed');
});

test('Role deletion: handles missing forum channel safely without throwing', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter, reconciler } = ctx;

  const discordRole = await adapter.createRole({ name: 'Cloud Infrastructure' });
  const { team } = await handleRoleCreate(ctx, discordRole);

  const forumId = await reconciler.getObjectId(KEYS.resourceForum(team.id));
  // Simulate forum was already deleted in Discord by an administrator
  adapter.deleteChannel(forumId);

  adapter.roles.delete(discordRole.id);
  const res = await handleRoleDelete(ctx, discordRole);
  assert.equal(res.handled, true);
  assert.equal((await state.getTeam(team.id)).status, 'removed');
});

test('Role deletion: NEVER deletes PM team text channels; only unmanages registry mappings', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter, store, reconciler } = ctx;

  const discordRole = await adapter.createRole({ name: 'Full Stack' });
  const { team } = await handleRoleCreate(ctx, discordRole);

  const pm = await state.createPm({ name: 'Fullstack PM', discordUserId: 'user_fullstack' });
  await state.updatePm(pm.id, { teamIds: [team.id] });
  await provisionPmWorkspace(ctx, pm.id, { welcome: false });

  // Verify PM team channel exists in Discord and in registry
  const slug = team.slug;
  const pmChan = adapter.byName(slug).find((c) => c.kind === 'text');
  assert.ok(pmChan, 'channel exists in Discord');

  const regKey = KEYS.pmTeamText(pm.id, team.id);
  const regEntryBefore = await store.get('registry', regKey);
  assert.ok(regEntryBefore, 'channel registered in bot store');

  // Delete team role in Discord
  adapter.roles.delete(discordRole.id);
  const res = await handleRoleDelete(ctx, discordRole);
  assert.equal(res.handled, true);

  // 1. PM team text channel STILL EXISTS in Discord with all chat history intact
  const pmChanAfter = adapter.channels.get(pmChan.id);
  assert.ok(pmChanAfter, 'PM team text channel was NEVER deleted from Discord');
  assert.equal(pmChanAfter.id, pmChan.id, 'exact channel instance preserved');

  // 2. Registry mapping unmanaged
  const regEntryAfter = await store.get('registry', regKey);
  assert.equal(regEntryAfter, null, 'registry mapping cleanly unmanaged');

  // 3. Team unassigned from PM
  const updatedPm = await state.getPm(pm.id);
  assert.ok(!updatedPm.teamIds.includes(team.id), 'team unassigned from PM');
});

test('Security: protected roles (GRID, ADMIN, Administrator permission) remain untouched on create and delete', async () => {
  const ctx = await setupDynamicEnv();
  const { adapter, cfg } = ctx;

  // 1. GRID role
  const gridRole = { id: cfg.roles.grid, name: 'IPDC GRID' };
  assert.equal((await handleRoleCreate(ctx, gridRole)).ignored, true);
  assert.equal((await handleRoleDelete(ctx, gridRole)).ignored, true);

  // 2. ADMIN role
  const adminRole = { id: cfg.roles.admin, name: 'ADMIN' };
  assert.equal((await handleRoleCreate(ctx, adminRole)).ignored, true);
  assert.equal((await handleRoleDelete(ctx, adminRole)).ignored, true);

  // 3. Role with Administrator permission bit
  const dangerousRole = await adapter.createRole({ name: 'Super Admin' });
  dangerousRole.permissions = { has: (p) => p === F.Administrator || p === 'Administrator' };
  assert.equal((await handleRoleCreate(ctx, dangerousRole)).ignored, true);
  assert.equal((await handleRoleDelete(ctx, dangerousRole)).ignored, true);
});

test('Reliability & Retry: enqueues retry when Discord role assignment fails for a PM', async () => {
  const ctx = await setupDynamicEnv();
  const { state, adapter, setFailRoleApply, queue } = ctx;

  const pmOk = await state.createPm({ name: 'Healthy PM', discordUserId: 'user_ok' });
  const pmFailing = await state.createPm({ name: 'Failing PM', discordUserId: 'user_failing' });

  // Simulate Discord API error specifically for user_failing
  setFailRoleApply((uid) => uid === 'user_failing');

  const discordRole = await adapter.createRole({ name: 'Mobile Dev' });
  const res = await handleRoleCreate(ctx, discordRole);

  assert.equal(res.handled, true);

  // Healthy PM received role directly
  const okApply = ctx.appliedRoles.find((a) => a.userId === 'user_ok' && a.add.includes(discordRole.id));
  assert.ok(okApply, 'healthy PM received role without issue');

  // Failing PM has a retry job queued in RetryQueue
  const jobs = await ctx.store.list('queue');
  const retryJob = jobs.find((j) => j.type === 'roles.apply' && j.payload.userId === 'user_failing');
  assert.ok(retryJob, 'retry job queued for failing PM');
  assert.ok(retryJob.payload.add.includes(discordRole.id), 'retry payload includes team role');

  // Verify that when Discord recovers, queue processes and applies the role
  setFailRoleApply(() => false);
  const processed = await queue.process();
  assert.ok(processed >= 1, 'queue processed the retry job');

  const recoveredApply = ctx.appliedRoles.find((a) => a.userId === 'user_failing' && a.add.includes(discordRole.id));
  assert.ok(recoveredApply, 'role applied to failing PM after queue retry');
});
