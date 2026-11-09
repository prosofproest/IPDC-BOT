import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Auth } from '../src/core/auth.js';
import { MemoryStore } from '../src/storage/memory.js';
import { State } from '../src/core/state.js';
import { RetryQueue } from '../src/core/queue.js';
import { RoleService } from '../src/core/roles.js';
import { AiService } from '../src/services/ai.js';
import { verifySignature, handleEvent } from '../src/webhook.js';
import { lastNinePmIst } from '../src/scheduler.js';
import { loadConfig, normalizePrivateKey } from '../src/config/env.js';
import { redact, refreshSecrets } from '../src/utils/logger.js';
import { parseGithubUsername, parseRepoRef, slugify } from '../src/utils/misc.js';
import { chunkVerbatim, LOGO_PATH } from '../src/ui.js';
import { buildWelcomePayload, loadCodeOfConduct } from '../src/features/onboarding.js';
import { WELCOME_COPY, COC_BUTTONS } from '../src/config/constants.js';
import { buildPmReportPdf } from '../src/github/reports.js';
import { renderHeatmaps } from '../src/github/render.js';
import { Activity } from '../src/github/activity.js';

const GRID = '1568690888413282396'; const ADMIN = '1568690393824891141'; const IPDC = 'ipdc-role';
const mkAuth = (grants = ['repo.change'], supportRoleIds = []) => new Auth({ ids: { grid: GRID, admin: ADMIN, ipdc: IPDC }, getSettings: async () => ({ adminGrants: grants, supportRoleIds }) });
const actor = (userId, ...roleIds) => ({ userId, roleIds });
const pm = { id: 'p1', discordUserId: 'pmUser' };

test('authorization matrix (spec section 14)', async () => {
  const a = mkAuth();
  const member = actor('m', IPDC); const pmA = actor('pmUser', IPDC); const otherPm = actor('pm2', IPDC); const admin = actor('ad', ADMIN); const grid = actor('g', GRID);
  // approve initial application: assigned PM only (+GRID override), members and ADMIN (unless granted) cannot
  assert.equal(await a.can('application.approve.initial', pmA, { pm }), true);
  assert.equal(await a.can('application.approve.initial', otherPm, { pm }), false);
  assert.equal(await a.can('application.approve.initial', member, { pm }), false);
  assert.equal(await a.can('application.approve.initial', admin, { pm }), false);
  assert.equal(await a.can('application.approve.initial', grid, { pm }), true);
  // PM applications and transfers: ADMIN and GRID, never PMs/members
  for (const act of ['application.approve.pm', 'transfer.approve']) {
    assert.equal(await a.can(act, admin), true); assert.equal(await a.can(act, grid), true);
    assert.equal(await a.can(act, pmA), false); assert.equal(await a.can(act, member), false);
  }
  // same-PM team change: current PM only
  assert.equal(await a.can('teamchange.approve', pmA, { pm }), true);
  assert.equal(await a.can('teamchange.approve', otherPm, { pm }), false);
  // admin panel + monitoring: GRID only unless explicitly granted to ADMIN
  assert.equal(await a.can('admin.panel', grid), true); assert.equal(await a.can('admin.panel', admin), false); assert.equal(await a.can('monitoring.view', admin), false);
  assert.equal(await mkAuth(['admin.panel']).can('admin.panel', admin), true);
  // repo change: own PM, GRID, ADMIN (default grant); not members / other PMs
  assert.equal(await a.can('repo.change', pmA, { pm }), true); assert.equal(await a.can('repo.change', otherPm, { pm }), false);
  assert.equal(await a.can('repo.change', member, { pm }), false); assert.equal(await a.can('repo.change', admin, { pm }), true);
  // tickets: staff = ADMIN + GRID (+ configured roles); PMs/members are not staff
  assert.equal(await a.can('ticket.manage', admin), true); assert.equal(await a.can('ticket.manage', grid), true);
  assert.equal(await a.can('ticket.manage', pmA), false); assert.equal(await a.can('ticket.manage', member), false);
  assert.equal(await mkAuth([], ['sup']).can('ticket.manage', actor('s', 'sup')), true);
  assert.equal(await a.can('ticket.create', member), true); assert.equal(await a.can('ticket.create', actor('x')), false);
});

test('IPDC GRID / ADMIN can never be assigned by the bot', async () => {
  const a = mkAuth();
  for (const who of [actor('g', GRID), actor('a', ADMIN), actor('m', IPDC)]) { assert.equal(await a.can('assign.grid', who), false); assert.equal(await a.can('assign.admin', who), false); }
  const cfg = loadConfig({}, { strict: false });
  const svc = new RoleService({ client: {}, cfg, reconciler: {}, adapter: {} });
  assert.throws(() => svc.assertAllowed([GRID]), /protected role/);
  assert.throws(() => svc.assertAllowed(['x', ADMIN]), /protected role/);
  await assert.rejects(svc.apply('u', { add: [GRID] }), /protected role/);
  await assert.rejects(svc.apply('u', { remove: [ADMIN] }), /protected role/);
  assert.doesNotThrow(() => svc.assertAllowed(['some-team-role']));
});

test('welcome embed uses the exact owner-specified copy and official logo', () => {
  const p = buildWelcomePayload('12345'); const e = p.embeds[0].toJSON();
  assert.equal(e.title, 'WELCOME TO IPDC');
  assert.equal(e.footer.text, 'INVICTUS PROJECT DEVELOPMENT CENTRE | Member Onboarding');
  const [d1, d2, d3] = e.description.split('\n\n');
  assert.equal(d1, 'Welcome, <@12345>, to the INVICTUS PROJECT DEVELOPMENT CENTRE (IPDC).');
  assert.equal(d2, 'IPDC is a collaborative project development community where members come together to build, learn, share knowledge, and turn ideas into meaningful projects. We value commitment, teamwork, responsible participation, and continuous growth.');
  assert.equal(d3, 'Before accessing the community, please review and accept the IPDC Code of Conduct. Your participation begins with understanding the standards that keep this community respectful, focused, and productive.');
  assert.equal(p.components[0].toJSON().components[0].label, 'CONTINUE TO CODE OF CONDUCT');
  assert.equal(WELCOME_COPY.button, 'CONTINUE TO CODE OF CONDUCT');
  assert.equal(COC_BUTTONS.accept, 'I AGREE — ACCEPT CODE OF CONDUCT'); assert.equal(COC_BUTTONS.reject, 'I DO NOT AGREE');
  assert.doesNotMatch(JSON.stringify(e), /[\u{1F300}-\u{1FAFF}☀-➿]/u, 'no emojis');
  assert.equal(e.image.url, 'attachment://IPDC_Official_Logo.png');
  assert.equal(p.files.length, 1);
});

test('logo asset is byte-identical to the owner supplied file', () => {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.equal(sha(LOGO_PATH), '9d696995093ebe41e4df02d06c7064c8d3387175133c38759281cddf94135064');
});

test('Code of Conduct: placeholder blocks onboarding; owner text is returned untouched', () => {
  const cfg = loadConfig({}, { strict: false });
  const tmpPlaceholder = `${process.env.TMPDIR || '/tmp'}/coc-placeholder.txt`;
  fs.writeFileSync(tmpPlaceholder, '__REPLACE_WITH_OWNER_CODE_OF_CONDUCT__\nplaceholder');
  assert.equal(loadCodeOfConduct({ ...cfg, cocFile: tmpPlaceholder }).configured, false, 'shipped placeholder must block');
  fs.rmSync(tmpPlaceholder);
  const tmp = `${process.env.TMPDIR || '/tmp'}/coc-test.txt`;
  const text = 'Line one  with  double spaces\n\n“Curly quotes” — and   trailing spaces   \nFinal line';
  fs.writeFileSync(tmp, text);
  const got = loadCodeOfConduct({ ...cfg, cocFile: tmp });
  assert.equal(got.configured, true); assert.equal(got.text, text, 'verbatim');
  fs.rmSync(tmp);
});

test('verbatim chunking never alters content', () => {
  const para = 'Respect every member. '.repeat(40);
  const text = Array.from({ length: 30 }, (_, i) => `${i + 1}. ${para}`).join('\n\n');
  const chunks = chunkVerbatim(text, 4000);
  assert.ok(chunks.length > 1); assert.ok(chunks.every((c) => c.length <= 4000));
  assert.equal(chunks.join(''), text);
});

test('AI: Gemini success, immediate Groq failover on error/timeout/unusable output, both failing', async () => {
  const cfg = { geminiKey: 'g', groqKey: 'q', geminiModel: 'm', groqModel: 'm', timeoutMs: 50 };
  const mk = (handler) => { const ai = new AiService(cfg, { record() {} }); ai.fetch = handler; return ai; };
  const ok = (body) => ({ ok: true, json: async () => body });
  const gem = ok({ candidates: [{ content: { parts: [{ text: 'Gemini summary text here.' }] } }] });
  const groq = ok({ choices: [{ message: { content: 'Groq summary text here.' } }] });
  assert.equal((await mk(async (u) => (u.includes('googleapis') ? gem : groq)).generate('hi')).provider, 'gemini');
  assert.equal((await mk(async (u) => { if (u.includes('googleapis')) return { ok: false, status: 500 }; return groq; }).generate('hi')).provider, 'groq');
  assert.equal((await mk(async (u) => (u.includes('googleapis') ? ok({ candidates: [] }) : groq)).generate('hi')).provider, 'groq');
  const slow = (u, init) => (u.includes('googleapis') ? new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))) : Promise.resolve(groq));
  const t0 = Date.now(); const r = await mk(slow).generate('hi');
  assert.equal(r.provider, 'groq'); assert.ok(Date.now() - t0 < 1000, 'no long wait before failover');
  assert.equal((await mk(async () => ({ ok: false, status: 503 })).generate('hi')).text, null);
});

test('webhook signature verification and event routing', async () => {
  const body = Buffer.from('{"a":1}'); const secret = 's3cret';
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifySignature(secret, body, sig), true);
  assert.equal(verifySignature(secret, body, `${sig.slice(0, -1)}0`), false);
  assert.equal(verifySignature(secret, body, undefined), false); assert.equal(verifySignature(null, body, sig), false);
  const calls = []; const ctx = { state: { pms: async () => [{ id: 'p', repo: { owner: 'Org', name: 'Repo' } }, { id: 'q', repo: null }] }, github: { invalidate: (...a) => calls.push(['inv', ...a]) }, monitoring: { scheduleRefreshPm: (id) => calls.push(['ref', id]) } };
  assert.equal(await handleEvent(ctx, 'push', { repository: { full_name: 'org/repo' } }), 1);
  assert.deepEqual(calls, [['inv', 'Org', 'Repo'], ['ref', 'p']]);
  assert.equal(await handleEvent(ctx, 'star', { repository: { full_name: 'org/repo' } }), 0);
});

test('scheduler: 9 PM IST slot calculation', () => {
  assert.equal(new Date(lastNinePmIst(new Date('2026-11-08T16:00:00Z'))).toISOString(), '2026-11-08T15:30:00.000Z');
  assert.equal(new Date(lastNinePmIst(new Date('2026-11-08T10:00:00Z'))).toISOString(), '2026-11-07T15:30:00.000Z');
});

test('retry queue: retries with backoff, survives restart, fails permanently after max attempts', async () => {
  const store = new MemoryStore(); let fails = 2; const ran = [];
  const q = new RetryQueue(store, { maxAttempts: 3 });
  q.register('t', async (p) => { if (fails-- > 0) throw new Error('boom'); ran.push(p.n); });
  await q.enqueue('t', { n: 1 });
  assert.equal(await q.process(), 0);
  for (const j of await store.list('queue')) await store.merge('queue', j.id, { nextAt: 0 }); // fast-forward
  const q2 = new RetryQueue(store, { maxAttempts: 3 }); q2.register('t', async (p) => { ran.push(p.n); }); // "restart"
  assert.equal(await q2.process(), 1); assert.deepEqual(ran, [1]);
  const q3 = new RetryQueue(store, { maxAttempts: 2 }); let failedJob = null; q3.onFail = (j) => { failedJob = j; };
  q3.register('bad', async () => { throw new Error('nope'); });
  await q3.enqueue('bad', {}); await q3.process();
  for (const j of await store.list('queue')) await store.merge('queue', j.id, { nextAt: 0 }); await q3.process();
  assert.ok(failedJob); assert.equal((await store.list('queue')).find((j) => j.type === 'bad').status, 'failed');
});

test('state: GitHub identity mapping prevents duplicates unless admin override', async () => {
  const s = new State(new MemoryStore());
  await s.saveMember('u1', { id: 'u1', status: 'approved' }); await s.saveMember('u2', { id: 'u2', status: 'approved' });
  await s.linkGithub('u1', 'Octo');
  await assert.rejects(s.linkGithub('u2', 'octo'), /already linked/);
  await s.linkGithub('u1', 'octo'); // same member again is fine
  await s.linkGithub('u2', 'octo', { override: true });
  assert.equal((await s.githubOwner('OCTO')).userId, 'u2'); assert.equal((await s.getMember('u1')).github, null);
  await s.linkGithub('u2', 'newname'); assert.equal(await s.githubOwner('octo'), null, 'old mapping released');
});

test('state: dynamic PM/team creation rejects duplicates, nothing hardcoded', async () => {
  const s = new State(new MemoryStore());
  const pmA = await s.createPm({ name: 'Any Name', discordUserId: '1' });
  await assert.rejects(s.createPm({ name: 'any  name', discordUserId: '2' }), /already exists/);
  await assert.rejects(s.createPm({ name: 'Other', discordUserId: '1' }), /already a PM/);
  await s.createTeam({ name: 'Backend' }); await assert.rejects(s.createTeam({ name: 'backend' }), /already exists/);
  assert.equal((await s.pms()).length, 1); assert.equal(pmA.repo, null);
});

test('env: required vars enforced, private key newline handling, secrets redacted from logs', () => {
  assert.throws(() => loadConfig({}), /Missing required environment variables/);
  assert.equal(normalizePrivateKey('"-----BEGIN KEY-----\\nabc\\n-----END KEY-----"'), '-----BEGIN KEY-----\nabc\n-----END KEY-----');
  const env = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: '1', DISCORD_GUILD_ID: '2', FIREBASE_PROJECT_ID: 'p', FIREBASE_CLIENT_EMAIL: 'e@x', FIREBASE_PRIVATE_KEY: 'k', GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };
  const cfg = loadConfig(env); assert.equal(cfg.github.enabled, false); assert.equal(cfg.tz, 'Asia/Kolkata'); assert.equal(cfg.roles.grid, GRID); assert.equal(cfg.roles.admin, ADMIN);
  assert.throws(() => loadConfig({ ...env, GEMINI_API_KEY: 'replace_with_gemini_api_key' }), /GEMINI_API_KEY/);
  refreshSecrets({ SMTP_PASS: 'hunter2-super-secret', GROQ_API_KEY: 'gsk_abcdef123456' });
  assert.equal(redact('login failed with hunter2-super-secret and gsk_abcdef123456'), 'login failed with [REDACTED] and [REDACTED]');
  assert.match(redact('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'), /REDACTED_PRIVATE_KEY/);
  refreshSecrets({});
});

test('parsers', () => {
  assert.equal(parseGithubUsername('https://github.com/octocat'), 'octocat'); assert.equal(parseGithubUsername('github.com/octo-cat/'), 'octo-cat');
  assert.equal(parseGithubUsername('https://github.com/octocat/repo'), null); assert.equal(parseGithubUsername('https://evil.com/octocat'), null);
  assert.equal(parseGithubUsername('https://github.com/settings'), null); assert.equal(parseGithubUsername('not a url'), null);
  assert.deepEqual(parseRepoRef('https://github.com/org/repo.git'), { owner: 'org', name: 'repo' }); assert.deepEqual(parseRepoRef('org/repo'), { owner: 'org', name: 'repo' });
  assert.equal(parseRepoRef('nonsense'), null); assert.equal(slugify('UI / UX'), 'ui-ux');
});

test('activity: maps commits to linked members and flags no data without credentials', async () => {
  const d = { ok: true, commits: [
    { sha: 'a', message: 'm', date: new Date().toISOString(), authorLogin: 'x', userId: 'u1', branches: ['main'] },
    { sha: 'b', message: 'm', date: new Date(Date.now() - 20 * 86400000).toISOString(), authorLogin: 'y', userId: null, branches: ['dev'] }],
  pulls: [{ state: 'merged', updatedAt: new Date().toISOString(), userId: 'u1' }, { state: 'open', updatedAt: new Date().toISOString() }], branches: [{}, {}] };
  const s = Activity.summarize(d);
  assert.equal(s.commits7, 1); assert.equal(s.commitsAll, 2); assert.equal(s.prsOpen, 1); assert.equal(s.prsMerged7, 1);
  assert.equal(Activity.lastActivity(d).has('u1'), true);
  assert.equal(Activity.summarize({ ok: false, error: 'repository not set' }).ok, false);
});

test('renderers produce a PNG heatmap and a PDF report', async () => {
  const png = renderHeatmaps([{ label: 'A', sub: 'github.com/a', total: 3, counts: new Map([['2026-11-01', 3]]) }], { weeks: 12 });
  assert.equal(png.subarray(0, 4).toString('hex'), '89504e47');
  const now = Date.now(); const data = { repo: 'org/repo', branches: [{ name: 'main' }], commits: [{ sha: 'abcdef1234', message: 'Add feature 中', date: new Date(now - 3600e3).toISOString(), url: 'https://github.com/o/r/commit/abc', authorLogin: 'x', userId: 'u1', branches: ['main'] }], pulls: [{ number: 1, title: 'PR', state: 'open', author: 'x', url: 'https://github.com/o/r/pull/1', updatedAt: new Date(now).toISOString(), head: 'f', base: 'main' }] };
  const pdf = await buildPmReportPdf({ pm: { name: 'Asha Rao' }, data, names: new Map([['u1', 'Asha']]), details: new Map([['abcdef1234', { additions: 5, deletions: 1, filesTotal: 2 }]]), summary: 'Work on features.', untilMs: now, sinceMs: now - 86400e3 });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF'); assert.ok(pdf.length > 2000);
});
