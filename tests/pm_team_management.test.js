import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, ButtonStyle } from 'discord.js';
import { makeEnv } from './helpers/env.js';
import { Auth } from '../src/core/auth.js';
import { RetryQueue } from '../src/core/queue.js';
import { Router } from '../src/core/router.js';
import { KEYS } from '../src/core/structure.js';
import { isProtectedRole, getValidActiveTeams } from '../src/core/dynamicRoles.js';
import { register as registerPm, pmPanelPayload } from '../src/features/pm.js';
import { register as registerAdmin } from '../src/features/admin.js';
import { register as registerRequests } from '../src/features/requests.js';

const GRID = '1568690888413282396';
const ADMIN = '1568690393824891141';

async function setupEnv() {
  const env = makeEnv();
  const { state, store, reconciler, adapter, audit } = env;

  await reconciler.run('seed');
  const ipdcRoleId = (await store.get('registry', KEYS.roleIpdc))?.id;

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
  const roles = {
    idFor: (k) => reconciler.getObjectId(k),
    memberRoleKeys: async ({ pmId, teamId }) => ({
      ipdc: await reconciler.getObjectId(KEYS.roleIpdc),
      ...(pmId && { pm: await reconciler.getObjectId(KEYS.pmRole(pmId)) }),
      ...(teamId && { team: await reconciler.getObjectId(KEYS.teamRole(teamId)) }),
    }),
    apply: async (u, d) => {
      applied.push({ u, ...d });
    },
    get: async (id) => adapter.getRole(id),
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
    guilds: {
      cache: {
        get: () => ({
          roles: {
            fetch: async (id) => adapter.getRole(id),
          },
        }),
      },
    },
  };

  const queue = new RetryQueue(store);
  const auth = new Auth({
    ids: { grid: GRID, admin: ADMIN, get ipdc() { return ipdcRoleId; } },
    getSettings: () => state.settings(),
  });
  const github = { enabled: true, getRepo: async (o, n) => ({ fullName: `${o}/${n}`, owner: o, name: n, defaultBranch: 'main' }) };
  const ctx = {
    ...env,
    auth,
    queue,
    roles,
    client,
    messages: { channelFor, ensure: async () => {} },
    github,
    cfg: { ...env.cfg, discord: { guildId: 'g' } },
  };

  const router = new Router();
  registerPm(router, ctx);
  registerAdmin(router, ctx);
  registerRequests(router, ctx);

  const handler = (kind, id) => router._find(router.maps[kind], id);
  const inter = (userId, roleIds, customId, extra = {}) => {
    const log = [];
    return {
      log,
      user: { id: userId, tag: `${userId}#0` },
      member: { roleIds },
      customId,
      replied: false,
      deferred: false,
      isButton: () => true,
      isAnySelectMenu: () => true,
      deferReply: async function () { this.deferred = true; },
      deferUpdate: async function () { this.deferred = true; },
      editReply: async function (p) { log.push(p); },
      reply: async function (p) { log.push(p); this.replied = true; },
      update: async function (p) { log.push(p); },
      followUp: async (p) => log.push(p),
      showModal: async (m) => log.push({ modal: m }),
      ...extra,
    };
  };

  const run = async (kind, i) => {
    const f = handler(kind, i.customId);
    assert.ok(f, `Handler found for ${kind} ${i.customId}`);
    await f.fn(i, f.args, ctx);
    return i;
  };

  return { ctx, env, router, handler, inter, run, applied, sent, ipdcRoleId };
}

const getEmbed = (i) => {
  const reply = i.log[0] || {};
  const e = reply.embeds?.[0];
  if (!e) return {};
  return e.data || e;
};

const getComponents = (i) => {
  const reply = i.log[0] || {};
  return (reply.components || []).map((r) => (r.toJSON ? r.toJSON() : r));
};

test('1. getValidActiveTeams rejects protected, Administrator, and bot-managed roles', async () => {
  const { ctx, env } = await setupEnv();
  const { state, adapter, reconciler } = env;

  // 1. Valid team
  const tValid = await state.createTeam({ name: 'Web Dev' });
  await reconciler.run('test-team');

  // 2. Administrator role
  const adminRole = await adapter.createRole({ name: 'Super Admin' });
  adminRole.permissions = {
    has: (b) => b === PermissionFlagsBits.Administrator || b === (1n << 3n),
  };
  const tAdmin = await state.createTeam({ name: 'Super Admin', roleId: adminRole.id });

  // 3. Bot managed role
  const managedRole = await adapter.createRole({ name: 'GitHub Bot' });
  managedRole.managed = true;
  const tManaged = await state.createTeam({ name: 'GitHub Bot', roleId: managedRole.id });

  // 4. Protected system role name / ID
  const gridRole = await adapter.createRole({ name: 'IPDC GRID' });
  const tGrid = await state.createTeam({ name: 'IPDC GRID', roleId: gridRole.id });

  const valid = await getValidActiveTeams(ctx);
  const validIds = valid.map((t) => t.id);

  assert.ok(validIds.includes(tValid.id), 'Normal team is included');
  assert.ok(!validIds.includes(tAdmin.id), 'Administrator role team is rejected');
  assert.ok(!validIds.includes(tManaged.id), 'Managed role team is rejected');
  assert.ok(!validIds.includes(tGrid.id), 'Protected IPDC GRID team is rejected');
});

test('2. getValidActiveTeams safely excludes missing roles and fetch failures', async () => {
  const { ctx, env } = await setupEnv();
  const { state } = env;

  // Team with nonexistent roleId in Discord
  const tGhost = await state.createTeam({ name: 'Ghost Team', roleId: 'nonexistent-role-999' });

  // Team with removed status
  const tRemoved = await state.createTeam({ name: 'Old Team' });
  await state.updateTeam(tRemoved.id, { status: 'removed' });

  // Team missing id or name
  await env.store.set('teams', 'bad-team', { status: 'active' });

  const valid = await getValidActiveTeams(ctx);
  const validIds = valid.map((t) => t.id);

  assert.ok(!validIds.includes(tGhost.id), 'Ghost role team safely excluded');
  assert.ok(!validIds.includes(tRemoved.id), 'Soft-deleted team safely excluded');
  assert.ok(!validIds.includes('bad-team'), 'Invalid team document safely excluded');
});

test('3. Team Overview renders all active teams, zero-member counts, and unassigned members', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  const t1 = await state.createTeam({ name: 'AI/ML' });
  const t2 = await state.createTeam({ name: 'Cloud Ops' });
  await reconciler.run('teams');

  const pm = await state.createPm({ name: 'Priya Sharma', discordUserId: 'priya_user' });
  await state.saveMember('member1', { id: 'member1', status: 'approved', role: 'member', pmId: pm.id, teamId: t1.id, github: { username: 'dev-one' } });
  await state.saveMember('member_unassigned', { id: 'member_unassigned', status: 'approved', role: 'member', pmId: pm.id, teamId: null });

  const i = inter('priya_user', [], `pm:team:${pm.id}`);
  await run('button', i);

  const emb = getEmbed(i);
  const desc = emb.description;

  assert.match(desc, /\*\*AI\/ML\*\* \(1\)/, 'Shows AI/ML with 1 member');
  assert.match(desc, /<@member1> — \[dev-one\]/, 'Shows member with GitHub handle');
  assert.match(desc, /\*\*Cloud Ops\*\* \(0\)/, 'Shows Cloud Ops with 0 members');
  assert.match(desc, /\*No members assigned yet\*/, 'Shows zero-member placeholder');
  assert.match(desc, /\*\*Unassigned\*\* \(1\)/, 'Shows unassigned member group');
});

test('4. Team Overview paginates at 8 teams per page with PREV and NEXT buttons', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  for (let k = 1; k <= 12; k++) {
    await state.createTeam({ name: `Team Alpha ${String(k).padStart(2, '0')}` });
  }
  await reconciler.run('teams-12');

  const pm = await state.createPm({ name: 'Vikram Seth', discordUserId: 'vikram_user' });

  // Page 1
  const i1 = inter('vikram_user', [], `pm:team:${pm.id}:1`);
  await run('button', i1);
  const emb1 = getEmbed(i1);
  assert.match(emb1.title, /Page 1 of 2/);
  const rows1 = getComponents(i1);
  assert.equal(rows1.length, 1, 'Has navigation row');
  assert.equal(rows1[0].components[0].disabled, true, 'PREV disabled on page 1');
  assert.equal(rows1[0].components[1].disabled, false, 'NEXT enabled on page 1');

  // Page 2
  const i2 = inter('vikram_user', [], `pm:team:${pm.id}:2`);
  await run('button', i2);
  const emb2 = getEmbed(i2);
  assert.match(emb2.title, /Page 2 of 2/);
  const rows2 = getComponents(i2);
  assert.equal(rows2[0].components[0].disabled, false, 'PREV enabled on page 2');
  assert.equal(rows2[0].components[1].disabled, true, 'NEXT disabled on page 2');
});

test('5. Manage Teams chunks select menus across ActionRows respecting <= 25 options per menu', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  for (let k = 1; k <= 30; k++) {
    await state.createTeam({ name: `Service ${String(k).padStart(2, '0')}` });
  }
  await reconciler.run('teams-30');

  const pm = await state.createPm({ name: 'Meera Sen', discordUserId: 'meera_user' });

  const i = inter('meera_user', [], `pm:manage-teams:${pm.id}`);
  await run('button', i);

  const rows = getComponents(i);
  assert.equal(rows.length, 2, '2 ActionRows for 30 teams');
  const menu1 = rows[0].components[0];
  const menu2 = rows[1].components[0];

  assert.equal(menu1.options.length, 25, 'First menu has exactly 25 options');
  assert.equal(menu2.options.length, 5, 'Second menu has remaining 5 options');
  assert.ok(menu1.options.every((o) => o.default === true), 'All active options defaulted true under Option B');
});

test('6. Manage Teams paginates when exceeding 100 teams', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  for (let k = 1; k <= 105; k++) {
    await state.createTeam({ name: `Batch ${String(k).padStart(3, '0')}` });
  }
  await reconciler.run('teams-105');

  const pm = await state.createPm({ name: 'Karan Mehra', discordUserId: 'karan_user' });

  // Page 1: 4 select rows (100 options) + 1 navigation row
  const i1 = inter('karan_user', [], `pm:manage-teams:${pm.id}:1`);
  await run('button', i1);
  const rows1 = getComponents(i1);
  assert.equal(rows1.length, 5, '4 select rows + 1 navigation row');
  const nav1 = rows1[4];
  assert.equal(nav1.components[0].disabled, true, 'PREV disabled on page 1');
  assert.equal(nav1.components[1].disabled, false, 'NEXT enabled on page 1');

  // Page 2: 1 select row (5 options) + 1 navigation row
  const i2 = inter('karan_user', [], `pm:manage-teams:${pm.id}:2`);
  await run('button', i2);
  const rows2 = getComponents(i2);
  assert.equal(rows2.length, 2, '1 select row + 1 navigation row');
  const nav2 = rows2[1];
  assert.equal(nav2.components[0].disabled, false, 'PREV enabled on page 2');
  assert.equal(nav2.components[1].disabled, true, 'NEXT disabled on page 2');
});

test('7. Global assignment invariant: partial or empty submission cannot remove active teams from pm.teamIds', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  const t1 = await state.createTeam({ name: 'Frontend Team' });
  const t2 = await state.createTeam({ name: 'Backend Team' });
  const t3 = await state.createTeam({ name: 'QA Team' });
  await reconciler.run('invariant-teams');

  const pm = await state.createPm({ name: 'Rohan Gupta', discordUserId: 'rohan_user' });

  // Submit select menu with empty selection []
  const iEmpty = inter('rohan_user', [], `pm:set-teams:${pm.id}:1:1`, { values: [] });
  await run('select', iEmpty);

  const pmAfterEmpty = await state.getPm(pm.id);
  assert.equal(pmAfterEmpty.teamIds.length, 3, 'All 3 teams preserved despite empty selection');
  assert.ok(pmAfterEmpty.teamIds.includes(t1.id) && pmAfterEmpty.teamIds.includes(t2.id) && pmAfterEmpty.teamIds.includes(t3.id));

  // Submit select menu with partial selection [t1.id]
  const iPartial = inter('rohan_user', [], `pm:set-teams:${pm.id}:1:1`, { values: [t1.id] });
  await run('select', iPartial);

  const pmAfterPartial = await state.getPm(pm.id);
  assert.equal(pmAfterPartial.teamIds.length, 3, 'All 3 teams preserved despite partial selection');
});

test('8. Obsolete teams are pruned from PM teamIds on selector open', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  const tActive = await state.createTeam({ name: 'Live Team' });
  await reconciler.run('active-team');

  const pm = await state.createPm({ name: 'Siddharth Rao', discordUserId: 'sid_user' });
  // Manually inject an obsolete team ID
  await state.updatePm(pm.id, { teamIds: [tActive.id, 'obsolete-team-123'] });

  const i = inter('sid_user', [], `pm:manage-teams:${pm.id}`);
  await run('button', i);

  const pmUpdated = await state.getPm(pm.id);
  assert.ok(!pmUpdated.teamIds.includes('obsolete-team-123'), 'Obsolete team was pruned');
  assert.ok(pmUpdated.teamIds.includes(tActive.id), 'Active team kept');
});

test('9. Newly created dynamic team becomes immediately visible in Team Overview without restart', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  const pm = await state.createPm({ name: 'Anita Roy', discordUserId: 'anita_user' });

  // Create team dynamically
  const tNew = await state.createTeam({ name: 'Security' });
  await reconciler.run('dynamic-security');

  // Trigger overview
  const i = inter('anita_user', [], `pm:team:${pm.id}`);
  await run('button', i);

  const emb = getEmbed(i);
  assert.match(emb.description, /\*\*Security\*\* \(0\)/, 'Newly created team is immediately visible');
});

test('10. PM application approval applies IPDC role, personal PM role, and all valid active team roles', async () => {
  const { ctx, env, run, inter, applied } = await setupEnv();
  const { state, reconciler } = env;

  const t1 = await state.createTeam({ name: 'Data Engineering' });
  const t2 = await state.createTeam({ name: 'Product Design' });
  await reconciler.run('teams-approval');

  const req = await ctx.requests.createRequest({
    type: 'pm_application',
    userId: 'approved_pm_user',
    pmName: 'Deepa Nair',
    github: { username: 'deepanair' },
  });

  const i = inter('adm', [ADMIN], `req:approve:${req.id}`);
  await run('button', i);

  const pm = await state.pmByUser('approved_pm_user');
  assert.ok(pm, 'PM record created');
  assert.equal(pm.name, 'Deepa Nair');

  const pmRoleId = await reconciler.getObjectId(KEYS.pmRole(pm.id));
  const t1RoleId = await reconciler.getObjectId(KEYS.teamRole(t1.id));
  const t2RoleId = await reconciler.getObjectId(KEYS.teamRole(t2.id));

  const roleCall = applied.filter((a) => a.u === 'approved_pm_user').at(-1);
  assert.ok(roleCall, 'Roles applied to approved PM');
  assert.ok(roleCall.add.includes(pmRoleId), 'Contains personal PM role');
  assert.ok(roleCall.add.includes(t1RoleId), 'Contains Data Engineering team role');
  assert.ok(roleCall.add.includes(t2RoleId), 'Contains Product Design team role');
});

test('11. Preserves existing PM buttons and modal workflows (pm:repo, pm:pending, pm:refresh)', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state } = env;

  const pm = await state.createPm({ name: 'Tarun Verma', discordUserId: 'tarun_user' });

  // Check pmPanelPayload has all buttons
  const panel = pmPanelPayload(pm);
  const btnIds = panel.components.flatMap((r) => r.components.map((c) => c.data.custom_id));
  assert.ok(btnIds.includes(`pm:repo:${pm.id}`), 'Has SET REPOSITORY');
  assert.ok(btnIds.includes(`pm:manage-teams:${pm.id}`), 'Has MANAGE TEAMS');
  assert.ok(btnIds.includes(`pm:team:${pm.id}`), 'Has TEAM OVERVIEW');
  assert.ok(btnIds.includes(`pm:pending:${pm.id}`), 'Has PENDING REQUESTS');
  assert.ok(btnIds.includes(`pm:refresh:${pm.id}`), 'Has REFRESH ACTIVITY');

  // Test pm:repo button opens modal
  const iRepo = inter('tarun_user', [], `pm:repo:${pm.id}`);
  await run('button', iRepo);
  assert.ok(iRepo.log[0]?.modal, 'SET REPOSITORY opens modal');

  // Test pm:repom modal sets repository
  const iRepom = inter('tarun_user', [], `pm:repom:${pm.id}`, {
    fields: { getTextInputValue: () => 'my-org/my-project' },
  });
  await run('modal', iRepom);
  const updatedPm = await state.getPm(pm.id);
  assert.equal(updatedPm.repo?.owner, 'my-org');
  assert.equal(updatedPm.repo?.name, 'my-project');

  // Test pm:pending lists pending requests
  const iPending = inter('tarun_user', [], `pm:pending:${pm.id}`);
  await run('button', iPending);
  const embPending = getEmbed(iPending);
  assert.match(embPending.title, /PENDING REQUESTS/);
});

test('12. Zero extraneous schema fields added to PM documents', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  await state.createTeam({ name: 'Infra' });
  await reconciler.run('seed-infra');

  const pm = await state.createPm({ name: 'Maya Angel', discordUserId: 'maya_user' });

  const i = inter('maya_user', [], `pm:manage-teams:${pm.id}`);
  await run('button', i);

  const iSet = inter('maya_user', [], `pm:set-teams:${pm.id}:1:1`, { values: [] });
  await run('select', iSet);

  const storedPm = await state.getPm(pm.id);
  const keys = Object.keys(storedPm);

  assert.ok(!keys.includes('focusTeamIds'), 'No focusTeamIds in schema');
  assert.ok(!keys.includes('selectedTeamIds'), 'No selectedTeamIds in schema');
  assert.ok(!keys.includes('customTeams'), 'No customTeams in schema');
});

test('13. Admin Role-to-PM Mapping displays exactly 125 teams across 5 select rows without navigation buttons', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  for (let k = 1; k <= 125; k++) {
    await state.createTeam({ name: `AdmSquad ${String(k).padStart(3, '0')}` });
  }
  await reconciler.run('teams-125');

  const pm = await state.createPm({ name: 'Admin Target PM', discordUserId: 'adm_target_user' });

  // Admin selects PM in Role-to-PM mapping
  const i = inter('adm', [GRID], 'adm:map-pm', { values: [pm.id] });
  await run('select', i);

  const rows = getComponents(i);
  assert.equal(rows.length, 5, 'Exactly 5 select rows for 125 teams');
  assert.ok(rows.every((r) => r.components[0].type === 3), 'All 5 rows are select menus');
  assert.ok(rows.every((r) => r.components[0].options.length === 25), 'Each row has 25 options');
});

test('14. Admin Role-to-PM Mapping paginates 126 teams across 2 pages with PREV/NEXT navigation buttons', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  for (let k = 1; k <= 126; k++) {
    await state.createTeam({ name: `AdmSquad ${String(k).padStart(3, '0')}` });
  }
  await reconciler.run('teams-126');

  const pm = await state.createPm({ name: 'Admin Target PM 126', discordUserId: 'adm_target_126' });

  // Page 1 via PM picker
  const i1 = inter('adm', [GRID], 'adm:map-pm', { values: [pm.id] });
  await run('select', i1);

  const rows1 = getComponents(i1);
  assert.equal(rows1.length, 5, 'Page 1 has 4 select rows + 1 navigation row');
  assert.equal(rows1[0].components[0].options.length, 25);
  assert.equal(rows1[1].components[0].options.length, 25);
  assert.equal(rows1[2].components[0].options.length, 25);
  assert.equal(rows1[3].components[0].options.length, 25);
  const nav1 = rows1[4];
  assert.equal(nav1.components[0].disabled, true, 'PREV disabled on page 1');
  assert.equal(nav1.components[1].disabled, false, 'NEXT enabled on page 1');

  // Page 2 via NEXT button
  const i2 = inter('adm', [GRID], `adm:map-pm:${pm.id}:2`);
  await run('button', i2);

  const rows2 = getComponents(i2);
  assert.equal(rows2.length, 3, 'Page 2 has 2 select rows + 1 navigation row');
  assert.equal(rows2[0].components[0].options.length, 25, 'Teams 101-125');
  assert.equal(rows2[1].components[0].options.length, 1, 'Team 126');
  const nav2 = rows2[2];
  assert.equal(nav2.components[0].disabled, false, 'PREV enabled on page 2');
  assert.equal(nav2.components[1].disabled, true, 'NEXT disabled on page 2');
});

test('15. Admin Role-to-PM Mapping supports > 200 teams across 3 pages and enforces global invariant on submit', async () => {
  const { ctx, env, run, inter } = await setupEnv();
  const { state, reconciler } = env;

  for (let k = 1; k <= 210; k++) {
    await state.createTeam({ name: `BigSquad ${String(k).padStart(3, '0')}` });
  }
  await reconciler.run('teams-210');

  const pm = await state.createPm({ name: 'Admin Large PM', discordUserId: 'adm_large_user' });

  // Page 3 via button
  const i3 = inter('adm', [GRID], `adm:map-pm:${pm.id}:3`);
  await run('button', i3);

  const rows3 = getComponents(i3);
  assert.equal(rows3.length, 2, 'Page 3 has 1 select row (10 teams) + 1 navigation row');
  assert.equal(rows3[0].components[0].options.length, 10, 'Teams 201-210');
  const nav3 = rows3[1];
  assert.equal(nav3.components[0].disabled, false, 'PREV enabled on page 3');
  assert.equal(nav3.components[1].disabled, true, 'NEXT disabled on page 3');

  // Submit from page 3 with partial or empty selection
  const iSubmit = inter('adm', [GRID], `adm:map-set:${pm.id}:3:1`, { values: [] });
  await run('select', iSubmit);

  const pmAfterSubmit = await state.getPm(pm.id);
  assert.equal(pmAfterSubmit.teamIds.length, 210, 'Global assignment invariant enforced: all 210 active teams assigned');
});
