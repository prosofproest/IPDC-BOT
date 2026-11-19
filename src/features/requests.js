import { ActionRowBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { newId, fmtIST, truncate } from '../utils/misc.js';
import { KEYS } from '../core/structure.js';
import { makeActor } from '../core/auth.js';
import { say } from '../core/router.js';
import { button, embed, row, errEmbed, okEmbed } from '../ui.js';
import { BRAND } from '../config/constants.js';
import { provisionPmWorkspace } from '../core/workspace.js';
import { getValidActiveTeams } from '../core/dynamicRoles.js';
import { acquireOrderedLocks, isLeaseError } from '../utils/lock.js';

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

  async function removeMemberOverwrite(pmId, teamId, userId, lockSet = null) {
    if (!pmId || !teamId) return;
    await lockSet?.assertAlive();
    const chId = await ctx.reconciler.getObjectId(KEYS.pmTeamText(pmId, teamId));
    if (!chId) return;
    await lockSet?.assertAlive();
    try {
      const ch = await ctx.client.channels.fetch(chId);
      await lockSet?.assertAlive();
      await ch.permissionOverwrites.delete(userId, 'IPDC role change approved');
    } catch (e) {
      if (isLeaseError(e)) throw e;
      log.warn('overwrite removal failed', e);
    }
  }

  // ---- apply approved requests ----
  async function applyApproved(req, lockSet = null) {
    const user = req.userId;
    const existing = (await state.getMember(user)) || {};
    const originalPm = (req.snapshot && req.snapshot.pmId !== undefined) ? req.snapshot.pmId : existing.pmId;
    const originalTeam = (req.snapshot && req.snapshot.teamId !== undefined) ? req.snapshot.teamId : existing.teamId;

    if (req.type === 'join') {
      if (req.github) {
        await lockSet?.assertAlive();
        await state.linkGithub(user, req.github.username, { lock: lockSet }); // re-checks duplicates at approval time
      }
      await lockSet?.assertAlive();
      await state.saveMember(user, { id: user, status: 'approved', role: 'member', pmId: req.pmId, teamId: req.teamId, approvedAt: Date.now() }, { lock: lockSet });
      await lockSet?.assertAlive();
      const r = await ctx.roles.memberRoleKeys({ pmId: req.pmId, teamId: req.teamId }, { lock: lockSet });
      await lockSet?.assertAlive();
      return { add: [r.ipdc, r.team, r.pm], remove: [], reconcileReason: 'member-approved' };
    }
    if (req.type === 'pm_application') {
      let pm = req.pmId ? await state.getPm(req.pmId) : await state.pmByUser(user);
      if (!pm) {
        await lockSet?.assertAlive();
        pm = await state.createPm({ id: req.pmId, name: req.pmName, discordUserId: user }, { lock: lockSet });
      }
      if (req.github) {
        await lockSet?.assertAlive();
        await state.linkGithub(user, req.github.username, { lock: lockSet });
      }
      await lockSet?.assertAlive();
      await state.saveMember(user, { id: user, status: 'approved', role: 'pm', pmId: pm.id, teamId: null, approvedAt: Date.now() }, { lock: lockSet });
      await lockSet?.assertAlive();
      const r = await ctx.roles.memberRoleKeys({ pmId: pm.id }, { lock: lockSet });
      await lockSet?.assertAlive();
      const validTeams = await getValidActiveTeams(ctx);
      const teamRoleIds = [];
      for (const t of validTeams) {
        await lockSet?.assertAlive();
        const trId = t.roleId || (await ctx.reconciler?.getObjectId?.(KEYS.teamRole(t.id))) || (await ctx.roles?.idFor?.(KEYS.teamRole(t.id), { lock: lockSet }));
        if (trId) teamRoleIds.push(trId);
      }
      await lockSet?.assertAlive();
      return { add: [r.ipdc, r.pm, ...teamRoleIds], remove: [], reconcileReason: 'pm-approved' };
    }
    if (req.type === 'team_change') {
      const oldTeam = originalTeam;
      await lockSet?.assertAlive();
      await state.saveMember(user, { teamId: req.newTeamId }, { lock: lockSet });
      await lockSet?.assertAlive();
      if (existing.pmId && oldTeam) {
        await lockSet?.assertAlive();
        await removeMemberOverwrite(existing.pmId, oldTeam, user, lockSet);
      }
      await lockSet?.assertAlive();
      const [oldR, newR] = await Promise.all([oldTeam ? ctx.roles.idFor(KEYS.teamRole(oldTeam), { lock: lockSet }) : null, ctx.roles.idFor(KEYS.teamRole(req.newTeamId), { lock: lockSet })]);
      await lockSet?.assertAlive();
      return { add: [newR], remove: oldR ? [oldR] : [] };
    }
    if (req.type === 'pm_transfer') {
      const oldPm = originalPm;
      const oldTeam = originalTeam;
      await lockSet?.assertAlive();
      await state.saveMember(user, { pmId: req.newPmId, teamId: req.newTeamId }, { lock: lockSet });
      await lockSet?.assertAlive();
      if (oldPm && oldTeam) {
        await lockSet?.assertAlive();
        await removeMemberOverwrite(oldPm, oldTeam, user, lockSet);
      }
      await lockSet?.assertAlive();
      const [oldPmRole, oldTeamRole, nPm, nTeam] = await Promise.all([
        oldPm ? ctx.roles.idFor(KEYS.pmRole(oldPm), { lock: lockSet }) : null, oldTeam ? ctx.roles.idFor(KEYS.teamRole(oldTeam), { lock: lockSet }) : null,
        ctx.roles.idFor(KEYS.pmRole(req.newPmId), { lock: lockSet }), ctx.roles.idFor(KEYS.teamRole(req.newTeamId), { lock: lockSet }),
      ]);
      await lockSet?.assertAlive();
      return { add: [nPm, nTeam], remove: [oldPmRole, oldTeamRole].filter(Boolean) };
    }
    throw new Error('Unknown request type');
  }

  async function finalize(req, decidedBy, status, reason = null, lockSet = null) {
    req.status = status; req.decidedBy = decidedBy; req.decidedAt = Date.now(); if (reason) req.reason = reason;
    await store.set('requests', req.id, req, { lock: lockSet });
    try {
      const ch = await ctx.client.channels.fetch(req.ref.channelId); const m = await ch.messages.fetch(req.ref.messageId);
      await m.edit({ ...(await renderRequest(req, { decided: true })), content: null });
    } catch (e) { log.warn('could not update request message', e); }
  }

  async function approve(i, [id]) {
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    let lockSet = null;
    let reconcileReason = null;
    let approvalSucceeded = false;
    try {
      const initialReq = await store.get('requests', id);
      if (!initialReq) return say(i, { embeds: [errEmbed('That request no longer exists.')] });
      if (initialReq.status !== 'pending') return say(i, { embeds: [errEmbed(`This request was already ${initialReq.status}.`)] });
      const initialPm = initialReq.pmId ? await state.getPm(initialReq.pmId) : null;
      const actor = makeActor(i.member, i.user.id);
      if (!(await auth.can(REQUEST_TYPES[initialReq.type].action, actor, { pm: initialPm }))) {
        await audit.log({ action: 'authz.denied', actorId: i.user.id, level: 'warn', details: { requestId: id, type: initialReq.type } });
        return say(i, { embeds: [errEmbed('You are not authorized to decide this request.')] });
      }

      // Establish ordered locks across member and target resources
      const lockKeys = [`member:${initialReq.userId}`];
      if (initialReq.type === 'pm_application') {
        lockKeys.push('reconcile');
        let pmId = initialReq.pmId;
        if (!pmId) {
          const existingPm = await state.pmByUser(initialReq.userId);
          if (existingPm) {
            pmId = existingPm.id;
          } else {
            pmId = newId();
          }
          initialReq.pmId = pmId;
          await store.merge('requests', initialReq.id, { pmId });
        }
        lockKeys.push(`pm:${pmId}`);
      } else if (initialReq.type === 'join') {
        if (initialReq.pmId) lockKeys.push(`pm:${initialReq.pmId}`);
        if (initialReq.teamId) lockKeys.push(`team:${initialReq.teamId}`);
      } else if (initialReq.type === 'team_change') {
        if (initialReq.pmId) lockKeys.push(`pm:${initialReq.pmId}`);
        if (initialReq.teamId) lockKeys.push(`team:${initialReq.teamId}`);
        if (initialReq.newTeamId) lockKeys.push(`team:${initialReq.newTeamId}`);
      } else if (initialReq.type === 'pm_transfer') {
        if (initialReq.pmId) lockKeys.push(`pm:${initialReq.pmId}`);
        if (initialReq.newPmId) lockKeys.push(`pm:${initialReq.newPmId}`);
        if (initialReq.teamId) lockKeys.push(`team:${initialReq.teamId}`);
        if (initialReq.newTeamId) lockKeys.push(`team:${initialReq.newTeamId}`);
      }

      const lockOwner = `approval:${i.user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
      lockSet = await acquireOrderedLocks(store, lockOwner, lockKeys, { ttlMs: 15_000, renewIntervalMs: 5_000 });
      if (!lockSet) {
        return say(i, { embeds: [errEmbed('Another approval or role operation is in progress for this member. Please try again shortly.')] });
      }

      const req = await store.get('requests', id);
      if (!req || req.status !== 'pending') {
        return say(i, { embeds: [errEmbed(`This request was already ${req?.status || 'handled'}.`)] });
      }
      if (req.userId !== initialReq.userId) {
        return say(i, { embeds: [errEmbed('Request applicant mismatch. Approval aborted.')] });
      }

      const pm = req.pmId ? await state.getPm(req.pmId) : null;
      if (!(await auth.can(REQUEST_TYPES[req.type].action, actor, { pm }))) {
        await audit.log({ action: 'authz.denied', actorId: i.user.id, level: 'warn', details: { requestId: id, type: req.type } });
        return say(i, { embeds: [errEmbed('You are not authorized to decide this request.')] });
      }

      // validate mappings under lock before touching anything
      if (req.type === 'join' || req.type === 'team_change' || req.type === 'pm_transfer') {
        const targetPmId = req.type === 'pm_transfer' ? req.newPmId : req.pmId;
        const targetTeamId = req.type === 'join' ? req.teamId : req.newTeamId;
        const targetPm = await state.getPm(targetPmId);
        const targetTeam = targetTeamId ? await state.getTeam(targetTeamId) : null;
        const validTeams = await getValidActiveTeams(ctx);
        const isValidTeam = validTeams.some((t) => t.id === targetTeamId) || (targetTeam && targetTeam.status === 'active');
        if (!targetPm || targetPm.status === 'removed' || targetPm.status === 'deleting' ||
            !isValidTeam || !targetTeam || targetTeam.status === 'removed' || targetTeam.status === 'deleting' ||
            !(targetPm.teamIds || []).includes(targetTeamId)) {
          return say(i, { embeds: [errEmbed('The requested PM/team mapping is no longer valid. Reject this request or ask the applicant to reapply.')] });
        }
      }

      await lockSet.assertAlive();

      // Persist immutable snapshot before any member state mutation
      if (!req.snapshot) {
        const existingMember = (await state.getMember(req.userId)) || {};
        const snapshot = {
          version: 1,
          capturedAt: Date.now(),
          pmId: existingMember.pmId !== undefined ? existingMember.pmId : null,
          teamId: existingMember.teamId !== undefined ? existingMember.teamId : null,
          status: existingMember.status || 'unassigned',
        };
        await lockSet.assertAlive();
        await store.merge('requests', req.id, { snapshot }, { lock: lockSet });
        req.snapshot = snapshot;
      }

      await lockSet.assertAlive();

      let plan;
      try {
        plan = await applyApproved(req, lockSet);
      } catch (e) {
        log.error('apply failed', e);
        return say(i, { embeds: [errEmbed(`Could not apply this request: ${e.message}`)] });
      }

      await lockSet.assertAlive();

      reconcileReason = plan.reconcileReason || null;
      const add = (plan.add || []).filter(Boolean);
      const remove = (plan.remove || []).filter(Boolean);
      let rolesOk = true;

      try {
        await lockSet.assertAlive();
        await ctx.roles.apply(req.userId, { add, remove }, `IPDC ${req.type} approved by ${i.user.tag}`);
      } catch (e) {
        rolesOk = false;
        await lockSet.assertAlive();
        await queue.enqueue('roles.apply', {
          userId: req.userId,
          add,
          remove,
          requestId: req.id,
          targetPmId: req.type === 'pm_transfer' ? req.newPmId : req.pmId,
          targetTeamId: req.type === 'join' ? req.teamId : req.newTeamId,
        }, { dedupeKey: `roles_${req.id}` });
        try {
          await audit.log({ action: 'roles.apply.queued', level: 'warn', actorId: i.user.id, targetId: req.userId, details: { requestId: id, error: e.message } });
        } catch (auditErr) {
          log.warn('audit log failed on queue role error', auditErr);
        }
      }

      if (req.type === 'pm_application') {
        const pmEntity = (await state.getPm(req.pmId)) || (await state.pmByUser(req.userId));
        if (pmEntity) {
          await lockSet.assertAlive();
          await provisionPmWorkspace(ctx, pmEntity.id, { welcome: true, auditActorId: i.user.id, lockSet });
        }
      }

      await lockSet.assertAlive();
      await finalize(req, i.user.id, 'approved', null, lockSet);
      approvalSucceeded = true;

      await lockSet.assertAlive();

      try {
        await audit.log({ action: `request.approved.${req.type}`, actorId: i.user.id, targetId: req.userId, details: { requestId: id, rolesApplied: rolesOk } });
      } catch (auditErr) {
        log.warn('audit log failed on approval', auditErr);
      }

      try {
        await notifyUser(req.userId, okEmbed(`Your ${REQUEST_TYPES[req.type].label.toLowerCase()} was approved.${rolesOk ? '' : ' Your roles are being applied and will appear shortly.'}`, 'Request Approved'));
      } catch (notifyErr) {
        log.warn('notify user failed on approval', notifyErr);
      }

      return say(i, { embeds: [okEmbed(rolesOk ? 'Approved. Roles and access have been applied.' : 'Approved. Role assignment hit an error and was queued for automatic retry.')] });
    } catch (e) {
      log.error('approval error', e);
      try {
        return await say(i, { embeds: [errEmbed(`Something went wrong while processing approval: ${e.message}`)] });
      } catch { /* interaction expired */ }
    } finally {
      if (lockSet) {
        await lockSet.release();
      }
      if (reconcileReason && approvalSucceeded) {
        ctx.reconciler?.run?.(reconcileReason).catch((e) => log.warn('post-approval reconcile failed', e));
      }
    }
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
    // Collect candidate resource locks before acquiring
    const initialMember = await state.getMember(p.userId);
    const initialPm = await state.pmByUser(p.userId);
    const lockKeys = [
      `member:${p.userId}`,
      initialMember?.pmId && `pm:${initialMember.pmId}`,
      initialMember?.teamId && `team:${initialMember.teamId}`,
      initialPm?.id && `pm:${initialPm.id}`,
      p.targetPmId && `pm:${p.targetPmId}`,
      p.targetTeamId && `team:${p.targetTeamId}`,
    ].filter(Boolean);

    const lockOwner = `queue:${p.userId}:${Date.now()}`;
    const lockSet = await acquireOrderedLocks(store, lockOwner, lockKeys, { ttlMs: 15_000, renewIntervalMs: 5_000 });
    if (!lockSet) {
      throw new Error(`Could not acquire locks for ${p.userId}; retrying later`);
    }
    try {
      await lockSet.assertAlive();
      // 1. Authoritative state lookups under lock
      const member = await state.getMember(p.userId);
      const pm = await state.pmByUser(p.userId);
      let targetRoleIds = [];

      if (pm && pm.status !== 'removed' && pm.status !== 'deleting') {
        const ipdcId = await ctx.roles.idFor(KEYS.roleIpdc, { lock: lockSet });
        const pmRoleId = await ctx.roles.idFor(KEYS.pmRole(pm.id), { lock: lockSet });
        const validTeams = await getValidActiveTeams(ctx);
        const teamRoleIds = [];
        for (const t of validTeams) {
          const trId = t.roleId || (await ctx.reconciler?.getObjectId?.(KEYS.teamRole(t.id))) || (await ctx.roles?.idFor?.(KEYS.teamRole(t.id), { lock: lockSet }));
          if (trId) teamRoleIds.push(trId);
        }
        targetRoleIds = [ipdcId, pmRoleId, ...teamRoleIds].filter(Boolean);
      } else if (member && member.status === 'approved' && member.pmId && member.teamId) {
        const targetPm = await state.getPm(member.pmId);
        const targetTeam = await state.getTeam(member.teamId);
        if (!targetPm || targetPm.status === 'removed' || targetPm.status === 'deleting' ||
            !targetTeam || targetTeam.status === 'removed' || targetTeam.status === 'deleting') {
          targetRoleIds = [];
        } else {
          const ipdcId = await ctx.roles.idFor(KEYS.roleIpdc, { lock: lockSet });
          const pmRoleId = await ctx.roles.idFor(KEYS.pmRole(member.pmId), { lock: lockSet });
          const teamRoleId = await ctx.roles.idFor(KEYS.teamRole(member.teamId), { lock: lockSet });
          targetRoleIds = [ipdcId, pmRoleId, teamRoleId].filter(Boolean);
        }
      } else {
        targetRoleIds = [];
      }

      // 2. Fetch guild member from Discord if guild is available
      const guild = ctx.roles.guild || ctx.client?.guilds?.cache?.get?.(ctx.cfg?.discord?.guildId);
      let discordMember = null;
      let fetchedFromGuild = false;
      if (guild?.members?.fetch) {
        fetchedFromGuild = true;
        discordMember = await guild.members.fetch(p.userId).catch((err) => {
          if (err?.code === 10007 || err?.status === 404) return null;
          throw err;
        });
        if (!discordMember) {
          log.warn(`member ${p.userId} not found in Discord guild during retry; skipping`);
          return;
        }
      }

      // 3. Registered bot-managed roles from registry
      const regRows = await store.list('registry');
      const managedRoleIds = new Set(
        regRows.filter((r) => r.type === 'role').map((r) => r.id).filter(Boolean)
      );

      // 4. Protected system roles (never remove)
      const protectedRoles = new Set([
        ctx.cfg?.roles?.grid,
        ctx.cfg?.roles?.admin,
        '1568690888413282396',
        '1568690393824891141',
      ].filter(Boolean));

      // 5. Compute safe additions and removals
      let toAdd = [];
      let toRemove = [];

      if (fetchedFromGuild && discordMember) {
        const currentRoles = new Set(discordMember.roles?.cache?.keys?.() || []);
        toAdd = targetRoleIds.filter((r) => !currentRoles.has(r) && !protectedRoles.has(r));
        toRemove = [...currentRoles].filter(
          (r) => managedRoleIds.has(r) && !targetRoleIds.includes(r) && !protectedRoles.has(r)
        );
      } else {
        toAdd = targetRoleIds.filter((r) => !protectedRoles.has(r));
        toRemove = [];
      }

      await lockSet.assertAlive();

      if (toAdd.length > 0 || toRemove.length > 0) {
        await ctx.roles.apply(p.userId, { add: toAdd, remove: toRemove }, 'IPDC retry dynamic convergence');
      }

      await lockSet.assertAlive();

      try {
        await audit.log({ action: 'roles.apply.retry_succeeded', targetId: p.userId, details: { requestId: p.requestId } });
      } catch (auditErr) {
        log.warn('audit log failed on roles.apply retry success', auditErr);
      }
    } finally {
      await lockSet.release();
    }
  });

  ctx.requests = { createRequest, notifyUser, renderRequest };
}
