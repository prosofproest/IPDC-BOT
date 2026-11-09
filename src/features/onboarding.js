import fs from 'node:fs';
import path from 'node:path';
import { ActionRowBuilder, ButtonStyle, ChannelType, ModalBuilder, OverwriteType, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { BRAND, COC_BUTTONS, COC_PLACEHOLDER_MARKER, WELCOME_CHANNEL_TTL_MS, WELCOME_COPY } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { parseGithubUsername, sha, slugify } from '../utils/misc.js';
import { KEYS, bitsOf, PERM_GROUPS } from '../core/structure.js';
import { say } from '../core/router.js';
import { ROOT, LOGO_URL, button, chunkVerbatim, embed, errEmbed, logoAttachment, okEmbed, row } from '../ui.js';

const log = createLogger('onboarding');

/** Load the owner-supplied Code of Conduct exactly as written. Never logged, never modified. */
export function loadCodeOfConduct(cfg) {
  const file = path.isAbsolute(cfg.cocFile) ? cfg.cocFile : path.join(ROOT, cfg.cocFile);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { configured: false, text: '' }; }
  const configured = text.trim().length > 0 && !text.includes(COC_PLACEHOLDER_MARKER);
  return { configured, text };
}

export function buildWelcomePayload(userId) {
  const description = [WELCOME_COPY.description.replace('{member_mention}', `<@${userId}>`), WELCOME_COPY.body, WELCOME_COPY.nextStep].join('\n\n');
  const e = embed({ title: WELCOME_COPY.title, description, footer: WELCOME_COPY.footer });
  e.setImage(LOGO_URL);
  return {
    embeds: [e],
    components: [row(button(`onb:continue:${userId}`, WELCOME_COPY.button, ButtonStyle.Primary))],
    files: [logoAttachment()],
    allowedMentions: { users: [userId] },
  };
}

export function register(router, ctx) {
  const { store, state, audit, queue, client, cfg } = ctx;
  let cocAlertAt = 0;

  const isOwner = (i, uid) => i.user.id === uid;
  const guild = () => client.guilds.cache.get(cfg.discord.guildId);

  async function alertCocMissing() {
    if (Date.now() - cocAlertAt < 3600_000) return; cocAlertAt = Date.now();
    await audit.log({ action: 'config.code_of_conduct_missing', level: 'error', details: { hint: 'Place the owner-supplied text in config/code-of-conduct.txt and restart.' } });
  }

  // ---- temporary private welcome channel ----
  async function ensureWelcomeChannel(member) {
    const g = guild();
    const rec = await store.get('welcomeChannels', member.id);
    if (rec) { try { const c = await g.channels.fetch(rec.channelId); if (c) return { channel: c, reused: true }; } catch { /* recreate */ } }
    const parentId = await ctx.reconciler.getObjectId('cat:welcome');
    const gridId = cfg.roles.grid; const adminId = cfg.roles.admin;
    const read = bitsOf(PERM_GROUPS.READ); const noPost = bitsOf(PERM_GROUPS.NO_POST); const staff = bitsOf(PERM_GROUPS.STAFF);
    const overwrites = [
      { id: g.id, type: OverwriteType.Role, deny: bitsOf(['ViewChannel']) },
      { id: member.id, type: OverwriteType.Member, allow: read, deny: noPost },
      { id: gridId, type: OverwriteType.Role, allow: staff },
      { id: adminId, type: OverwriteType.Role, allow: staff },
      { id: client.user.id, type: OverwriteType.Member, allow: bitsOf(PERM_GROUPS.BOT_TEXT) },
    ];
    const channel = await g.channels.create({
      name: `welcome-${slugify(member.user.username)}`.slice(0, 90), type: ChannelType.GuildText,
      parent: parentId || undefined, permissionOverwrites: overwrites, reason: 'IPDC temporary welcome channel',
    });
    await store.set('welcomeChannels', member.id, { channelId: channel.id, createdAt: Date.now() });
    await queue.enqueue('welcome.delete', { channelId: channel.id, userId: member.id }, { delayMs: WELCOME_CHANNEL_TTL_MS, dedupeKey: channel.id });
    await channel.send(buildWelcomePayload(member.id));
    return { channel, reused: false };
  }

  queue.register('welcome.delete', async ({ channelId, userId }) => {
    try { const c = await client.channels.fetch(channelId); await c.delete('IPDC welcome channel expired (10 minutes)'); }
    catch (e) { if (e?.code !== 10003 && e?.status !== 404) throw e; }
    const rec = await store.get('welcomeChannels', userId);
    if (rec?.channelId === channelId) await store.delete('welcomeChannels', userId);
    log.info('temporary welcome channel removed');
  });

  client.on('guildMemberAdd', async (member) => {
    if (member.guild.id !== cfg.discord.guildId || member.user.bot) return;
    try {
      const ipdcId = await ctx.reconciler.getObjectId(KEYS.roleIpdc);
      if (ipdcId && member.roles.cache.has(ipdcId)) return;
      await ensureWelcomeChannel(member);
      await audit.log({ action: 'onboarding.welcome_channel_created', targetId: member.id });
    } catch (e) { log.error('welcome flow failed', e); await audit.log({ action: 'onboarding.welcome_failed', level: 'error', targetId: member.id, details: { error: e.message } }); }
  });

  // ---- #welcome entry panel button ----
  router.button('onb:start', async (i) => {
    const ipdcId = await ctx.reconciler.getObjectId(KEYS.roleIpdc);
    if (ipdcId && i.member.roles.cache.has(ipdcId)) return say(i, { embeds: [okEmbed('You are already an approved IPDC member.', 'Already Verified')] });
    await i.deferReply({ flags: 64 });
    const { channel } = await ensureWelcomeChannel(i.member);
    return i.editReply({ embeds: [okEmbed(`Your private onboarding channel is ready: <#${channel.id}>\nIt is removed automatically after 10 minutes.`, 'Onboarding Started')] });
  });

  // ---- Code of Conduct ----
  router.button('onb:continue', async (i, [uid]) => {
    if (!isOwner(i, uid)) return say(i, 'This onboarding step belongs to another member.');
    const coc = loadCodeOfConduct(cfg);
    if (!coc.configured) {
      await alertCocMissing();
      return say(i, { embeds: [errEmbed('The IPDC Code of Conduct has not been published by the administrators yet. Staff have been notified. Please try again later.', 'Not Available Yet')] });
    }
    await i.update({ components: [] });
    const chunks = chunkVerbatim(coc.text, 4000);
    // The Code of Conduct is posted exactly as supplied, split only at line/paragraph boundaries.
    for (let n = 0; n < chunks.length; n++) {
      const last = n === chunks.length - 1;
      const e = embed({ description: chunks[n], footer: last ? `${BRAND.name} | Code of Conduct` : `${BRAND.name} | Code of Conduct (${n + 1}/${chunks.length})` });
      if (n === 0) e.setTitle('IPDC CODE OF CONDUCT');
      const payload = { embeds: [e] };
      if (last) payload.components = [row(button(`onb:accept:${uid}`, COC_BUTTONS.accept, ButtonStyle.Success), button(`onb:reject:${uid}`, COC_BUTTONS.reject, ButtonStyle.Danger))];
      await i.followUp(payload);
    }
  });

  router.button('onb:accept', async (i, [uid]) => {
    if (!isOwner(i, uid)) return say(i, 'This onboarding step belongs to another member.');
    const coc = loadCodeOfConduct(cfg);
    await state.saveMember(uid, { id: uid, status: (await state.getMember(uid))?.status === 'approved' ? 'approved' : 'applicant', cocAcceptedAt: Date.now(), cocVersion: sha(coc.text).slice(0, 12) });
    await audit.log({ action: 'onboarding.coc_accepted', actorId: uid, details: { cocVersion: sha(coc.text).slice(0, 12) } });
    await i.update({ components: [] });
    await i.followUp({
      embeds: [embed({ title: 'ROLE APPLICATION', description: 'Thank you for accepting the Code of Conduct. Choose how you would like to join IPDC.' })],
      components: [row(button(`app:member:${uid}`, 'APPLY AS MEMBER', ButtonStyle.Primary), button(`app:pm:${uid}`, 'APPLY AS PROJECT MANAGER', ButtonStyle.Secondary))],
    });
  });

  router.button('onb:reject', async (i, [uid]) => {
    if (!isOwner(i, uid)) return say(i, 'This onboarding step belongs to another member.');
    await state.saveMember(uid, { id: uid, status: (await state.getMember(uid))?.status === 'approved' ? 'approved' : 'declined_coc', cocDeclinedAt: Date.now() });
    await audit.log({ action: 'onboarding.coc_declined', actorId: uid });
    await i.update({ components: [] });
    await i.followUp({ embeds: [embed({ title: 'ACCESS NOT GRANTED', description: 'You chose not to accept the Code of Conduct, so member access has not been granted. You can restart verification at any time from the welcome channel.' })] });
  });

  // ---- application flow ----
  async function gate(i, uid) {
    if (!isOwner(i, uid)) { await say(i, 'This application belongs to another member.'); return null; }
    const m = await state.getMember(uid);
    const ipdcId = await ctx.reconciler.getObjectId(KEYS.roleIpdc);
    if (ipdcId && i.member.roles.cache.has(ipdcId)) { await say(i, { embeds: [okEmbed('You are already an approved member. Use a support ticket to request a role or PM change.', 'Already Approved')] }); return null; }
    if (!m?.cocAcceptedAt) { await say(i, { embeds: [errEmbed('Please accept the Code of Conduct first.')] }); return null; }
    const pending = (await store.where('requests', 'userId', uid)).find((r) => r.status === 'pending' && (r.type === 'join' || r.type === 'pm_application'));
    if (pending) { await say(i, { embeds: [errEmbed('You already have an application awaiting review.', 'Application Pending')] }); return null; }
    return m;
  }

  router.button('app:member', async (i, [uid]) => {
    if (!(await gate(i, uid))) return;
    const [teams, pms] = await Promise.all([state.teams(), state.pms()]);
    const offered = teams.filter((t) => pms.some((p) => (p.teamIds || []).includes(t.id)));
    if (!offered.length) return say(i, { embeds: [errEmbed('No team roles are open for applications yet. Please check back soon or contact staff.', 'Not Available Yet')] });
    const menu = new StringSelectMenuBuilder().setCustomId(`app:team:${uid}`).setPlaceholder('Select your team role')
      .addOptions(offered.slice(0, 25).map((t) => ({ label: t.name.slice(0, 100), value: t.id })));
    await say(i, { embeds: [embed({ title: 'STEP 1 OF 3', description: 'Select the team role you want to join.' })], components: [row(menu)] });
  });

  router.select('app:team', async (i, [uid]) => {
    if (!(await gate(i, uid))) return;
    const teamId = i.values[0]; const pms = (await state.pms()).filter((p) => (p.teamIds || []).includes(teamId));
    if (!pms.length) return i.update({ embeds: [errEmbed('No PM currently leads that team role.')], components: [] });
    const menu = new StringSelectMenuBuilder().setCustomId(`app:pmsel:${uid}:${teamId}`).setPlaceholder('Select your Project Manager')
      .addOptions(pms.slice(0, 25).map((p) => ({ label: p.name.slice(0, 100), value: p.id })));
    await i.update({ embeds: [embed({ title: 'STEP 2 OF 3', description: 'Select the Project Manager (project) you want to work under.' })], components: [row(menu)] });
  });

  router.select('app:pmsel', async (i, [uid, teamId]) => {
    if (!(await gate(i, uid))) return;
    const modal = new ModalBuilder().setCustomId(`app:gh:${uid}:${teamId}:${i.values[0]}`).setTitle('GitHub Profile')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('github').setLabel('GitHub profile URL').setPlaceholder('https://github.com/your-username').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
    await i.showModal(modal);
  });

  async function verifyGithub(i, uid, raw) {
    const username = parseGithubUsername(raw);
    if (!username) { await say(i, { embeds: [errEmbed('That does not look like a GitHub profile URL. Example: https://github.com/your-username')] }); return null; }
    let info;
    try { info = await ctx.github.verifyUser(username); } catch (e) {
      log.warn(`GitHub verification failed for "${username}": ${e.status ? `HTTP ${e.status} - ` : ''}${e.message}`);
      await say(i, { embeds: [errEmbed('GitHub could not be reached to verify your profile. Please try again in a few minutes.')] }); return null;
    }
    if (!info) { await say(i, { embeds: [errEmbed(`No GitHub user profile named "${username}" was found.`)] }); return null; }
    const owner = await state.githubOwner(info.login);
    if (owner && owner.userId !== uid) { await say(i, { embeds: [errEmbed('That GitHub account is already linked to another member. Contact staff if this is a mistake.')] }); return null; }
    return { username: info.login, id: info.id };
  }

  router.modal('app:gh', async (i, [uid, teamId, pmId]) => {
    if (!isOwner(i, uid)) return say(i, 'This application belongs to another member.');
    await i.deferReply({ flags: 64 });
    if (!(await gate(i, uid))) return;
    const [team, pm] = await Promise.all([state.getTeam(teamId), state.getPm(pmId)]);
    if (!team || !pm || !(pm.teamIds || []).includes(teamId)) return say(i, { embeds: [errEmbed('That team/PM combination is no longer available. Please start again.')] });
    const gh = await verifyGithub(i, uid, i.fields.getTextInputValue('github'));
    if (!gh) return;
    await ctx.requests.createRequest({ type: 'join', userId: uid, pmId, teamId, github: gh });
    await say(i, { embeds: [okEmbed(`Your application for **${team.name}** under **${pm.name}** was sent to your Project Manager for review. You will be notified by direct message when a decision is made.`, 'Application Submitted')] });
  });

  router.button('app:pm', async (i, [uid]) => {
    if (!(await gate(i, uid))) return;
    const modal = new ModalBuilder().setCustomId(`app:pmapp:${uid}`).setTitle('Project Manager Application')
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pmname').setLabel('Your name (used for your PM category)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(2).setMaxLength(40)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('github').setLabel('GitHub profile URL').setPlaceholder('https://github.com/your-username').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('Project / experience summary (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)),
      );
    await i.showModal(modal);
  });

  router.modal('app:pmapp', async (i, [uid]) => {
    if (!isOwner(i, uid)) return say(i, 'This application belongs to another member.');
    await i.deferReply({ flags: 64 });
    if (!(await gate(i, uid))) return;
    const pmName = i.fields.getTextInputValue('pmname').trim();
    const taken = (await state.pms()).some((p) => p.slug === slugify(pmName));
    if (taken) return say(i, { embeds: [errEmbed('A PM with that name already exists. Please use your own full name.')] });
    const gh = await verifyGithub(i, uid, i.fields.getTextInputValue('github'));
    if (!gh) return;
    await ctx.requests.createRequest({ type: 'pm_application', userId: uid, pmName, github: gh, notes: i.fields.getTextInputValue('notes')?.trim() || undefined });
    await say(i, { embeds: [okEmbed('Your PM application was sent to the IPDC administrators for approval. You will be notified by direct message.', 'Application Submitted')] });
  });

  ctx.onboarding = { ensureWelcomeChannel, loadCodeOfConduct: () => loadCodeOfConduct(cfg) };
}

export function welcomeEntryPayload() {
  const e = embed({
    title: 'MEMBER VERIFICATION',
    description: 'New to IPDC? Start verification to receive a private onboarding channel. There you will review the Code of Conduct and submit your role application.\n\nYour private channel is visible only to you and authorized staff and is removed automatically after 10 minutes.',
  });
  e.setImage(LOGO_URL);
  return {
    embeds: [e],
    components: [row(button('onb:start', 'BEGIN VERIFICATION', ButtonStyle.Primary))],
    files: [logoAttachment()],
  };
}
