import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitoring } from '../src/github/monitoring.js';
import { MemoryStore } from '../src/storage/memory.js';
import { State } from '../src/core/state.js';
import { Audit } from '../src/core/audit.js';
import { Router } from '../src/core/router.js';
import { register as registerGithub } from '../src/features/github.js';
import { KEYS } from '../src/core/structure.js';
import { dayKeyIST } from '../src/utils/misc.js';

const DAY = 86400000;
const GRID = '1568690888413282396';
const ADMIN = '1568690393824891141';

function setupMonitoringEnv() {
  const store = new MemoryStore();
  const state = new State(store);
  const audit = new Audit(store);
  const sentMessages = new Map();

  const client = {
    guilds: {
      cache: {
        get: () => ({
          members: {
            cache: new Map([
              ['u1', { displayName: 'Alice' }],
              ['u2', { displayName: 'Bob' }],
              ['u3', { displayName: 'Charlie' }],
            ]),
            fetch: async () => {},
          },
        }),
      },
    },
  };

  const messages = {
    channelFor: async (key) => ({
      key,
      send: async (payload) => {
        const list = sentMessages.get(key) || [];
        list.push(payload);
        sentMessages.set(key, list);
        return { id: `msg_${Date.now()}` };
      },
    }),
  };

  const ctx = {
    store,
    state,
    audit,
    client,
    messages,
    cfg: { discord: { guildId: 'test_guild' } },
    github: { enabled: true },
    health: { record: () => {} },
  };

  const monitoring = new Monitoring(ctx);
  return { store, state, audit, client, messages, sentMessages, ctx, monitoring };
}

// ==============================================================================
// 1. MONITORING PAYLOADS TESTS
// ==============================================================================

test('monitoring: heatmapPayload generates sorted heatmaps, attachments, and buttons', async () => {
  const { monitoring, state } = setupMonitoringEnv();
  await state.saveSettings({ maxHeatmapMembersInline: 12, heatmapWeeks: 20 });

  const members = [
    { id: 'u1', github: { username: 'alice_gh' }, status: 'approved' },
    { id: 'u2', github: { username: 'bob_gh' }, status: 'approved' },
  ];

  const cals = new Map([
    ['u1', { username: 'alice_gh', source: 'github', total: 42, counts: new Map([['2026-11-01', 5]]) }],
    ['u2', { username: 'bob_gh', source: 'github', total: 99, counts: new Map([['2026-11-01', 12]]) }],
  ]);

  const payload = await monitoring.heatmapPayload(cals, members);
  assert.equal(payload.embeds.length, 1);
  const emb = payload.embeds[0];
  assert.equal(emb.data.title, 'GITHUB CONTRIBUTION HEATMAPS');
  assert.match(emb.data.description, /2 registered members/);

  // Files verification
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, 'heatmaps.png');
  assert.ok(payload.hashExtra, 'Has hashExtra');

  // Interactive buttons & select menu
  assert.equal(payload.components.length, 2);
  const btnRow = payload.components[0];
  const customIds = btnRow.components.map((c) => c.data.custom_id);
  assert.ok(customIds.includes('gh:browse:0'));
  assert.ok(customIds.includes('gh:mine'));

  const selectRow = payload.components[1];
  assert.equal(selectRow.components[0].data.custom_id, 'gh:member');
});

test('monitoring: heatmapPayload handles empty members and unlinked users gracefully', async () => {
  const { monitoring } = setupMonitoringEnv();
  const payload = await monitoring.heatmapPayload(new Map(), []);
  assert.equal(payload.embeds.length, 1);
  assert.match(payload.embeds[0].data.description, /0 registered members/);
  assert.equal(payload.files[0].name, 'heatmaps.png');
});

test('monitoring: heatmapPayload supports ephemeral pagination controls', async () => {
  const { monitoring, state } = setupMonitoringEnv();
  await state.saveSettings({ maxHeatmapMembersInline: 1, heatmapWeeks: 20 });

  const members = [
    { id: 'u1', github: { username: 'alice_gh' }, status: 'approved' },
    { id: 'u2', github: { username: 'bob_gh' }, status: 'approved' },
  ];
  const cals = new Map([
    ['u1', { username: 'alice_gh', source: 'github', total: 10, counts: new Map() }],
    ['u2', { username: 'bob_gh', source: 'github', total: 20, counts: new Map() }],
  ]);

  // Page 0 (first page): previous disabled, next enabled
  const p0 = await monitoring.heatmapPayload(cals, members, { page: 0, per: 1, ephemeral: true });
  assert.match(p0.embeds[0].data.description, /page 1 of 2/);
  const p0Btns = p0.components[0].components;
  assert.equal(p0Btns[0].data.disabled, true, 'previous disabled on page 0');
  assert.equal(p0Btns[1].data.disabled, false, 'next enabled on page 0');

  // Page 1 (last page): previous enabled, next disabled
  const p1 = await monitoring.heatmapPayload(cals, members, { page: 1, per: 1, ephemeral: true });
  assert.match(p1.embeds[0].data.description, /page 2 of 2/);
  const p1Btns = p1.components[0].components;
  assert.equal(p1Btns[0].data.disabled, false, 'previous enabled on last page');
  assert.equal(p1Btns[1].data.disabled, true, 'next disabled on last page');
});

test('monitoring: leaderboardPayload ranks members and handles empty state', () => {
  const { monitoring } = setupMonitoringEnv();
  const members = [
    { id: 'u1', github: { username: 'alice' } },
    { id: 'u2', github: { username: 'bob' } },
  ];
  const names = new Map([['u1', 'Alice'], ['u2', 'Bob']]);

  const today = dayKeyIST(new Date());
  const oldDate = dayKeyIST(new Date(Date.now() - 40 * DAY));

  const cals = new Map([
    ['u1', { total: 15, source: 'github', counts: new Map([[today, 15]]) }],
    ['u2', { total: 50, source: 'github', counts: new Map([[today, 5], [oldDate, 45]]) }],
  ]);

  // Over 30-day window: u1 has 15 (ranks 1st), u2 has 5 within window (ranks 2nd)
  const payload = monitoring.leaderboardPayload(cals, members, names, 30);
  assert.equal(payload.embeds.length, 1);
  const emb = payload.embeds[0];
  assert.equal(emb.data.title, 'CONTRIBUTION LEADERBOARD — LAST 30 DAYS');
  assert.match(emb.data.description, /\*\*1\.\*\* <@u1> — 15/);
  assert.match(emb.data.description, /\*\*2\.\*\* <@u2> — 5/);

  // Empty leaderboard
  const empty = monitoring.leaderboardPayload(new Map(), [], names, 30);
  assert.match(empty.embeds[0].data.description, /No linked GitHub activity yet\./);
});

test('monitoring: serverActivityPayload summarizes multiple PM teams with AI line and error states', async () => {
  const { monitoring } = setupMonitoringEnv();

  const now = Date.now();
  const snaps = [
    {
      pmId: 'pm1',
      pmName: 'Alpha Project',
      ok: true,
      repo: 'org/alpha',
      commits: [
        { sha: 'c1', message: 'feat: add login', date: new Date(now - 1 * DAY).toISOString(), branches: ['main'] },
        { sha: 'c2', message: 'fix: patch bug', date: new Date(now - 2 * DAY).toISOString(), branches: ['main'] },
      ],
      branches: [{ name: 'main' }],
      pulls: [
        { state: 'open', updatedAt: new Date(now).toISOString() },
        { state: 'merged', updatedAt: new Date(now).toISOString() },
      ],
    },
    {
      pmId: 'pm2',
      pmName: 'Beta Project',
      ok: false,
      error: 'repository not accessible to the GitHub App',
    },
  ];

  const payload = await monitoring.serverActivityPayload(snaps, 'AI insight: High velocity this week.');
  assert.equal(payload.embeds.length, 1);
  const emb = payload.embeds[0];
  assert.equal(emb.data.title, 'SERVER ACTIVITY');
  assert.match(emb.data.description, /2 PM teams — 2 commits across all monitored repositories/);
  assert.match(emb.data.description, /AI insight: High velocity this week\./);

  assert.equal(emb.data.fields.length, 2);
  assert.equal(emb.data.fields[0].name, 'Alpha Project');
  assert.match(emb.data.fields[0].value, /2 commits \(7d\)/);
  assert.match(emb.data.fields[0].value, /PRs merged \(7d\): 1 \| open: 1 \| active branches: 1/);

  assert.equal(emb.data.fields[1].name, 'Beta Project');
  assert.match(emb.data.fields[1].value, /Monitoring unavailable: repository not accessible to the GitHub App/);

  // Empty snapshot test
  const emptyPayload = await monitoring.serverActivityPayload([], null);
  assert.match(emptyPayload.embeds[0].data.description, /0 PM teams — 0 commits/);
  assert.equal((emptyPayload.embeds[0].data.fields || []).length, 0);
});

// ==============================================================================
// 2. PM INACTIVITY ALERTS TESTS
// ==============================================================================

test('inactivityAlerts: alerts sent only to PM private control channel for inactive members', async () => {
  const { monitoring, state, store, sentMessages } = setupMonitoringEnv();

  const pm = await state.createPm({ name: 'Kavita Patel', discordUserId: 'kavita_user' });
  const now = Date.now();

  // Active member (has recent commit)
  await state.saveMember('mem_active', {
    id: 'mem_active',
    pmId: pm.id,
    status: 'approved',
    github: { username: 'active_dev' },
    approvedAt: now - 30 * DAY,
  });

  // Inactive member (approved 20 days ago, no commits or activity)
  await state.saveMember('mem_inactive', {
    id: 'mem_inactive',
    pmId: pm.id,
    status: 'approved',
    github: { username: 'inactive_dev' },
    approvedAt: now - 20 * DAY,
  });

  const snaps = [{
    pmId: pm.id,
    ok: true,
    commits: [
      { sha: 'c1', userId: 'mem_active', date: new Date(now - 1 * DAY).toISOString() },
    ],
  }];

  const cals = new Map();
  const settings = { inactivityDays: 7 };

  await monitoring.inactivityAlerts(snaps, cals, settings);

  const controlChannelKey = KEYS.pmControl(pm.id);
  const alertsSent = sentMessages.get(controlChannelKey);
  assert.ok(alertsSent, 'Message sent to PM control channel');
  assert.equal(alertsSent.length, 1);

  const alertEmb = alertsSent[0].embeds[0];
  assert.equal(alertEmb.data.title, 'INACTIVITY NOTICE');
  assert.match(alertEmb.data.description, /<@mem_inactive>/, 'Mentions inactive member');
  assert.doesNotMatch(alertEmb.data.description, /<@mem_active>/, 'Does not mention active member');

  // Verify persistence in alerts collection
  const alertRecord = await store.get('alerts', pm.id);
  assert.deepEqual(alertRecord.ids, ['mem_inactive']);

  // Verify audit log
  const auditLogs = await store.list('audit');
  const alertAudit = auditLogs.find((a) => a.action === 'monitoring.inactivity_alert');
  assert.ok(alertAudit);
  assert.equal(alertAudit.details.pmId, pm.id);
  assert.equal(alertAudit.details.count, 1);
});

test('inactivityAlerts: prevents duplicate alerts within the cooldown period', async () => {
  const { monitoring, state, store, sentMessages } = setupMonitoringEnv();

  const pm = await state.createPm({ name: 'Arjun Rao', discordUserId: 'arjun_user' });
  const now = Date.now();

  await state.saveMember('mem_in1', {
    id: 'mem_in1',
    pmId: pm.id,
    status: 'approved',
    github: { username: 'in1' },
    approvedAt: now - 15 * DAY,
  });

  const snaps = [{ pmId: pm.id, ok: true, commits: [] }];
  const cals = new Map();
  const settings = { inactivityDays: 7 };

  // Run 1: Sends first alert
  await monitoring.inactivityAlerts(snaps, cals, settings);
  const controlKey = KEYS.pmControl(pm.id);
  assert.equal(sentMessages.get(controlKey).length, 1);

  // Run 2: Same inactive member set within 7 days -> suppressed
  await monitoring.inactivityAlerts(snaps, cals, settings);
  assert.equal(sentMessages.get(controlKey).length, 1, 'Duplicate alert was suppressed');

  // Add a newly inactive member -> fresh alert sent
  await state.saveMember('mem_in2', {
    id: 'mem_in2',
    pmId: pm.id,
    status: 'approved',
    github: { username: 'in2' },
    approvedAt: now - 15 * DAY,
  });

  await monitoring.inactivityAlerts(snaps, cals, settings);
  assert.equal(sentMessages.get(controlKey).length, 2, 'Sent new alert when set expanded');
  const updatedRecord = await store.get('alerts', pm.id);
  assert.ok(updatedRecord.ids.includes('mem_in1') && updatedRecord.ids.includes('mem_in2'));
});

test('inactivityAlerts: failed channel resolution aborts before marking alert delivered', async () => {
  const { monitoring, state, store, messages } = setupMonitoringEnv();

  const pm = await state.createPm({ name: 'Meera Sen', discordUserId: 'meera_user' });
  await state.saveMember('mem_in', {
    id: 'mem_in',
    pmId: pm.id,
    status: 'approved',
    github: { username: 'in_dev' },
    approvedAt: Date.now() - 20 * DAY,
  });

  // Simulate channel resolution failure (e.g. Discord API failure fetching channel)
  messages.channelFor = async () => {
    throw new Error('Discord channel lookup failed');
  };

  const snaps = [{ pmId: pm.id, ok: true, commits: [] }];
  await assert.rejects(
    monitoring.inactivityAlerts(snaps, new Map(), { inactivityDays: 7 }),
    /Discord channel lookup failed/
  );

  // Verify alert was NOT recorded as delivered
  const record = await store.get('alerts', pm.id);
  assert.equal(record, null, 'Failed delivery did not mark alert as delivered');
});

test('inactivityAlerts: successful channel lookup followed by rejected channel.send does not persist delivery or audit', async () => {
  const { monitoring, state, store, messages } = setupMonitoringEnv();

  const pm = await state.createPm({ name: 'Meera Sen', discordUserId: 'meera_user' });
  await state.saveMember('mem_in', {
    id: 'mem_in',
    pmId: pm.id,
    status: 'approved',
    github: { username: 'in_dev' },
    approvedAt: Date.now() - 20 * DAY,
  });

  // Channel lookup succeeds, but send() rejects (e.g. Discord API 500 error)
  messages.channelFor = async (key) => ({
    key,
    send: async () => {
      throw new Error('Discord API 500 error: Internal Server Error');
    },
  });

  const snaps = [{ pmId: pm.id, ok: true, commits: [] }];
  await monitoring.inactivityAlerts(snaps, new Map(), { inactivityDays: 7 });

  // Verify alert state was NOT persisted
  const record = await store.get('alerts', pm.id);
  assert.equal(record, null, 'Failed send must not mark alert as delivered');

  // Verify audit event was NOT written
  const auditLogs = await store.list('audit');
  const alertAudit = auditLogs.find((a) => a.action === 'monitoring.inactivity_alert');
  assert.equal(alertAudit, undefined, 'No success audit event written on failed send');
});

test('inactivityAlerts: missing channel does not persist delivery', async () => {
  const { monitoring, state, store, messages } = setupMonitoringEnv();

  const pm = await state.createPm({ name: 'Dev Sharma', discordUserId: 'dev_user' });
  await state.saveMember('mem_in', {
    id: 'mem_in',
    pmId: pm.id,
    status: 'approved',
    github: { username: 'in_dev' },
    approvedAt: Date.now() - 20 * DAY,
  });

  // Channel resolution returns null (channel deleted or missing)
  messages.channelFor = async () => null;

  const snaps = [{ pmId: pm.id, ok: true, commits: [] }];
  await monitoring.inactivityAlerts(snaps, new Map(), { inactivityDays: 7 });

  const record = await store.get('alerts', pm.id);
  assert.equal(record, null, 'Missing channel must not mark alert as delivered');

  const auditLogs = await store.list('audit');
  assert.equal(auditLogs.find((a) => a.action === 'monitoring.inactivity_alert'), undefined);
});

test('inactivityAlerts: subsequent retry after a definite send failure can attempt delivery again', async () => {
  const { monitoring, state, store, messages, sentMessages } = setupMonitoringEnv();

  const pm = await state.createPm({ name: 'Rohan Gupta', discordUserId: 'rohan_user' });
  await state.saveMember('mem_in', {
    id: 'mem_in',
    pmId: pm.id,
    status: 'approved',
    github: { username: 'in_dev' },
    approvedAt: Date.now() - 20 * DAY,
  });

  let shouldFail = true;
  messages.channelFor = async (key) => ({
    key,
    send: async (payload) => {
      if (shouldFail) throw new Error('Discord rate limit / temporary outage');
      const list = sentMessages.get(key) || [];
      list.push(payload);
      sentMessages.set(key, list);
      return { id: 'msg_success' };
    },
  });

  const snaps = [{ pmId: pm.id, ok: true, commits: [] }];
  const controlKey = KEYS.pmControl(pm.id);

  // Attempt 1: send fails
  await monitoring.inactivityAlerts(snaps, new Map(), { inactivityDays: 7 });
  assert.equal(await store.get('alerts', pm.id), null, 'Attempt 1: Not recorded as delivered');
  assert.equal(sentMessages.get(controlKey)?.length || 0, 0, 'Attempt 1: No message delivered');

  // Attempt 2: retry succeeds (e.g. rate limit expired or API recovered)
  shouldFail = false;
  await monitoring.inactivityAlerts(snaps, new Map(), { inactivityDays: 7 });

  assert.equal(sentMessages.get(controlKey)?.length, 1, 'Attempt 2: Successfully delivered alert message');
  const record = await store.get('alerts', pm.id);
  assert.ok(record, 'Attempt 2: Alert record persisted');
  assert.deepEqual(record.ids, ['mem_in']);

  const auditLogs = await store.list('audit');
  const alertAudit = auditLogs.find((a) => a.action === 'monitoring.inactivity_alert');
  assert.ok(alertAudit, 'Attempt 2: Audit event written');
  assert.equal(alertAudit.details.pmId, pm.id);

  // Attempt 3: 7-day cooldown prevents duplicate after successful delivery
  await monitoring.inactivityAlerts(snaps, new Map(), { inactivityDays: 7 });
  assert.equal(sentMessages.get(controlKey)?.length, 1, 'Attempt 3: No duplicate alert sent');
});

test('inactivityAlerts: persistence failure after successful Discord send leaves alert unpersisted without crashing loop', async () => {
  const { monitoring, state, store, sentMessages } = setupMonitoringEnv();

  const pm = await state.createPm({ name: 'Vikram Seth', discordUserId: 'vikram_user' });
  await state.saveMember('mem_in', {
    id: 'mem_in',
    pmId: pm.id,
    status: 'approved',
    github: { username: 'in_dev' },
    approvedAt: Date.now() - 20 * DAY,
  });

  const snaps = [{ pmId: pm.id, ok: true, commits: [] }];
  const controlKey = KEYS.pmControl(pm.id);

  // Hook store.set to reject when saving to 'alerts'
  const origSet = store.set.bind(store);
  let failPersistence = true;
  store.set = async (col, id, val) => {
    if (col === 'alerts' && failPersistence) {
      throw new Error('Firestore write failure during alert persistence');
    }
    return origSet(col, id, val);
  };

  // Run monitoring: channel.send resolves, but store.set('alerts', ...) rejects.
  // The try/catch block must log a warning and continue without crashing.
  await monitoring.inactivityAlerts(snaps, new Map(), { inactivityDays: 7 });

  // Discord message was delivered successfully
  assert.equal(sentMessages.get(controlKey)?.length, 1, 'Discord message was delivered');

  // Alert state was not persisted in storage due to write failure
  const alertRecord = await store.get('alerts', pm.id);
  assert.equal(alertRecord, null, 'Alert state was not persisted');

  // Audit event was not logged because persistence failed beforehand in the try block
  const auditLogs = await store.list('audit');
  assert.equal(auditLogs.find((a) => a.action === 'monitoring.inactivity_alert'), undefined);

  // DOCUMENTATION OF AT-LEAST-ONCE BEHAVIOR:
  // Because the alert state was not persisted, a subsequent scheduled run does not know the message was sent,
  // and will attempt delivery again (resending the alert). This guarantees at-least-once delivery semantics
  // when persistence fails after a successful Discord send.
  failPersistence = false;
  await monitoring.inactivityAlerts(snaps, new Map(), { inactivityDays: 7 });

  assert.equal(sentMessages.get(controlKey)?.length, 2, 'Subsequent run resends alert because prior persistence failed');
  const persistedRecord = await store.get('alerts', pm.id);
  assert.deepEqual(persistedRecord.ids, ['mem_in'], 'Alert state now persisted after retry');
});

test('inactivityAlerts: audit failure after successful persistence preserves alert state and prevents duplicate alerts', async () => {
  const { monitoring, state, store, audit, sentMessages } = setupMonitoringEnv();

  const pm = await state.createPm({ name: 'Ananya Roy', discordUserId: 'ananya_user' });
  await state.saveMember('mem_in', {
    id: 'mem_in',
    pmId: pm.id,
    status: 'approved',
    github: { username: 'in_dev' },
    approvedAt: Date.now() - 20 * DAY,
  });

  const snaps = [{ pmId: pm.id, ok: true, commits: [] }];
  const controlKey = KEYS.pmControl(pm.id);

  // Make audit.log reject after store.set has already succeeded
  audit.log = async () => {
    throw new Error('Audit sink unavailable / write failure');
  };

  // Run monitoring: channel.send and store.set succeed, audit.log rejects.
  // Must handle gracefully without crashing the loop.
  await monitoring.inactivityAlerts(snaps, new Map(), { inactivityDays: 7 });

  // 1. Discord message was sent
  assert.equal(sentMessages.get(controlKey)?.length, 1, 'Discord message was sent');

  // 2. Alert state was successfully persisted before audit failed
  const alertRecord = await store.get('alerts', pm.id);
  assert.ok(alertRecord, 'Alert record was persisted before audit failed');
  assert.deepEqual(alertRecord.ids, ['mem_in'], 'Persisted record contains inactive member IDs');

  // 3. Subsequent run within cooldown does NOT send a duplicate
  await monitoring.inactivityAlerts(snaps, new Map(), { inactivityDays: 7 });
  assert.equal(sentMessages.get(controlKey)?.length, 1, 'No duplicate alert sent on subsequent run');
});

// ==============================================================================
// 3. GITHUB LINKING INTERACTION TESTS (/ipdc link-github)
// ==============================================================================

function setupSlashCommandEnv() {
  const store = new MemoryStore();
  const state = new State(store);
  const audit = new Audit(store);
  const router = new Router();

  let verifyUserImpl = async (username) => ({ login: username, id: 12345 });

  const ctx = {
    store,
    state,
    audit,
    github: {
      verifyUser: async (u) => verifyUserImpl(u),
    },
    auth: {
      can: async () => true,
    },
    reconciler: {
      run: async () => ({ skipped: false, reused: 0, adopted: 0, created: 0, repaired: 0, errors: [] }),
    },
  };

  registerGithub(router, ctx);

  const makeSlashInteraction = (userId, subcommand, options = {}) => {
    const replies = [];
    return {
      replies,
      commandName: 'ipdc',
      isChatInputCommand: () => true,
      isButton: () => false,
      isAnySelectMenu: () => false,
      isModalSubmit: () => false,
      user: { id: userId, tag: `${userId}#0001` },
      member: { id: userId, roleIds: [] },
      replied: false,
      deferred: false,
      deferReply: async function () { this.deferred = true; },
      editReply: async function (p) { replies.push(p); this.replied = true; },
      reply: async function (p) { replies.push(p); this.replied = true; },
      followUp: async function (p) { replies.push(p); },
      options: {
        getSubcommand: () => subcommand,
        getString: (name) => options[name],
      },
    };
  };

  return { store, state, audit, router, ctx, makeSlashInteraction, setVerifyUser: (fn) => { verifyUserImpl = fn; } };
}

test('/ipdc link-github: successfully links valid verified profile to approved member', async () => {
  const { state, router, audit, makeSlashInteraction } = setupSlashCommandEnv();

  // Create approved member
  await state.saveMember('user_100', { id: 'user_100', status: 'approved' });

  const inter = makeSlashInteraction('user_100', 'link-github', { url: 'https://github.com/octocat' });
  await router.dispatch(inter);

  assert.equal(inter.deferred, true);
  assert.equal(inter.replies.length, 1);
  const replyEmb = inter.replies[0].embeds[0];
  assert.match(replyEmb.data.description, /Linked to GitHub user \*\*octocat\*\*/);

  // Check state mapping
  const owner = await state.githubOwner('octocat');
  assert.equal(owner?.userId, 'user_100');

  const member = await state.getMember('user_100');
  assert.equal(member.github?.username, 'octocat');

  // Check audit log
  const auditLogs = await audit.store.list('audit');
  const linkAudit = auditLogs.find((a) => a.action === 'github.linked');
  assert.ok(linkAudit);
  assert.equal(linkAudit.actorId, 'user_100');
  assert.equal(linkAudit.details.username, 'octocat');
});

test('/ipdc link-github: rejects unapproved member', async () => {
  const { state, router, makeSlashInteraction } = setupSlashCommandEnv();

  // Member not approved (pending onboarding)
  await state.saveMember('user_unapproved', { id: 'user_unapproved', status: 'pending' });

  const inter = makeSlashInteraction('user_unapproved', 'link-github', { url: 'https://github.com/octocat' });
  await router.dispatch(inter);

  const replyEmb = inter.replies[0].embeds[0];
  assert.match(replyEmb.data.description, /Only approved members can update their GitHub link/);

  assert.equal(await state.githubOwner('octocat'), null);
});

test('/ipdc link-github: rejects invalid URL or malformed profile URL', async () => {
  const { state, router, makeSlashInteraction } = setupSlashCommandEnv();
  await state.saveMember('user_101', { id: 'user_101', status: 'approved' });

  // Not a GitHub URL
  const inter1 = makeSlashInteraction('user_101', 'link-github', { url: 'https://gitlab.com/octocat' });
  await router.dispatch(inter1);
  assert.match(inter1.replies[0].embeds[0].data.description, /Enter a profile URL like/);

  // Repository URL instead of profile URL
  const inter2 = makeSlashInteraction('user_101', 'link-github', { url: 'https://github.com/octocat/repo' });
  await router.dispatch(inter2);
  assert.match(inter2.replies[0].embeds[0].data.description, /Enter a profile URL like/);

  assert.equal(await state.githubOwner('octocat'), null);
});

test('/ipdc link-github: rejects unverified profile when GitHub API returns 404 or fails', async () => {
  const { state, router, makeSlashInteraction, setVerifyUser } = setupSlashCommandEnv();
  await state.saveMember('user_102', { id: 'user_102', status: 'approved' });

  // Simulate user not found on GitHub
  setVerifyUser(async () => null);

  const inter = makeSlashInteraction('user_102', 'link-github', { url: 'https://github.com/nonexistent-user' });
  await router.dispatch(inter);

  assert.match(inter.replies[0].embeds[0].data.description, /That GitHub profile could not be verified/);
  assert.equal(await state.githubOwner('nonexistent-user'), null);
});

test('/ipdc link-github: rejects duplicate profile already linked to another member', async () => {
  const { state, router, makeSlashInteraction } = setupSlashCommandEnv();

  await state.saveMember('user_alice', { id: 'user_alice', status: 'approved' });
  await state.saveMember('user_bob', { id: 'user_bob', status: 'approved' });

  // Alice links 'octocat' first
  await state.linkGithub('user_alice', 'octocat');

  // Bob attempts to link same 'octocat'
  const interBob = makeSlashInteraction('user_bob', 'link-github', { url: 'https://github.com/octocat' });
  await router.dispatch(interBob);

  assert.match(interBob.replies[0].embeds[0].data.description, /already linked to another member/);

  // Ownership remains with Alice
  const owner = await state.githubOwner('octocat');
  assert.equal(owner?.userId, 'user_alice');
});
