import { ActionRowBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { newId, fmtIST, truncate } from '../utils/misc.js';
import { KEYS } from '../core/structure.js';
import { makeActor } from '../core/auth.js';
import { say } from '../core/router.js';
import { button, embed, row, errEmbed, okEmbed } from '../ui.js';
import { BRAND } from '../config/constants.js';

const log = createLogger('requests');

export const REQUEST_TYPES = {
  join: { label: 'Member Role Application', action: 'application.approve.initial' },
  pm_application: { label: 'PM Application', action: 'application.approve.pm' },
  team_change: { label: 'Team Role Change (same PM)', action: 'teamchange.approve' },
  pm_transfer: { label: 'PM and Team Transfer', action: 'transfer.approve' },
};

export function register(router, ctx) {
  const { store, state, auth, audit, queue } = ctx;

  async function destinationKey(req) {
    if (req.type === 'join' || req.type === 'team_change') return KEYS.pmControl(req.pmId);
    return 'ch:admin-approvals';
  }

  async function renderRequest(req, { decided = false } = {}) {
    const [pm, team, newPm, newTeam] = await Promise.all([
      req.pmId ? state.getPm(req.pmId) : null, req.teamId ? state.getTeam(req.teamId) : null,
      req.newPmId ? state.getPm(req.newPmId) : null, req.newTeamId ? state.getTeam(req.newTeamId) : null,
    ]);
    const fields = [{ name: 'Applicant', value: `<@${req.userId}>`, inline: true }, { name: 'Type', value: REQUEST_TYPES[req.type].label, inline: true }];
    if (req.type === 'join') fields.push({ name: 'Requested Team Role', value: team?.name || 'n/a', inline: true }, { name: 'PM', value: pm?.name || 'n/a', inline: true });
    if (req.type === 'team_change') fields.push({ name: 'PM', value: pm?.name || 'n/a', inline: true }, { name: 'Current Team Role', value: team?.name || 'n/a', inline: true }, { name: 'Requested Team Role', value: newTeam?.name || 'n/a', inline: true });
    if (req.type === 'pm_transfer') fields.push({ name: 'Current', value: `${pm?.name || 'n/a'} / ${team?.name || 'n/a'}`, inline: true }, { name: 'Requested', value: `${newPm?.name || 'n/a'} / ${newTeam?.name || 'n/a'}`, inline: true });
    if (req.type === 'pm_application') fields.push({ name: 'Requested PM Name', value: req.pmName || 'n/a', inline: true });
    if (req.github) fields.push({ name: 'GitHub', value: `[${req.github.username}](https://github.com/${req.github.username})`, inline: true });
    if (req.notes) fields.push({ name: 'Notes', value: truncate(req.notes, 500) });
    fields.push({ name: 'Submitted', value: fmtIST(req.createdAt), inline: true });
    const color = req.status === 'approved' ? BRAND.accent : req.status === 'rejected' ? 0xcf222e : BRAND.color;
    const e = embed({ title: `${REQUEST_TYPES[req.type].label} — ${req.status.toUpperCase()}`, color, fields, footer: `Request ${req.id}` });
    if (decided) e.addFields({ name: 'Decision', value: `${req.status} by <@${req.decidedBy}> on ${fmtIST(req.decidedAt)}${req.reason ? `\nReason: ${truncate(req.reason, 300)}` : ''}` });
    const components = decided ? [] : [row(button(`req:approve:${req.id}`, 'APPROVE', ButtonStyle.Success), button(`req:reject:${req.id}`, 'REJECT', ButtonStyle.Danger))];
    return { embeds: [e], components };
  }

  /** Create and post a request. Returns the request. */
  async function createRequest(data) {
    const req = { id: newId(), status: 'pending', createdAt: Date.now(), ...data };
    const key = await destinationKey(req);
    const channel = await ctx.messages.channelFor(key);
    if (!channel) throw new Error('The approval channel is not available yet. Please ask staff to run structure repair.');
    const pm = req.pmId ? await state.getPm(req.pmId) : null;
    const mention = req.type === 'join' || req.type === 'team_change' ? (pm ? `<@${pm.discordUserId}>` : '') : `<@&${ctx.cfg.roles.admin}> <@&${ctx.cfg.roles.grid}>`;
    const payload = await renderRequest(req);
    const msg = await channel.send({ content: mention || undefined, ...payload, allowedMentions: { users: pm ? [pm.discordUserId] : [], roles: mention.includes('&') ? [ctx.cfg.roles.admin, ctx.cfg.roles.grid] : [] } });
    req.ref = { channelId: channel.id, messageId: msg.id };
    await store.set('requests', req.id, req);
    await audit.log({ action: `request.created.${req.type}`, actorId: req.userId, details: { requestId: req.id } });
    return req;
  }

  async function notifyUser(userId, e) {
    try { const u = await ctx.client.users.fetch(userId); await u.send({ embeds: [e] }); return true; } catch { return false; }
  }

  async function removeMemberOverwrite(pmId, teamId, userId) {
    if (!pmId || !teamId) return;
    const chId = await ctx.reconciler.getObjectId(KEYS.pmTeamText(pmId, teamId));
    if (!chId) return;
    try { const ch = await ctx.client.channels.fetch(chId); await ch.permissionOverwrites.delete(userId, 'IPDC role change approved'); } catch (e) { log.warn('overwrite removal failed', e); }
  }

  // ---- apply approved requests ----
  async function applyApproved(req) {
    const user = req.userId;
    const existing = (await state.getMember(user)) || {};
    if (req.type === 'join') {
      if (req.github) await state.linkGithub(user, req.github.username); // re-checks duplicates at approval time
      await state.saveMember(user, { id: user, status: 'approved', role: 'member', pmId: req.pmId, teamId: req.teamId, approvedAt: Date.now() });
      await ctx.reconciler.run('member-approved');
      const r = await ctx.roles.memberRoleKeys({ pmId: req.pmId, teamId: req.teamId });
      return { add: [r.ipdc, r.team, r.pm], remove: [] };
    }
    if (req.type === 'pm_application') {
      let pm = await state.pmByUser(user);
      if (!pm) pm = await state.createPm({ name: req.pmName, discordUserId: user });
      if (req.github) await state.linkGithub(user, req.github.username);
      await state.saveMember(user, { id: user, status: 'approved', role: 'pm', pmId: pm.id, teamId: null, approvedAt: Date.now() });
      await ctx.reconciler.run('pm-approved');
      const r = await ctx.roles.memberRoleKeys({ pmId: pm.id });
      return { add: [r.ipdc, r.pm], remove: [] };
    }
    if (req.type === 'team_change') {
      const oldTeam = existing.teamId;
      await state.saveMember(user, { teamId: req.newTeamId });
      await removeMemberOverwrite(existing.pmId, oldTeam, user);
      await ctx.reconciler.run('team-change');
      const [oldR, newR] = await Promise.all([oldTeam ? ctx.roles.idFor(KEYS.teamRole(oldTeam)) : null, ctx.roles.idFor(KEYS.teamRole(req.newTeamId))]);
      return { add: [newR], remove: oldR ? [oldR] : [] };
    }
    if (req.type === 'pm_transfer') {
      const { pmId: oldPm, teamId: oldTeam } = existing;
      await state.saveMember(user, { pmId: req.newPmId, teamId: req.newTeamId });
      await removeMemberOverwrite(oldPm, oldTeam, user);
      await ctx.reconciler.run('pm-transfer');
      const [oldPmRole, oldTeamRole, nPm, nTeam] = await Promise.all([
        oldPm ? ctx.roles.idFor(KEYS.pmRole(oldPm)) : null, oldTeam ? ctx.roles.idFor(KEYS.teamRole(oldTeam)) : null,
        ctx.roles.idFor(KEYS.pmRole(req.newPmId)), ctx.roles.idFor(KEYS.teamRole(req.newTeamId)),
      ]);
      return { add: [nPm, nTeam], remove: [oldPmRole, oldTeamRole].filter(Boolean) };
    }
    throw new Error('Unknown request type');
  }

  async function finalize(req, decidedBy, status, reason) {
    req.status = status; req.decidedBy = decidedBy; req.decidedAt = Date.now(); if (reason) req.reason = reason;
    await store.set('requests', req.id, req);
    try {
      const ch = await ctx.client.channels.fetch(req.ref.channelId); const m = await ch.messages.fetch(req.ref.messageId);
      await m.edit({ ...(await renderRequest(req, { decided: true })), content: null });
    } catch (e) { log.warn('could not update request message', e); }
  }

  async function approve(i, [id]) {
    const req = await store.get('requests', id);
    if (!req) return say(i, { embeds: [errEmbed('That request no longer exists.')] });
    if (req.status !== 'pending') return say(i, { embeds: [errEmbed(`This request was already ${req.status}.`)] });
    const pm = req.pmId ? await state.getPm(req.pmId) : null;
    const actor = makeActor(i.member, i.user.id);
    if (!(await auth.can(REQUEST_TYPES[req.type].action, actor, { pm }))) {
      await audit.log({ action: 'authz.denied', actorId: i.user.id, level: 'warn', details: { requestId: id, type: req.type } });
      return say(i, { embeds: [errEmbed('You are not authorized to decide this request.')] });
    }
    await i.deferReply({ flags: 64 });
    // validate mappings before touching anything
    if (req.type === 'join' || req.type === 'team_change' || req.type === 'pm_transfer') {
      const targetPm = await state.getPm(req.type === 'pm_transfer' ? req.newPmId : req.pmId);
      const targetTeam = req.type === 'join' ? req.teamId : req.newTeamId;
      if (!targetPm || targetPm.status === 'removed' || !(targetPm.teamIds || []).includes(targetTeam)) {
        return i.editReply({ embeds: [errEmbed('The requested PM/team mapping is no longer valid. Reject this request or ask the applicant to reapply.')] });
      }
    }
    let plan;
    try { plan = await applyApproved(req); } catch (e) {
      log.error('apply failed', e);
      return i.editReply({ embeds: [errEmbed(`Could not apply this request: ${e.message}`)] });
    }
    const add = plan.add.filter(Boolean); const remove = plan.remove.filter(Boolean);
    let rolesOk = true;
    try { await ctx.roles.apply(req.userId, { add, remove }, `IPDC ${req.type} approved by ${i.user.tag}`); } catch (e) {
      rolesOk = false;
      await queue.enqueue('roles.apply', { userId: req.userId, add, remove, requestId: req.id });
      await audit.log({ action: 'roles.apply.queued', level: 'warn', actorId: i.user.id, targetId: req.userId, details: { requestId: id, error: e.message } });
    }
    await finalize(req, i.user.id, 'approved');
    await audit.log({ action: `request.approved.${req.type}`, actorId: i.user.id, targetId: req.userId, details: { requestId: id, rolesApplied: rolesOk } });
    await notifyUser(req.userId, okEmbed(`Your ${REQUEST_TYPES[req.type].label.toLowerCase()} was approved.${rolesOk ? '' : ' Your roles are being applied and will appear shortly.'}`, 'Request Approved'));
    return i.editReply({ embeds: [okEmbed(rolesOk ? 'Approved. Roles and access have been applied.' : 'Approved. Role assignment hit an error and was queued for automatic retry.')] });
  }

  async function rejectStart(i, [id]) {
    const req = await store.get('requests', id);
    if (!req || req.status !== 'pending') return say(i, { embeds: [errEmbed('This request is no longer pending.')] });
    const pm = req.pmId ? await state.getPm(req.pmId) : null;
    if (!(await auth.can(REQUEST_TYPES[req.type].action, makeActor(i.member, i.user.id), { pm }))) {
      await audit.log({ action: 'authz.denied', actorId: i.user.id, level: 'warn', details: { requestId: id } });
      return say(i, { embeds: [errEmbed('You are not authorized to decide this request.')] });
    }
    const modal = new ModalBuilder().setCustomId(`req:rejectm:${id}`).setTitle('Reject Request')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300)));
    return i.showModal(modal);
  }

  async function rejectSubmit(i, [id]) {
    const req = await store.get('requests', id);
    if (!req || req.status !== 'pending') return say(i, { embeds: [errEmbed('This request is no longer pending.')] });
    const pm = req.pmId ? await state.getPm(req.pmId) : null;
    if (!(await auth.can(REQUEST_TYPES[req.type].action, makeActor(i.member, i.user.id), { pm }))) return say(i, { embeds: [errEmbed('You are not authorized to decide this request.')] });
    const reason = i.fields.getTextInputValue('reason')?.trim();
    await finalize(req, i.user.id, 'rejected', reason);
    await audit.log({ action: `request.rejected.${req.type}`, actorId: i.user.id, targetId: req.userId, details: { requestId: id, reason } });
    await notifyUser(req.userId, embed({ title: 'Request Update', description: `Your ${REQUEST_TYPES[req.type].label.toLowerCase()} was not approved.${reason ? `\nReason: ${reason}` : ''}`, color: 0xcf222e }));
    return say(i, { embeds: [okEmbed('Request rejected and the applicant was notified.')] });
  }

  router.button('req:approve', approve);
  router.button('req:reject', rejectStart);
  router.modal('req:rejectm', rejectSubmit);

  queue.register('roles.apply', async (p) => {
    await ctx.roles.apply(p.userId, { add: p.add, remove: p.remove }, 'IPDC retry');
    await audit.log({ action: 'roles.apply.retry_succeeded', targetId: p.userId, details: { requestId: p.requestId } });
  });

  ctx.requests = { createRequest, notifyUser, renderRequest };
}
