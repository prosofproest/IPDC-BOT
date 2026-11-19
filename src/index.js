import { Client, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import { loadConfig } from './config/env.js';
import { createLogger, refreshSecrets, setLogLevel } from './utils/logger.js';
import { FirestoreStore } from './storage/firestore.js';
import { State } from './core/state.js';
import { Auth } from './core/auth.js';
import { Audit } from './core/audit.js';
import { RetryQueue } from './core/queue.js';
import { GuildAdapter } from './core/guildAdapter.js';
import { Reconciler } from './core/reconcile.js';
import { RoleService } from './core/roles.js';
import { Messages } from './core/messages.js';
import { Router } from './core/router.js';
import { Managed } from './core/managed.js';
import { Health } from './services/health.js';
import { AiService } from './services/ai.js';
import { Mailer } from './services/mailer.js';
import { GitHubClient } from './github/client.js';
import { Activity } from './github/activity.js';
import { Monitoring } from './github/monitoring.js';
import { Reports } from './github/reports.js';
import { Panels } from './features/panels.js';
import { Scheduler } from './scheduler.js';
import { startHttp } from './webhook.js';
import { register as registerRequests } from './features/requests.js';
import { register as registerOnboarding, loadCodeOfConduct } from './features/onboarding.js';
import { register as registerAdmin } from './features/admin.js';
import { register as registerPm } from './features/pm.js';
import { register as registerSupport } from './features/support.js';
import { register as registerGithub, slashCommands } from './features/github.js';
import { Audit as AuditCls } from './core/audit.js';
import { handleRoleCreate, handleRoleUpdate, handleRoleDelete, handleMemberUpdate } from './core/dynamicRoles.js';

const log = createLogger('main');

async function main() {
  let cfg;
  try { cfg = loadConfig(process.env); } catch (e) { console.error(`[FATAL] ${e.message}`); process.exit(1); }
  refreshSecrets(); setLogLevel(cfg.logLevel);
  process.env.TZ = cfg.tz;
  log.info('starting IPDC Discord bot');

  const store = new FirestoreStore(cfg.firebase);
  await store.ping();
  log.info('Firestore connected');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.GuildMember, Partials.Channel],
  });

  const health = new Health();
  const state = new State(store);
  const audit = new Audit(store);
  const adapter = new GuildAdapter(client, cfg.discord.guildId);
  const queue = new RetryQueue(store);
  const reconciler = new Reconciler({ adapter, store, state, cfg, audit, queue });
  const auth = new Auth({ ids: { grid: cfg.roles.grid, admin: cfg.roles.admin, get ipdc() { return reconciler._ipdcId; } }, getSettings: () => state.settings() });
  const github = new GitHubClient(cfg.github);
  const roles = new RoleService({ client, cfg, reconciler, adapter });
  reconciler.roles = roles;
  const ctx = {
    cfg, client, store, state, auth, audit, queue, adapter, reconciler, health, github, router: null,
    roles,
    messages: new Messages({ client, store, cfg, reconciler }),
    managed: new Managed({ client, store, cfg, state }),
    ai: new AiService(cfg.ai, health), mailer: new Mailer(cfg.smtp, health),
  };
  reconciler.managed = ctx.managed;
  health.github = github;
  ctx.activity = new Activity({ github, state, store, health });
  ctx.monitoring = new Monitoring(ctx);
  ctx.reports = new Reports(ctx); ctx.reports.register();
  ctx.panels = new Panels(ctx);
  const router = new Router(); router.ctx = ctx; ctx.router = router;

  // The IPDC member role id lives in the registry; keep a synchronous copy for auth checks.
  const origPersist = reconciler._persist.bind(reconciler);
  reconciler._persist = async (reg, entry) => { await origPersist(reg, entry); if (entry.key === 'role:ipdc') reconciler._ipdcId = entry.id; };

  registerRequests(router, ctx); registerOnboarding(router, ctx); registerAdmin(router, ctx);
  registerPm(router, ctx); registerSupport(router, ctx); registerGithub(router, ctx);

  queue.onFail = (job, e) => audit.log({ action: 'queue.job_failed', level: 'error', details: { type: job.type, error: e.message } });
  audit.setSink(async (entry) => {
    const ch = await ctx.messages.channelFor('ch:admin-audit-logs'); if (!ch) return;
    await ch.send({ embeds: [AuditCls.toEmbed(entry)], allowedMentions: { parse: [] } });
  });

  client.on('interactionCreate', (i) => { if (i.guildId && i.guildId !== cfg.discord.guildId) return; router.dispatch(i); });
  client.on('roleCreate', async (role) => {
    if (role.guild?.id && role.guild.id !== cfg.discord.guildId) return;
    try { await handleRoleCreate(ctx, role); }
    catch (e) { log.error(`roleCreate error for ${role.name}:`, e); }
  });
  client.on('roleUpdate', async (oldRole, newRole) => {
    if (newRole.guild?.id && newRole.guild.id !== cfg.discord.guildId) return;
    try { await handleRoleUpdate(ctx, oldRole, newRole); }
    catch (e) { log.error(`roleUpdate error for ${newRole.name}:`, e); }
  });
  client.on('roleDelete', async (role) => {
    if (role.guild?.id && role.guild.id !== cfg.discord.guildId) return;
    try { await handleRoleDelete(ctx, role); }
    catch (e) { log.error(`roleDelete error for ${role.name}:`, e); }
  });
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (newMember.guild?.id && newMember.guild.id !== cfg.discord.guildId) return;
    try { await handleMemberUpdate(ctx, oldMember, newMember); }
    catch (e) { log.error(`guildMemberUpdate error for ${newMember.user?.tag || newMember.id}:`, e); }
  });
  client.on('error', (e) => log.error('client error', e));
  client.on('warn', (m) => log.warn(m));

  const scheduler = new Scheduler(ctx);
  let http = null;

  client.once('clientReady', async () => {
    try {
      log.info(`logged in as ${client.user.tag}`);
      const guild = await client.guilds.fetch(cfg.discord.guildId).catch(() => null);
      if (!guild) { log.error('The bot is not a member of the configured DISCORD_GUILD_ID. Invite it first.'); process.exit(1); }
      await guild.roles.fetch(); await guild.channels.fetch();

      const rest = new REST({ version: '10' }).setToken(cfg.discord.token);
      await rest.put(Routes.applicationGuildCommands(cfg.discord.clientId, cfg.discord.guildId), { body: slashCommands });

      const reg = await store.get('registry', 'role:ipdc'); if (reg) reconciler._ipdcId = reg.id;
      const summary = await reconciler.run('startup');
      reconciler._ipdcId = (await store.get('registry', 'role:ipdc'))?.id;
      health.record('startup:reconcile', !summary.errors?.length, summary.skipped ? 'lock held' : `created ${summary.created}, repaired ${summary.repaired}`);

      if (!loadCodeOfConduct(cfg).configured) log.warn('Code of Conduct not configured: edit config/code-of-conduct.txt (onboarding will not proceed until then).');
      if (!github.enabled) log.warn('GitHub App/token not configured: monitoring, heatmaps and reports are inactive.');
      if (!cfg.smtp.enabled) log.warn('SMTP not configured: daily PDF reports will not be emailed.');

      await ctx.panels.ensureAll();
      queue.start(); await queue.process();
      scheduler.start(); await scheduler.catchUp();
      http = startHttp(ctx);
      health.record('startup', true, 'ready');
      log.info('IPDC bot ready');
    } catch (e) { log.error('startup failed', e); health.record('startup', false, e.message); }
  });

  const shutdown = async (sig) => {
    log.info(`${sig} received; shutting down`);
    try { scheduler.stop(); queue.stop(); http?.close(); await client.destroy(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
  process.on('uncaughtException', (e) => log.error('uncaughtException', e));

  await client.login(cfg.discord.token);
}

main().catch((e) => { console.error('[FATAL]', e?.message || e); process.exit(1); });
