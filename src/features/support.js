import { ActionRowBuilder, AttachmentBuilder, ButtonStyle, ChannelType, ModalBuilder, OverwriteType, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { fmtIST, slugify, truncate } from '../utils/misc.js';
import { bitsOf, KEYS, PERM_GROUPS } from '../core/structure.js';
import { makeActor } from '../core/auth.js';
import { say } from '../core/router.js';
import { button, embed, errEmbed, okEmbed, row } from '../ui.js';

const log = createLogger('support');
const MAX_OPEN_PER_USER = 3;
const ROLE_CAT = /role|team/i;

export function supportPanelPayload(categories) {
  const menu = new StringSelectMenuBuilder().setCustomId('tkt:new').setPlaceholder('Select a support category')
    .addOptions(categories.slice(0, 25).map((c, idx) => ({ label: c.slice(0, 100), value: String(idx) })));
  return {
    embeds: [embed({ title: 'SUPPORT CENTER', description: 'Choose the category that best matches your request. A private ticket channel is created that only you, the IPDC support staff and the bot can see.\n\nRole, team and PM change requests are handled through the Role/Team Issues category.' })],
    components: [row(menu)],
  };
}

export function register(router, ctx) {
  const { state, store, auth, audit, client, cfg } = ctx;
  const guild = () => client.guilds.cache.get(cfg.discord.guildId);
  const pad = (n) => String(n).padStart(3, '0');

  const ticketOf = async (id) => store.get('tickets', id);
  const isStaff = async (i) => auth.isStaff(makeActor(i.member, i.user.id));

  function controlRow(t) {
    if (t.status === 'closed') return [row(button(`tkt:reopen:${t.id}`, 'REOPEN TICKET', ButtonStyle.Success), button(`tkt:export:${t.id}`, 'EXPORT TRANSCRIPT'))];
    const rows = [row(
      button(`tkt:claim:${t.id}`, 'CLAIM TICKET', ButtonStyle.Primary, !!t.claimedBy), button(`tkt:add:${t.id}`, 'ADD MEMBER'),
      button(`tkt:voice:${t.id}`, t.voice ? 'END VOICE SUPPORT' : 'ENABLE VOICE SUPPORT'),
      button(`tkt:export:${t.id}`, 'EXPORT TRANSCRIPT'), button(`tkt:close:${t.id}`, 'CLOSE TICKET', ButtonStyle.Danger))];
    if (ROLE_CAT.test(t.category)) rows.push(row(button(`tkt:teamchg:${t.id}`, 'REQUEST TEAM ROLE CHANGE'), button(`tkt:pmchg:${t.id}`, 'REQUEST PM AND TEAM CHANGE')));
    return rows;
  }
  const ticketEmbed = (t) => embed({
    title: `TICKET ${pad(t.number)} — ${t.category}`, color: t.status === 'closed' ? 0x6e7681 : undefined,
    description: truncate(`**${t.subject}**\n\n${t.details || ''}`, 3500),
    fields: [{ name: 'Opened by', value: `<@${t.openerId}>`, inline: true }, { name: 'Status', value: t.status === 'closed' ? 'Closed' : t.claimedBy ? `Claimed by <@${t.claimedBy}>` : 'Open — awaiting staff', inline: true }, { name: 'Opened', value: fmtIST(t.createdAt), inline: true }],
  });
  async function refreshTicketMessage(t) {
    try {
      const ch = await client.channels.fetch(t.channelId); const m = await ch.messages.fetch(t.controlMessageId);
      await m.edit({ embeds: [ticketEmbed(t)], components: controlRow(t) });
    } catch (e) { log.warn('ticket message refresh failed', e); }
  }
  async function staffRoleIds() { return [cfg.roles.grid, cfg.roles.admin, ...((await state.settings()).supportRoleIds || [])]; }

  // ---- open ----
  router.select('tkt:new', async (i) => {
    if (!(await auth.can('ticket.create', makeActor(i.member, i.user.id)))) return say(i, { embeds: [errEmbed('Support tickets are available to approved IPDC members.')] });
    const open = (await store.where('tickets', 'openerId', i.user.id)).filter((t) => t.status !== 'closed');
    if (open.length >= MAX_OPEN_PER_USER) return say(i, { embeds: [errEmbed(`You already have ${open.length} open tickets. Please close one first.`)] });
    const cats = (await state.settings()).supportCategories; const cat = cats[Number(i.values[0])];
    if (!cat) return say(i, { embeds: [errEmbed('That category is no longer available.')] });
    const m = new ModalBuilder().setCustomId(`tkt:open:${i.values[0]}`).setTitle(truncate(cat, 40)).addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Subject').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Details').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)));
    await i.showModal(m);
  });

  router.modal('tkt:open', async (i, [idx]) => {
    await i.deferReply({ flags: 64 });
    const cats = (await state.settings()).supportCategories; const category = cats[Number(idx)];
    if (!category) return say(i, { embeds: [errEmbed('That category is no longer available.')] });
    const parentId = await ctx.reconciler.getObjectId('cat:tickets');
    const number = await store.nextSeq('ticket'); const id = pad(number);
    const staffBits = bitsOf(PERM_GROUPS.STAFF);
    const overwrites = [
      { id: guild().id, type: OverwriteType.Role, deny: bitsOf(['ViewChannel']) },
      { id: i.user.id, type: OverwriteType.Member, allow: bitsOf(PERM_GROUPS.CHAT) },
      ...(await staffRoleIds()).map((rid) => ({ id: rid, type: OverwriteType.Role, allow: staffBits })),
      { id: client.user.id, type: OverwriteType.Member, allow: bitsOf(PERM_GROUPS.BOT_TEXT) },
    ];
    const channel = await guild().channels.create({ name: `ticket-${id}-${slugify(i.user.username)}`.slice(0, 90), type: ChannelType.GuildText, parent: parentId || undefined, permissionOverwrites: overwrites, topic: `${category} — opened by ${i.user.username}`, reason: `IPDC ticket ${id}` });
    const t = { id, number, channelId: channel.id, openerId: i.user.id, category, subject: i.fields.getTextInputValue('subject').trim(), details: i.fields.getTextInputValue('details').trim(), status: 'open', claimedBy: null, voice: false, createdAt: Date.now(), added: [] };
    const msg = await channel.send({ content: `<@${i.user.id}>`, embeds: [ticketEmbed(t)], components: controlRow(t), allowedMentions: { users: [i.user.id] } });
    t.controlMessageId = msg.id;
    await store.set('tickets', id, t);
    await audit.log({ action: 'ticket.created', actorId: i.user.id, details: { ticket: id, category } });
    await say(i, { embeds: [okEmbed(`Your ticket is ready: <#${channel.id}>`, 'Ticket Created')] });
  });

  const withTicket = (fn, { staffOnly = false, openerOrStaff = false, openerOnly = false } = {}) => async (i, [id, ...rest]) => {
    const t = await ticketOf(id);
    if (!t) return say(i, { embeds: [errEmbed('Ticket not found.')] });
    const staff = await isStaff(i); const opener = i.user.id === t.openerId;
    const allowed = staffOnly ? staff : openerOnly ? opener : openerOrStaff ? (staff || opener) : true;
    if (!allowed) { await audit.log({ action: 'authz.denied', actorId: i.user.id, level: 'warn', details: { ticket: id, control: i.customId.split(':')[1] } }); return say(i, { embeds: [errEmbed('You are not authorized to use this ticket control.', 'Not Authorized')] }); }
    return fn(i, t, rest, { staff, opener });
  };

  router.button('tkt:claim', withTicket(async (i, t) => {
    if (t.claimedBy) return say(i, { embeds: [errEmbed(`Already claimed by <@${t.claimedBy}>.`)] });
    t.claimedBy = i.user.id; await store.merge('tickets', t.id, { claimedBy: t.claimedBy });
    await audit.log({ action: 'ticket.claimed', actorId: i.user.id, details: { ticket: t.id } });
    await i.update({ embeds: [ticketEmbed(t)], components: controlRow(t) });
    await i.channel.send({ content: `<@${i.user.id}> has claimed this ticket.`, allowedMentions: { parse: [] } });
  }, { staffOnly: true }));

  router.button('tkt:add', withTicket(async (i, t) => {
    await say(i, { content: 'Select the member to add to this ticket.', components: [row(new UserSelectMenuBuilder().setCustomId(`tkt:addsel:${t.id}`).setPlaceholder('Select member'))] });
  }, { staffOnly: true }));
  router.select('tkt:addsel', withTicket(async (i, t) => {
    const uid = i.values[0]; const ch = await client.channels.fetch(t.channelId);
    await ch.permissionOverwrites.edit(uid, { ViewChannel: true, ReadMessageHistory: true, SendMessages: true, AttachFiles: true }, { type: OverwriteType.Member, reason: `Added to ticket ${t.id} by ${i.user.tag}` });
    t.added = [...new Set([...(t.added || []), uid])]; await store.merge('tickets', t.id, { added: t.added });
    await audit.log({ action: 'ticket.member_added', actorId: i.user.id, targetId: uid, details: { ticket: t.id } });
    await i.update({ content: `Added <@${uid}>.`, components: [] });
    await ch.send({ content: `<@${uid}> was added to this ticket by <@${i.user.id}>.`, allowedMentions: { users: [uid] } });
  }, { staffOnly: true }));

  async function buildTranscript(t) {
    const ch = await client.channels.fetch(t.channelId); const lines = []; let before;
    for (let n = 0; n < 50; n++) {
      const batch = await ch.messages.fetch({ limit: 100, before }); if (!batch.size) break;
      for (const m of batch.values()) {
        const body = [m.content, ...m.embeds.filter((e) => !e.footer?.text?.startsWith('ref:')).map((e) => `[embed] ${e.title || ''} ${e.description || ''}`.trim()), ...m.attachments.map((a) => `[attachment] ${a.url}`)].filter(Boolean).join(' ');
        lines.push(`[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${body}`);
      }
      before = batch.last().id;
    }
    return `IPDC Support Transcript — Ticket ${pad(t.number)} (${t.category})\nSubject: ${t.subject}\nOpened by: ${t.openerId}\nExported: ${new Date().toISOString()}\n${'-'.repeat(60)}\n${lines.reverse().join('\n')}\n`;
  }
  async function saveTranscript(t) {
    const text = await buildTranscript(t);
    await store.set('transcripts', t.id, { ticket: t.id, savedAt: Date.now(), text: text.slice(0, 900_000), truncated: text.length > 900_000 });
    return text;
  }

  router.button('tkt:export', withTicket(async (i, t) => {
    await i.deferReply({ flags: 64 });
    const text = await saveTranscript(t);
    await audit.log({ action: 'ticket.transcript_exported', actorId: i.user.id, details: { ticket: t.id } });
    await i.editReply({ content: 'Transcript attached.', files: [new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `ticket-${pad(t.number)}-transcript.txt` })] });
  }, { openerOrStaff: true }));

  router.button('tkt:close', withTicket(async (i, t) => {
    await i.deferReply({ flags: 64 });
    const ch = await client.channels.fetch(t.channelId);
    const text = await saveTranscript(t);
    t.status = 'closed'; t.closedAt = Date.now(); t.closedBy = i.user.id;
    await store.merge('tickets', t.id, { status: 'closed', closedAt: t.closedAt, closedBy: t.closedBy, voice: false });
    await ch.permissionOverwrites.edit(t.openerId, { SendMessages: false, AttachFiles: false }, { type: OverwriteType.Member, reason: `Ticket ${t.id} closed` });
    await revokeVoice(t);
    await ch.setName(`closed-${ch.name.replace(/^closed-/, '')}`.slice(0, 100)).catch((e) => log.warn('rename failed', e));
    await refreshTicketMessage(t);
    const file = () => new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `ticket-${pad(t.number)}-transcript.txt` });
    await ch.send({ content: `Ticket closed by <@${i.user.id}>. Transcript saved.`, files: [file()], allowedMentions: { parse: [] } });
    const auditCh = await ctx.messages.channelFor('ch:admin-audit-logs');
    await auditCh?.send({ content: `Transcript for ticket ${pad(t.number)} (${t.category})`, files: [file()] }).catch((e) => log.warn('audit transcript post failed', e));
    await audit.log({ action: 'ticket.closed', actorId: i.user.id, details: { ticket: t.id } });
    await i.editReply({ embeds: [okEmbed('Ticket closed and transcript saved.')] });
  }, { openerOrStaff: true }));

  router.button('tkt:reopen', withTicket(async (i, t) => {
    await i.deferReply({ flags: 64 });
    const ch = await client.channels.fetch(t.channelId);
    t.status = 'open'; await store.merge('tickets', t.id, { status: 'open', reopenedAt: Date.now() });
    await ch.permissionOverwrites.edit(t.openerId, { SendMessages: true, AttachFiles: true }, { type: OverwriteType.Member, reason: `Ticket ${t.id} reopened` });
    await ch.setName(ch.name.replace(/^closed-/, '')).catch(() => {});
    await refreshTicketMessage(t);
    await ch.send({ content: `Ticket reopened by <@${i.user.id}>.`, allowedMentions: { parse: [] } });
    await audit.log({ action: 'ticket.reopened', actorId: i.user.id, details: { ticket: t.id } });
    await i.editReply({ embeds: [okEmbed('Ticket reopened.')] });
  }, { openerOrStaff: true }));

  // ---- support voice: opener gets temporary access when staff enable it ----
  async function revokeVoice(t) {
    const id = await ctx.reconciler.getObjectId('vc:support-voice'); if (!id || !t.voice) return;
    try { const vc = await client.channels.fetch(id); await vc.permissionOverwrites.delete(t.openerId, `Ticket ${t.id} voice ended`); } catch (e) { log.warn('voice revoke failed', e); }
  }
  router.button('tkt:voice', withTicket(async (i, t) => {
    await i.deferUpdate();
    const id = await ctx.reconciler.getObjectId('vc:support-voice');
    const vc = id ? await client.channels.fetch(id).catch(() => null) : null;
    if (!vc) return i.followUp({ embeds: [errEmbed('Support Voice channel is not available.')], flags: 64 });
    if (t.voice) { await revokeVoice(t); t.voice = false; } else {
      await vc.permissionOverwrites.edit(t.openerId, { ViewChannel: true, Connect: true, Speak: true }, { type: OverwriteType.Member, reason: `Ticket ${t.id} voice enabled` });
      t.voice = true;
    }
    await store.merge('tickets', t.id, { voice: t.voice });
    await audit.log({ action: t.voice ? 'ticket.voice_enabled' : 'ticket.voice_ended', actorId: i.user.id, details: { ticket: t.id } });
    await refreshTicketMessage(t);
    await i.channel.send({ content: t.voice ? `Voice support enabled: <#${vc.id}>. <@${t.openerId}> can now join.` : 'Voice support ended.', allowedMentions: { users: [t.openerId] } });
  }, { staffOnly: true }));

  // ---- role / team change requests (routed to PM or Admin approvals) ----
  async function activeMember(i, t) {
    const m = await state.getMember(i.user.id);
    if (!m || m.status !== 'approved' || !m.pmId || m.role === 'pm') { await say(i, { embeds: [errEmbed('Only approved team members can request a role or PM change.')] }); return null; }
    const pending = (await store.where('requests', 'userId', i.user.id)).find((r) => r.status === 'pending' && (r.type === 'team_change' || r.type === 'pm_transfer'));
    if (pending) { await say(i, { embeds: [errEmbed('You already have a role change request awaiting a decision.')] }); return null; }
    return m;
  }

  router.button('tkt:teamchg', withTicket(async (i, t) => {
    const m = await activeMember(i, t); if (!m) return;
    const pm = await state.getPm(m.pmId); const teams = (await state.teams()).filter((x) => (pm.teamIds || []).includes(x.id) && x.id !== m.teamId);
    if (!teams.length) return say(i, { embeds: [errEmbed('Your PM has no other team roles available.')] });
    await say(i, { content: `Select the new team role under **${pm.name}**. Your current role stays active until your PM approves.`, components: [row(new StringSelectMenuBuilder().setCustomId(`tkt:teamsel:${t.id}`).setPlaceholder('New team role').addOptions(teams.slice(0, 25).map((x) => ({ label: x.name.slice(0, 100), value: x.id }))))] });
  }, { openerOnly: true }));
  router.select('tkt:teamsel', withTicket(async (i, t) => {
    const m = await activeMember(i, t); if (!m) return;
    await ctx.requests.createRequest({ type: 'team_change', userId: i.user.id, pmId: m.pmId, teamId: m.teamId, newTeamId: i.values[0], ticketId: t.id });
    await i.update({ content: null, embeds: [okEmbed('Your request was sent to your Project Manager. You will be notified when it is decided.', 'Request Submitted')], components: [] });
  }, { openerOnly: true }));

  router.button('tkt:pmchg', withTicket(async (i, t) => {
    const m = await activeMember(i, t); if (!m) return;
    const pms = (await state.pms()).filter((p) => p.id !== m.pmId && (p.teamIds || []).length);
    if (!pms.length) return say(i, { embeds: [errEmbed('There are no other PM teams available right now.')] });
    await say(i, { content: 'Select the new PM. Your current PM and team stay active until the administrators approve.', components: [row(new StringSelectMenuBuilder().setCustomId(`tkt:pmsel:${t.id}`).setPlaceholder('New PM').addOptions(pms.slice(0, 25).map((p) => ({ label: p.name.slice(0, 100), value: p.id }))))] });
  }, { openerOnly: true }));
  router.select('tkt:pmsel', withTicket(async (i, t) => {
    const pm = await state.getPm(i.values[0]); const teams = (await state.teams()).filter((x) => (pm?.teamIds || []).includes(x.id));
    if (!teams.length) return i.update({ content: 'That PM has no team roles available.', components: [] });
    await i.update({ content: `Select the team role under **${pm.name}**.`, components: [row(new StringSelectMenuBuilder().setCustomId(`tkt:pmteam:${t.id}:${pm.id}`).setPlaceholder('New team role').addOptions(teams.slice(0, 25).map((x) => ({ label: x.name.slice(0, 100), value: x.id }))))] });
  }, { openerOnly: true }));
  router.select('tkt:pmteam', withTicket(async (i, t, [newPmId]) => {
    const m = await activeMember(i, t); if (!m) return;
    await ctx.requests.createRequest({ type: 'pm_transfer', userId: i.user.id, pmId: m.pmId, teamId: m.teamId, newPmId, newTeamId: i.values[0], ticketId: t.id });
    await i.update({ content: null, embeds: [okEmbed('Your transfer request was sent to the IPDC administrators. You will be notified when it is decided.', 'Request Submitted')], components: [] });
  }, { openerOnly: true }));
}
