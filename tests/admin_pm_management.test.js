import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers/env.js';
import { Auth } from '../src/core/auth.js';
import { Router } from '../src/core/router.js';
import { KEYS } from '../src/core/structure.js';
import { Managed } from '../src/core/managed.js';
import { RoleService } from '../src/core/roles.js';
import { Messages } from '../src/core/messages.js';
import { register as registerAdmin, adminPanelPayload } from '../src/features/admin.js';

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
    update: async function (p) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.replied = true;
      log.push({ type: 'update', payload: p });
      ackLog.push({ type: 'update', payload: p });
      return { id: 'msg1' };
    },
    showModal: async function (m) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.replied = true;
      log.push({ type: 'showModal', modal: m });
      ackLog.push({ type: 'showModal', modal: m });
    },
    isButton: () => true,
    isChatInputCommand: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    ...extra,
  };
}

async function setupAdminTestEnv() {
  const env = makeEnv();
  const { state, store, reconciler, adapter, audit, cfg } = env;

  const appliedRoles = [];
  const roles = new RoleService({
    client: null,
    cfg,
    reconciler,
    adapter,
  });
  roles.apply = async (userId, { add = [], remove = [] }) => {
    appliedRoles.push({ userId, add, remove });
    return { added: add, removed: remove };
  };

  const messagesSaved = new Map();
  const messages = new Messages({ client: null, store, cfg, reconciler });
  messages.channelFor = async (k) => ({
    id: await reconciler.getObjectId(k),
    send: async (p) => ({ id: `msg_${messagesSaved.size + 1}`, ...p }),
  });
  messages.ensure = async (key, channelKey, payload) => {
    messagesSaved.set(key, { channelKey, payload });
    return { id: `msg_${key}`, ...payload };
  };

  const client = {
    user: { id: 'bot1' },
    guilds: {
      cache: {
        get: () => ({
          id: cfg.discord.guildId,
          roles: {
            fetch: async (id) => {
              const r = id ? await adapter.getRole(id) : adapter.roles;
              if (r && id) {
                return { ...r, delete: async () => adapter.deleteRole(id), setName: async (n) => adapter.renameRole(id, n) };
              }
              return r;
            },
          },
          channels: {
            fetch: async (id) => {
              const c = await adapter.getChannel(id);
              if (c) return { ...c, delete: async () => adapter.deleteChannel(id), setName: async () => {} };
              return null;
            },
          },
          members: {
            fetch: async (id) => ({
              id,
              roles: {
                cache: { has: () => false },
                add: async () => {},
                remove: async () => {},
              },
            }),
          },
        }),
      },
    },
    channels: {
      fetch: async (id) => {
        const c = await adapter.getChannel(id);
        if (c) return { ...c, delete: async () => adapter.deleteChannel(id), setName: async () => {} };
        return null;
      },
    },
    users: {
      fetch: async (id) => ({
        id,
        send: async () => {},
      }),
    },
  };

  const managed = new Managed({ client, store, cfg, state });
  const auth = new Auth({
    ids: { grid: GRID, admin: ADMIN, ipdc: 'ipdc-role' },
    getSettings: () => state.settings(),
  });

  const ctx = {
    ...env,
    roles,
    messages,
    managed,
    auth,
    client,
    health: { snapshot: () => 'ok' },
    panels: { refreshStructureDependent: async () => {}, refresh: async () => {} },
  };

  const router = new Router();
  router.ctx = ctx;
  registerAdmin(router, ctx);

  return { ctx, router, ...env, appliedRoles };
}

test('Admin Dashboard payload contains PM Management button', () => {
  const payload = adminPanelPayload();
  assert.ok(payload.embeds?.length > 0);
  assert.equal(payload.embeds[0].data.title, 'IPDC ADMIN PANEL');

  const allButtons = payload.components.flatMap((r) => r.components);
  const pmBtn = allButtons.find((b) => b.data.custom_id === 'adm:pm');
  assert.ok(pmBtn, 'adm:pm button must exist in admin panel');
  assert.equal(pmBtn.data.label, 'PM MANAGEMENT');
});

test('Admin Dashboard -> PM Management: acknowledges immediately and lists PMs', async () => {
  const { router, state, reconciler } = await setupAdminTestEnv();

  // Create team and PMs
  const team = await state.createTeam({ name: 'Frontend' });
  const pm1 = await state.createPm({ name: 'Asha Rao', discordUserId: 'user_asha' });
  const pm2 = await state.createPm({ name: 'Ravi Kumar', discordUserId: 'user_ravi' });
  await state.updatePm(pm1.id, { teamIds: [team.id], repo: { owner: 'org', name: 'repo-asha', url: 'https://github.com/org/repo-asha' } });

  // Reconcile structure so registry has IDs
  await reconciler.run('seed');

  // Trigger adm:pm interaction as GRID member
  const inter = makeMockInteraction('admin_user', [GRID], 'adm:pm');
  await router.dispatch(inter);

  // Check acknowledgement order: deferReply MUST come first before editReply
  assert.equal(inter.ackLog.length, 2, 'Must have exactly deferReply followed by editReply');
  assert.equal(inter.ackLog[0].type, 'deferReply', 'First ack must be deferReply');
  assert.equal(inter.ackLog[0].opts.flags, 64, 'Must be ephemeral (flags: 64)');
  assert.equal(inter.ackLog[1].type, 'editReply', 'Response must complete via editReply');

  // Check payload content
  const editPayload = inter.ackLog[1].payload;
  assert.ok(editPayload.embeds?.[0]);
  assert.equal(editPayload.embeds[0].data.title, 'PM MANAGEMENT & WORKSPACE PROVISIONING');
  const desc = editPayload.embeds[0].data.description;
  assert.match(desc, /Asha Rao/);
  assert.match(desc, /user_asha/);
  assert.match(desc, /Frontend/);
  assert.match(desc, /repo-asha/);
  assert.match(desc, /Ravi Kumar/);
  assert.match(desc, /user_ravi/);

  // Check action buttons in PM management view
  const actionButtons = editPayload.components.flatMap((r) => r.components);
  const ids = actionButtons.map((b) => b.data.custom_id);
  assert.ok(ids.includes('adm:pm-add'), 'ADD PM button present');
  assert.ok(ids.includes('adm:pm-prov'), 'PROVISION PM button present');
  assert.ok(ids.includes('adm:pm-verify'), 'VERIFY PERMISSIONS button present');
  assert.ok(ids.includes('adm:pm-ren'), 'RENAME PM button present');
  assert.ok(ids.includes('adm:pm-del'), 'REMOVE PM button present');
});

test('PM Management listing when no PMs configured', async () => {
  const { router } = await setupAdminTestEnv();

  const inter = makeMockInteraction('admin_user', [GRID], 'adm:pm');
  await router.dispatch(inter);

  assert.equal(inter.ackLog[0].type, 'deferReply');
  assert.equal(inter.ackLog[1].type, 'editReply');
  const desc = inter.ackLog[1].payload.embeds[0].data.description;
  assert.match(desc, /No Project Managers configured yet/);
});

test('PM creation and removal through PM Management flow', async () => {
  const { router, state, reconciler } = await setupAdminTestEnv();
  await reconciler.run('seed');

  // 1. ADD PM click -> user select
  const addBtnInter = makeMockInteraction('admin_user', [GRID], 'adm:pm-add');
  await router.dispatch(addBtnInter);
  assert.equal(addBtnInter.ackLog.length, 1);
  assert.match(addBtnInter.ackLog[0].payload.content, /Select the Discord member/);

  // 2. User selected -> opens name modal
  const selectInter = makeMockInteraction('admin_user', [GRID], 'adm:pm-add-user', {
    isButton: () => false,
    isAnySelectMenu: () => true,
    values: ['new_pm_user'],
  });
  await router.dispatch(selectInter);
  assert.equal(selectInter.ackLog[0].type, 'showModal');
  assert.equal(selectInter.ackLog[0].modal.data.custom_id, 'adm:pm-add-name:new_pm_user');

  // 3. Modal submit -> creates PM and workspace
  const modalInter = makeMockInteraction('admin_user', [GRID], 'adm:pm-add-name:new_pm_user', {
    isButton: () => false,
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => 'Kavita Patel' },
  });
  await router.dispatch(modalInter);
  assert.equal(modalInter.ackLog[0].type, 'deferReply');
  assert.equal(modalInter.ackLog[1].type, 'editReply');
  assert.match(JSON.stringify(modalInter.ackLog[1].payload), /Kavita Patel/);

  const pm = await state.pmByUser('new_pm_user');
  assert.ok(pm, 'PM record created in state');
  assert.equal(pm.name, 'Kavita Patel');

  // 4. PM Removal: adm:pm-del button opens picker
  const delBtnInter = makeMockInteraction('admin_user', [GRID], 'adm:pm-del');
  await router.dispatch(delBtnInter);
  assert.equal(delBtnInter.ackLog[0].type, 'deferReply');
  assert.equal(delBtnInter.ackLog[1].type, 'editReply');
  assert.match(JSON.stringify(delBtnInter.ackLog[1].payload), /Which PM do you want to remove/);

  // 5. Select PM in removal menu -> shows confirmation prompt
  const delSelInter = makeMockInteraction('admin_user', [GRID], 'adm:pm-del-sel', {
    isButton: () => false,
    isAnySelectMenu: () => true,
    values: [pm.id],
  });
  await router.dispatch(delSelInter);
  assert.equal(delSelInter.ackLog[0].type, 'update');
  assert.match(JSON.stringify(delSelInter.ackLog[0].payload), /Confirm Destructive Action/);

  // 6. Confirm removal click: adm:pm-del-ok:<pmId>
  const delConfirmInter = makeMockInteraction('admin_user', [GRID], `adm:pm-del-ok:${pm.id}`);
  await router.dispatch(delConfirmInter);
  assert.equal(delConfirmInter.ackLog[0].type, 'deferUpdate');
  assert.equal(delConfirmInter.ackLog[1].type, 'editReply');
  assert.match(JSON.stringify(delConfirmInter.ackLog[1].payload), /removed/);

  const updatedPm = await state.getPm(pm.id);
  assert.equal(updatedPm.status, 'removed', 'PM status marked as removed');
});

test('Unauthorized user access to PM Management is blocked and audited', async () => {
  const { router, audit } = await setupAdminTestEnv();

  // Plain member without GRID or ADMIN
  const inter = makeMockInteraction('random_user', ['regular_role'], 'adm:pm');
  await router.dispatch(inter);

  // Must not have called deferReply
  assert.equal(inter.deferred, false, 'Must not defer unauthorized requests');
  assert.equal(inter.ackLog.length, 1);
  assert.equal(inter.ackLog[0].type, 'reply');
  assert.match(JSON.stringify(inter.ackLog[0].payload), /restricted to the IPDC GRID role/);

  // Audit log must record authz.denied
  const recent = await audit.recent(5);
  const deniedEntry = recent.find((e) => e.action === 'authz.denied' && e.actorId === 'random_user');
  assert.ok(deniedEntry, 'Authz denial recorded in audit');
  assert.equal(deniedEntry.details.custom, 'adm:pm');
});

test('Slow Firestore simulation: interaction acknowledges before query completes', async () => {
  const { router, store } = await setupAdminTestEnv();

  // Delay store.list('pms') artificially
  const originalList = store.list.bind(store);
  let deferCalledBeforeListResolves = false;
  let testInter = null;

  store.list = async (col, opts) => {
    if (col === 'pms' && testInter) {
      deferCalledBeforeListResolves = testInter.deferred === true;
      // Simulate delay
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return originalList(col, opts);
  };

  testInter = makeMockInteraction('admin_user', [GRID], 'adm:pm');
  await router.dispatch(testInter);

  assert.equal(deferCalledBeforeListResolves, true, 'deferReply was called before slow list query executed');
  assert.equal(testInter.ackLog[0].type, 'deferReply');
  assert.equal(testInter.ackLog[1].type, 'editReply');
});

test('Firestore error during PM Management is handled gracefully without unhandled rejection', async () => {
  const { router, store } = await setupAdminTestEnv();

  // Force store.list to fail on 'pms'
  const originalList = store.list.bind(store);
  store.list = async (col, opts) => {
    if (col === 'pms') throw new Error('Firestore connection timeout');
    return originalList(col, opts);
  };

  const inter = makeMockInteraction('admin_user', [GRID], 'adm:pm');
  await router.dispatch(inter);

  // Since it was deferred, the router error catcher should call editReply with error info
  assert.equal(inter.deferred, true, 'Interaction was deferred');
  assert.equal(inter.ackLog[0].type, 'deferReply');
  assert.equal(inter.ackLog[1].type, 'editReply');
  assert.match(JSON.stringify(inter.ackLog[1].payload), /Something went wrong/);
});

test('Verify no duplicate interaction acknowledgements on PM Management', async () => {
  const { router } = await setupAdminTestEnv();

  const inter = makeMockInteraction('admin_user', [GRID], 'adm:pm');
  await router.dispatch(inter);

  // Filter acknowledgements by type
  const acks = inter.ackLog.map((a) => a.type);
  assert.deepEqual(acks, ['deferReply', 'editReply']);

  // Ensure deferReply was never called again
  const deferCount = acks.filter((a) => a === 'deferReply').length;
  assert.equal(deferCount, 1, 'deferReply called exactly once');

  // Ensure reply was never called
  const replyCount = acks.filter((a) => a === 'reply').length;
  assert.equal(replyCount, 0, 'reply was never called on deferred interaction');
});
