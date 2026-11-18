import { ActionRowBuilder, ButtonStyle, ChannelType, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { fmtIST, newId, parseGithubUsername, slugify, truncate } from '../utils/misc.js';
import { KEYS } from '../core/structure.js';
import { makeActor } from '../core/auth.js';
import { say } from '../core/router.js';
import { button, embed, errEmbed, okEmbed, row } from '../ui.js';
import { provisionPmWorkspace, auditPmPermissions } from '../core/workspace.js';

const log = createLogger('admin');

const GRANTS = [
  ['repo.change', 'Change PM monitored repository'],
  ['admin.panel', 'Use the Admin Panel'],
  ['monitoring.view', 'View server-wide monitoring'],
  ['config.manage', 'Manage PM / team configuration'],
  ['resource.manage', 'Manage resource forums'],
  ['challenge.manage', 'Manage challenges'],
  ['application.approve.initial', 'Approve initial team applications'],
  ['teamchange.approve', 'Approve same-PM team changes'],
  ['pm.channels.view', 'View PM team channels and voice'],
];

const input = (id, label, o = {}) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label)
  .setStyle(o.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(o.required ?? true).setMaxLength(o.max ?? 100).setPlaceholder(o.ph ?? '').setValue(o.value ?? ''));
const modal = (id, title, ...rows) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...rows);
const menu = (id, ph, options, o = {}) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(ph).setMinValues(o.min ?? 1).setMaxValues(o.max ?? 1).addOptions(options.slice(0, 25));

export function adminPanelPayload() {
  const b = (id, label, style = ButtonStyle.Secondary) => button(id, label, style);
  return {
    embeds: [embed({
      title: 'IPDC ADMIN PANEL',
      description: 'Server administration for the IPDC GRID role. Every action is authorized server-side and recorded in the audit log.\n\nUse the buttons below. Responses are private to you.',
    })],
    components: [
      row(b('adm:dash', 'DASHBOARD', ButtonStyle.Primary), b('adm:pm', 'PM MANAGEMENT'), b('adm:team', 'TEAM ROLES'), b('adm:map', 'ROLE-TO-PM MAPPING'), b('adm:appr', 'APPLICATIONS')),
      row(b('adm:res', 'RESOURCES'), b('adm:tix', 'SUPPORT TICKETS'), b('adm:perm', 'PERMISSIONS'), b('adm:audit', 'AUDIT LOGS'), b('adm:set', 'SERVER SETTINGS')),
      row(b('adm:chal', 'CHALLENGES'), b('adm:gh', 'GITHUB LINK OVERRIDE'), b('adm:repair', 'REPAIR STRUCTURE', ButtonStyle.Success), b('adm:clean', 'CLEANUP (DESTRUCTIVE)', ButtonStyle.Danger)),
    ],
  };
}

export function register(router, ctx) {
  const { store, state, auth, audit, reconciler, managed, client, cfg } = ctx;

  async function gate(i) {
    if (await auth.can('admin.panel', makeActor(i.member, i.user.id))) return true;
    await audit.log({ action: 'authz.denied', actorId: i.user.id, level: 'warn', details: { area: 'admin.panel', custom: i.customId } });
    await say(i, { embeds: [errEmbed('The Admin Panel is restricted to the IPDC GRID role.', 'Not Authorized')] });
    return false;
  }
  // Register GRID-gated handlers.
  const guarded = (kind, key, fn) => router[kind](key, async (i, a) => { if (await gate(i)) return fn(i, a); });

  const sync = async (reason) => { const r = await reconciler.run(reason); await ctx.panels?.refreshStructureDependent?.(); return r; };

  // ---------- dashboard ----------
  guarded('button', 'adm:dash', async (i) => {
    await i.deferReply({ flags: 64 });
    const [pms, teams, members, reqs, tickets, settings] = await Promise.all([state.pms(), state.teams(), state.members(), store.list('requests'), store.list('tickets'), state.settings()]);
    const approved = members.filter((m) => m.status === 'approved');
    const last = reconciler.lastResult;
    const h = ctx.health.snapshot();
    await i.editReply({ embeds: [embed({ title: 'DASHBOARD', fields: [
      { name: 'Project Managers', value: String(pms.length), inline: true }, { name: 'Team Roles', value: String(teams.length), inline: true }, { name: 'Approved Members', value: String(approved.length), inline: true },
      { name: 'Pending Applications', value: String(reqs.filter((r) => r.status === 'pending').length), inline: true },
      { name: 'Open Tickets', value: String(tickets.filter((t) => t.status === 'open').length), inline: true },
      { name: 'GitHub Linked', value: String(members.filter((m) => m.github?.username).length), inline: true },
      { name: 'Last Reconciliation', value: last ? `${fmtIST(last.at)}\nreused ${last.reused}, created ${last.created}, repaired ${last.repaired}, errors ${last.errors.length}` : 'Not run yet' },
      { name: 'Monitoring Health', value: h },
      { name: 'Inactivity Threshold', value: `${settings.inactivityDays} days`, inline: true },
    ] })] });
  });

  // ---------- PM management ----------
  guarded('button', 'adm:pm', async (i) => {
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    const [pms, teams, registry] = await Promise.all([
      state.pms(),
      state.teams(),
      reconciler.loadRegistry ? reconciler.loadRegistry() : null,
    ]);
    const tn = new Map(teams.map((t) => [t.id, t.name]));
    const list = (await Promise.all(pms.map(async (p) => {
      const pmRoleId = registry ? registry.get(KEYS.pmRole(p.id))?.id : await reconciler.getObjectId(KEYS.pmRole(p.id));
      const controlId = registry ? registry.get(KEYS.pmControl(p.id))?.id : await reconciler.getObjectId(KEYS.pmControl(p.id));
      const updatesId = registry ? registry.get(KEYS.pmUpdates(p.id))?.id : await reconciler.getObjectId(KEYS.pmUpdates(p.id));
      const actId = registry ? registry.get(KEYS.pmActivity(p.id))?.id : await reconciler.getObjectId(KEYS.pmActivity(p.id));
      const mappedTeams = (p.teamIds || []).map((tid) => tn.get(tid)).filter(Boolean);
      const resForums = await Promise.all((p.teamIds || []).map(async (tid) => {
        const fid = registry ? registry.get(KEYS.resourceForum(tid))?.id : await reconciler.getObjectId(KEYS.resourceForum(tid));
        return fid ? `<#${fid}>` : null;
      }));
      return [
        `**${p.name}** [Status: \`${p.provisioningStatus || 'active'}\`]`,
        `• Discord User: <@${p.discordUserId}> (\`${p.discordUserId}\`)`,
        `• Personal Role: ${pmRoleId ? `<@&${pmRoleId}>` : 'Role pending'}`,
        `• Assigned Team(s): ${mappedTeams.join(', ') || 'None assigned yet'}`,
        `• Workspace Channels: ${controlId ? `<#${controlId}>` : 'pending'} · ${updatesId ? `<#${updatesId}>` : 'pending'} · ${actId ? `<#${actId}>` : 'pending'}`,
        `• Resource Forums: ${resForums.filter(Boolean).join(', ') || 'No resources accessible'}`,
        `• Repository: ${p.repo ? `[${p.repo.owner}/${p.repo.name}](${p.repo.url})` : 'not set'}`,
      ].join('\n');
    }))).join('\n\n') || 'No Project Managers configured yet.';

    await say(i, {
      embeds: [embed({ title: 'PM MANAGEMENT & WORKSPACE PROVISIONING', description: truncate(list, 3800) })],
      components: [
        row(button('adm:pm-add', 'ADD PM', ButtonStyle.Primary), button('adm:pm-prov', 'PROVISION / SYNC PM', ButtonStyle.Success), button('adm:pm-verify', 'VERIFY PERMISSIONS')),
        row(button('adm:pm-ren', 'RENAME PM'), button('adm:pm-del', 'REMOVE PM', ButtonStyle.Danger)),
      ],
    });
  });
  guarded('button', 'adm:pm-add', (i) => say(i, { content: 'Select the Discord member who will be the Project Manager.', components: [row(new UserSelectMenuBuilder().setCustomId('adm:pm-add-user').setPlaceholder('Select the PM'))] }));
  guarded('select', 'adm:pm-add-user', (i) => i.showModal(modal(`adm:pm-add-name:${i.values[0]}`, 'New Project Manager', input('name', 'PM name (used as the category name)', { max: 40 }))));
  guarded('modal', 'adm:pm-add-name', async (i, [uid]) => {
    await i.deferReply({ flags: 64 });
    try {
      const pm = await state.createPm({ name: i.fields.getTextInputValue('name'), discordUserId: uid });
      await sync('pm-created');
      let note = '';
      try {
        await provisionPmWorkspace(ctx, pm.id, { welcome: true, auditActorId: i.user.id });
        await state.saveMember(uid, { id: uid, status: 'approved', role: 'pm', pmId: pm.id, approvedAt: Date.now() });
      } catch (e) { note = `\nWorkspace auto-provisioning note: ${e.message}`; }
      await audit.log({ action: 'pm.created', actorId: i.user.id, targetId: uid, details: { pmId: pm.id, name: pm.name } });
      await say(i, { embeds: [okEmbed(`PM **${pm.name}** created and workspace provisioned with personal role, control, updates, activity, and voice channels.${note}\nNext: use **Role-to-PM Mapping** to assign team roles.`)] });
    } catch (e) { await say(i, { embeds: [errEmbed(e.message)] }); }
  });

  guarded('button', 'adm:pm-prov', (i) => pmPicker(i, 'adm:pm-prov-sel', 'Select a PM to provision/synchronize their workspace, roles, and introduction channels.'));
  guarded('select', 'adm:pm-prov-sel', async (i) => {
    await i.deferReply({ flags: 64 });
    const pmId = i.values[0];
    try {
      const res = await provisionPmWorkspace(ctx, pmId, { welcome: true, auditActorId: i.user.id });
      await say(i, { embeds: [okEmbed(
        `PM Workspace successfully synchronized for **${res.pm.name}**.\n\n` +
        `• **Personal Role**: ${res.pm.roleId ? `<@&${res.pm.roleId}>` : 'Created'}\n` +
        `• **Assigned Teams**: ${res.resources.map((r) => r.name).join(', ') || 'None'}\n` +
        `• **Roles Added**: ${res.rolesAdded.length ? res.rolesAdded.map((r) => `<@&${r}>`).join(', ') : 'None'}\n` +
        `• **Roles Removed**: ${res.rolesRemoved.length ? res.rolesRemoved.map((r) => `<@&${r}>`).join(', ') : 'None'}\n` +
        `• **Channels Configured**: <#${res.channels.control}>, <#${res.channels.updates}>, <#${res.channels.activity}>\n` +
        `• **Resource Forums Accessible**: ${res.resources.map((r) => `<#${r.forumId}>`).join(', ') || 'None'}\n\n` +
        `Introduction messages have been populated in all channels.`,
        'Provisioning Complete'
      )] });
    } catch (e) {
      await say(i, { embeds: [errEmbed(`Provisioning failed: ${e.message}`)] });
    }
  });

  guarded('button', 'adm:pm-verify', (i) => pmPicker(i, 'adm:pm-verify-sel', 'Select a PM to audit their Discord channel and resource permissions.'));
  guarded('select', 'adm:pm-verify-sel', async (i) => {
    await i.deferReply({ flags: 64 });
    const pmId = i.values[0];
    const pm = await state.getPm(pmId);
    if (!pm) return say(i, { embeds: [errEmbed('PM not found.')] });
    try {
      const report = await auditPmPermissions(ctx, pmId);
      const lines = report.checks.map((c) => `${c.pass ? '✅' : '❌'} **${c.name}**: Expected \`${c.expected}\`, Actual \`${c.actual}\``);
      await say(i, { embeds: [embed({
        title: `PERMISSION VERIFICATION AUDIT — ${pm.name.toUpperCase()}`,
        color: report.pass ? BRAND.accent : 0xcf222e,
        description: `Overall Verification: **${report.pass ? 'ALL CHECKS PASSED ✅' : 'CHECKS FAILED ❌'}**\n\n` + lines.join('\n'),
        footer: 'Evaluates real category, channel, and role permission overwrites in Discord',
      })] });
    } catch (e) {
      await say(i, { embeds: [errEmbed(`Audit failed: ${e.message}`)] });
    }
  });

  const pmPicker = async (i, id, ph) => {
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    const pms = await state.pms(); if (!pms.length) return say(i, 'No PMs configured.');
    return say(i, { content: ph, components: [row(menu(id, 'Select a PM', pms.map((p) => ({ label: p.name.slice(0, 100), value: p.id }))))] });
  };
  guarded('button', 'adm:pm-ren', (i) => pmPicker(i, 'adm:pm-ren-sel', 'Which PM do you want to rename?'));
  guarded('select', 'adm:pm-ren-sel', (i) => i.showModal(modal(`adm:pm-ren-modal:${i.values[0]}`, 'Rename PM', input('name', 'New PM name', { max: 40 }))));
  guarded('modal', 'adm:pm-ren-modal', async (i, [id]) => {
    await i.deferReply({ flags: 64 });
    const name = i.fields.getTextInputValue('name').trim(); const pm = await state.getPm(id);
    if (!pm) return say(i, { embeds: [errEmbed('PM not found.')] });
    if ((await state.pms()).some((p) => p.id !== id && p.slug === slugify(name))) return say(i, { embeds: [errEmbed('Another PM already uses that name.')] });
    const oldSlug = pm.slug; await state.updatePm(id, { name, slug: slugify(name) });
    await managed.renameManaged(KEYS.pmRole(id), name); await managed.renameManaged(KEYS.pmCategory(id), name);
    await managed.renameManaged(KEYS.pmControl(id), `${slugify(name)}-control`, { slug: true }); await managed.renameManaged(KEYS.pmUpdates(id), `${slugify(name)}-updates`, { slug: true });
    await audit.log({ action: 'pm.renamed', actorId: i.user.id, details: { pmId: id, from: pm.name, to: name, oldSlug } });
    await say(i, { embeds: [okEmbed(`Renamed to **${name}**.`)] });
  });
  guarded('button', 'adm:pm-del', (i) => pmPicker(i, 'adm:pm-del-sel', 'Which PM do you want to remove? You will be asked to confirm.'));
  guarded('select', 'adm:pm-del-sel', async (i) => {
    const pm = await state.getPm(i.values[0]);
    if (!pm) return say(i, { embeds: [errEmbed('PM not found.')] });
    await i.update({ content: null, embeds: [errEmbed(`Removing **${pm.name}** permanently deletes the PM role, category, control/updates/activity channels, team channels and voice channels. Member records are kept but unassigned. This cannot be undone.`, 'Confirm Destructive Action')], components: [row(button(`adm:pm-del-ok:${pm.id}`, 'PERMANENTLY REMOVE', ButtonStyle.Danger))] });
  });
  guarded('button', 'adm:pm-del-ok', async (i, [id]) => {
    await i.deferUpdate(); const pm = await state.getPm(id);
    if (!pm) { await i.editReply({ embeds: [errEmbed('PM not found.')], components: [] }); return; }
    const n = await managed.deleteWhere((k) => k.startsWith(`pm:${id}:`) || k.startsWith(`msg:pm:${id}:`), `IPDC admin removed PM ${pm.name}`);
    await state.updatePm(id, { status: 'removed', removedAt: Date.now() });
    for (const m of (await state.members()).filter((x) => x.pmId === id)) await state.saveMember(m.id, { pmId: null, teamId: null, status: 'unassigned' });
    await audit.log({ action: 'pm.removed', actorId: i.user.id, level: 'warn', details: { pmId: id, name: pm.name, objectsDeleted: n } });
    await i.editReply({ embeds: [okEmbed(`PM **${pm.name}** removed (${n} managed objects deleted).`)], components: [] });
  });

  // ---------- team roles ----------
  guarded('button', 'adm:team', async (i) => {
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    const teams = await state.teams();
    await say(i, { embeds: [embed({ title: 'TEAM ROLES', description: teams.map((t) => `**${t.name}** — resource forum + role`).join('\n') || 'No team roles configured yet.' })],
      components: [row(button('adm:team-add', 'ADD TEAM ROLE', ButtonStyle.Primary), button('adm:team-ren', 'RENAME'), button('adm:team-del', 'REMOVE', ButtonStyle.Danger))] });
  });
  guarded('button', 'adm:team-add', (i) => i.showModal(modal('adm:team-add-modal', 'New Team Role', input('name', 'Team role name', { max: 40, ph: 'e.g. Frontend' }))));
  guarded('modal', 'adm:team-add-modal', async (i) => {
    await i.deferReply({ flags: 64 });
    try {
      const t = await state.createTeam({ name: i.fields.getTextInputValue('name') });
      const r = await sync('team-created');
      await audit.log({ action: 'team.created', actorId: i.user.id, details: { teamId: t.id, name: t.name } });
      await say(i, { embeds: [okEmbed(`Team role **${t.name}** created with its resource forum. Map it to PMs with Role-to-PM Mapping.${r.errors?.length ? `\nWarnings: ${r.errors.slice(0, 3).join('; ')}` : ''}`)] });
    } catch (e) { await say(i, { embeds: [errEmbed(e.message)] }); }
  });
  const teamPicker = async (i, id, ph) => {
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    const teams = await state.teams(); if (!teams.length) return say(i, 'No team roles configured.');
    return say(i, { content: ph, components: [row(menu(id, 'Select a team role', teams.map((t) => ({ label: t.name.slice(0, 100), value: t.id }))))] });
  };
  guarded('button', 'adm:team-ren', (i) => teamPicker(i, 'adm:team-ren-sel', 'Which team role do you want to rename?'));
  guarded('select', 'adm:team-ren-sel', (i) => i.showModal(modal(`adm:team-ren-modal:${i.values[0]}`, 'Rename Team Role', input('name', 'New name', { max: 40 }))));
  guarded('modal', 'adm:team-ren-modal', async (i, [id]) => {
    await i.deferReply({ flags: 64 });
    const name = i.fields.getTextInputValue('name').trim(); const t = await state.getTeam(id);
    if (!t) return say(i, { embeds: [errEmbed('Team role not found.')] });
    if ((await state.teams()).some((x) => x.id !== id && x.slug === slugify(name))) return say(i, { embeds: [errEmbed('Another team role already uses that name.')] });
    await state.updateTeam(id, { name, slug: slugify(name) });
    await managed.renameManaged(KEYS.teamRole(id), name); await managed.renameManaged(KEYS.resourceForum(id), name, { slug: true });
    for (const pm of await state.pms()) await managed.renameManaged(KEYS.pmTeamText(pm.id, id), name, { slug: true });
    await audit.log({ action: 'team.renamed', actorId: i.user.id, details: { teamId: id, from: t.name, to: name } });
    await say(i, { embeds: [okEmbed(`Renamed to **${name}** (role, forum and team channels updated).`)] });
  });
  guarded('button', 'adm:team-del', (i) => teamPicker(i, 'adm:team-del-sel', 'Which team role do you want to remove? You will be asked to confirm.'));
  guarded('select', 'adm:team-del-sel', async (i) => {
    const t = await state.getTeam(i.values[0]);
    if (!t) return say(i, { embeds: [errEmbed('Team role not found.')] });
    await i.update({ content: null, embeds: [errEmbed(`Removing **${t.name}** permanently deletes the role, resource forum (with its posts) and all PM team channels for it. This cannot be undone.`, 'Confirm Destructive Action')], components: [row(button(`adm:team-del-ok:${t.id}`, 'PERMANENTLY REMOVE', ButtonStyle.Danger))] });
  });
  guarded('button', 'adm:team-del-ok', async (i, [id]) => {
    await i.deferUpdate(); const t = await state.getTeam(id);
    if (!t) { await i.editReply({ embeds: [errEmbed('Team role not found.')], components: [] }); return; }
    const n = await managed.deleteWhere((k) => k === KEYS.teamRole(id) || k === KEYS.resourceForum(id) || (k.startsWith('pm:') && k.endsWith(`:team:${id}:text`)), `IPDC admin removed team ${t.name}`);
    await state.updateTeam(id, { status: 'removed', removedAt: Date.now() });
    for (const pm of await state.pms()) if ((pm.teamIds || []).includes(id)) await state.updatePm(pm.id, { teamIds: pm.teamIds.filter((x) => x !== id) });
    for (const m of (await state.members()).filter((x) => x.teamId === id)) await state.saveMember(m.id, { teamId: null });
    await audit.log({ action: 'team.removed', actorId: i.user.id, level: 'warn', details: { teamId: id, name: t.name, objectsDeleted: n } });
    await i.editReply({ embeds: [okEmbed(`Team role **${t.name}** removed (${n} managed objects deleted).`)], components: [] });
  });

  // ---------- role-to-PM mapping ----------
  guarded('button', 'adm:map', (i) => pmPicker(i, 'adm:map-pm', 'Select a PM to edit which team roles belong to their team.'));
  guarded('select', 'adm:map-pm', async (i) => {
    const pm = await state.getPm(i.values[0]); const teams = await state.teams();
    if (!pm) return say(i, { embeds: [errEmbed('PM not found.')] });
    if (!teams.length) return i.update({ content: 'Create team roles first.', components: [] });
    const opts = teams.slice(0, 25).map((t) => ({ label: t.name.slice(0, 100), value: t.id, default: (pm.teamIds || []).includes(t.id) }));
    await i.update({ content: `Team roles for **${pm.name}**. Select all that apply, then the channels are created automatically.`, components: [row(new StringSelectMenuBuilder().setCustomId(`adm:map-set:${pm.id}`).setPlaceholder('Select team roles').setMinValues(0).setMaxValues(opts.length).addOptions(opts))] });
  });
  guarded('select', 'adm:map-set', async (i, [pmId]) => {
    await i.deferUpdate();
    const pm = await state.getPm(pmId);
    if (!pm) { await i.editReply({ embeds: [errEmbed('PM not found.')], components: [] }); return; }
    const before = pm.teamIds || [];
    await state.updatePm(pmId, { teamIds: i.values });
    let prov = { rolesAdded: [], rolesRemoved: [], resources: [] };
    try {
      prov = await provisionPmWorkspace(ctx, pmId, { welcome: false, auditActorId: i.user.id });
    } catch (e) {
      log.warn(`workspace sync on mapping change failed: ${e.message}`);
      await sync('mapping-updated');
    }
    const dropped = before.filter((t) => !i.values.includes(t));
    const added = i.values.filter((t) => !before.includes(t));
    await audit.log({ action: 'pm.mapping_updated', actorId: i.user.id, details: { pmId, teamIds: i.values, dropped, added } });
    await i.editReply({
      content: null,
      embeds: [okEmbed(
        `Role-to-PM Mapping successfully updated for **${pm.name}**.\n\n` +
        `• **Assigned Teams**: ${prov.resources?.length ? prov.resources.map((r) => r.name).join(', ') : 'None'}\n` +
        `• **Discord Roles Added**: ${prov.rolesAdded?.length ? prov.rolesAdded.map((r) => `<@&${r}>`).join(', ') : 'None'}\n` +
        `• **Discord Roles Removed**: ${prov.rolesRemoved?.length ? prov.rolesRemoved.map((r) => `<@&${r}>`).join(', ') : 'None'}\n` +
        `• **Resource Forums Accessible**: ${prov.resources?.length ? prov.resources.map((r) => `<#${r.forumId}>`).join(', ') : 'None'}\n\n` +
        `Team text channels and resource visibility have been synchronized.` +
        (dropped.length ? `\n\n*Note: ${dropped.length} previously created team text channel(s) were preserved; delete via Cleanup if no longer needed.*` : ''),
        'Mapping Synchronized'
      )],
      components: [],
    });
  });

  // ---------- applications ----------
  guarded('button', 'adm:appr', async (i) => {
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    const pending = (await store.list('requests')).filter((r) => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const g = cfg.discord.guildId;
    const lines = pending.slice(0, 20).map((r) => `• ${r.type.replace('_', ' ')} — <@${r.userId}> — [open](https://discord.com/channels/${g}/${r.ref?.channelId}/${r.ref?.messageId})`);
    await say(i, { embeds: [embed({ title: 'PENDING APPLICATIONS AND REQUESTS', description: lines.join('\n') || 'No pending requests.' })] });
  });

  // ---------- resources ----------
  guarded('button', 'adm:res', async (i) => {
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    const [teams, registry] = await Promise.all([
      state.teams(),
      reconciler.loadRegistry ? reconciler.loadRegistry() : null,
    ]);
    const lines = [];
    for (const t of teams) {
      const id = registry ? registry.get(KEYS.resourceForum(t.id))?.id : await reconciler.getObjectId(KEYS.resourceForum(t.id));
      lines.push(`**${t.name}** — ${id ? `<#${id}>` : 'forum missing (run Repair Structure)'}`);
    }
    await say(i, { embeds: [embed({ title: 'RESOURCE FORUMS', description: lines.join('\n') || 'No team roles yet.' })], components: teams.length ? [row(button('adm:res-post', 'POST A RESOURCE', ButtonStyle.Primary))] : [] });
  });
  guarded('button', 'adm:res-post', (i) => teamPicker(i, 'adm:res-team', 'Which team forum should receive the resource?'));
  guarded('select', 'adm:res-team', (i) => i.showModal(modal(`adm:res-modal:${i.values[0]}`, 'New Resource Post', input('title', 'Title', { max: 90 }), input('link', 'Link (GitHub, YouTube, site, PDF...)', { max: 300, required: false }), input('desc', 'Description', { long: true, max: 1500, required: false }))));
  guarded('modal', 'adm:res-modal', async (i, [teamId]) => {
    await i.deferReply({ flags: 64 });
    const id = await reconciler.getObjectId(KEYS.resourceForum(teamId));
    const forum = id ? await client.channels.fetch(id).catch(() => null) : null;
    if (!forum || forum.type !== ChannelType.GuildForum) return say(i, { embeds: [errEmbed('Forum not available. Run Repair Structure.')] });
    const link = i.fields.getTextInputValue('link')?.trim(); const desc = i.fields.getTextInputValue('desc')?.trim();
    const post = await forum.threads.create({ name: i.fields.getTextInputValue('title').slice(0, 100), message: { content: [desc, link].filter(Boolean).join('\n\n') || 'Resource', allowedMentions: { parse: [] } } });
    await audit.log({ action: 'resource.posted', actorId: i.user.id, details: { teamId, threadId: post.id } });
    await say(i, { embeds: [okEmbed(`Resource posted: <#${post.id}>`)] });
  });

  // ---------- support ticket management ----------
  guarded('button', 'adm:tix', async (i) => {
    const s = await state.settings(); const open = (await store.list('tickets')).filter((t) => t.status !== 'closed');
    await say(i, { embeds: [embed({ title: 'SUPPORT TICKET MANAGEMENT', fields: [
      { name: 'Open Tickets', value: open.map((t) => `<#${t.channelId}> — ${t.category} — ${t.claimedBy ? `claimed by <@${t.claimedBy}>` : 'unclaimed'}`).join('\n').slice(0, 1000) || 'None' },
      { name: 'Categories', value: s.supportCategories.join(', ') },
    ] })], components: [row(button('adm:tix-cats', 'EDIT CATEGORIES', ButtonStyle.Primary))] });
  });
  guarded('button', 'adm:tix-cats', async (i) => { const s = await state.settings(); await i.showModal(modal('adm:tix-cats-modal', 'Support Categories', input('cats', 'Categories (comma separated, max 25)', { long: true, max: 800, value: s.supportCategories.join(', ') }))); });
  guarded('modal', 'adm:tix-cats-modal', async (i) => {
    const cats = [...new Set(i.fields.getTextInputValue('cats').split(',').map((c) => c.trim()).filter(Boolean))].slice(0, 25);
    if (!cats.length) return say(i, { embeds: [errEmbed('At least one category is required.')] });
    await state.saveSettings({ supportCategories: cats });
    await audit.log({ action: 'settings.support_categories', actorId: i.user.id, details: { cats } });
    await ctx.panels?.refresh?.('support');
    await say(i, { embeds: [okEmbed('Support categories updated.')] });
  });

  // ---------- permissions ----------
  guarded('button', 'adm:perm', async (i) => {
    const s = await state.settings();
    const gr = menu('adm:perm-grants', 'ADMIN role permissions', GRANTS.map(([v, l]) => ({ label: l, value: v, default: s.adminGrants.includes(v) })), { min: 0, max: GRANTS.length });
    const roles = new RoleSelectMenuBuilder().setCustomId('adm:perm-roles').setPlaceholder('Additional support staff roles').setMinValues(0).setMaxValues(10);
    if (s.supportRoleIds?.length) roles.setDefaultRoles(s.supportRoleIds.slice(0, 10));
    await say(i, { embeds: [embed({ title: 'PERMISSIONS', description: 'IPDC GRID always has full access. The ADMIN role has support access plus only the permissions selected here. Additional support staff roles can access all tickets.' })], components: [row(gr), row(roles)] });
  });
  guarded('select', 'adm:perm-grants', async (i) => {
    await i.deferUpdate(); await state.saveSettings({ adminGrants: i.values });
    await audit.log({ action: 'permissions.admin_grants', actorId: i.user.id, details: { grants: i.values } });
    await sync('permissions-updated'); await i.followUp({ embeds: [okEmbed('ADMIN permissions saved and channel access synchronized.')], flags: 64 });
  });
  guarded('select', 'adm:perm-roles', async (i) => {
    await i.deferUpdate();
    const ids = i.values.filter((r) => r !== cfg.roles.grid && r !== cfg.roles.admin);
    await state.saveSettings({ supportRoleIds: ids });
    await audit.log({ action: 'permissions.support_roles', actorId: i.user.id, details: { roleIds: ids } });
    await i.followUp({ embeds: [okEmbed('Support staff roles saved. They apply to tickets created from now on and to staff checks immediately.')], flags: 64 });
  });

  // ---------- audit ----------
  guarded('button', 'adm:audit', async (i) => {
    const rows = await audit.recent(15);
    await say(i, { embeds: [embed({ title: 'RECENT AUDIT LOG', description: truncate(rows.map((e) => `\`${fmtIST(e.at)}\` **${e.action}**${e.actorId ? ` by <@${e.actorId}>` : ''}${e.targetId ? ` on <@${e.targetId}>` : ''}`).join('\n') || 'No entries.', 3800) })] });
  });

  // ---------- server settings ----------
  guarded('button', 'adm:set', async (i) => {
    const s = await state.settings();
    await i.showModal(modal('adm:set-modal', 'Server Settings',
      input('inact', 'Inactivity alert threshold (days)', { value: String(s.inactivityDays), max: 3 }),
      input('lb', 'Leaderboard window (days)', { value: String(s.leaderboardDays), max: 3 }),
      input('weeks', 'Heatmap weeks (4-26)', { value: String(s.heatmapWeeks), max: 2 }),
      input('mail', 'Extra report recipients (comma separated)', { value: (s.reportRecipients || []).join(', '), required: false, max: 400 })));
  });
  guarded('modal', 'adm:set-modal', async (i) => {
    const num = (id, min, max) => { const n = Number.parseInt(i.fields.getTextInputValue(id), 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null; };
    const inactivityDays = num('inact', 1, 90); const leaderboardDays = num('lb', 1, 365); const heatmapWeeks = num('weeks', 4, 26);
    if ([inactivityDays, leaderboardDays, heatmapWeeks].includes(null)) return say(i, { embeds: [errEmbed('All numeric settings must be numbers.')] });
    const mails = i.fields.getTextInputValue('mail').split(',').map((m) => m.trim()).filter(Boolean);
    if (mails.some((m) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m))) return say(i, { embeds: [errEmbed('One of the email addresses is not valid.')] });
    await state.saveSettings({ inactivityDays, leaderboardDays, heatmapWeeks, reportRecipients: mails });
    await audit.log({ action: 'settings.updated', actorId: i.user.id, details: { inactivityDays, leaderboardDays, heatmapWeeks, recipients: mails.length } });
    await say(i, { embeds: [okEmbed('Settings saved.')] });
  });

  // ---------- challenges ----------
  guarded('button', 'adm:chal', async (i) => {
    const ch = (await store.list('challenges')).filter((c) => c.status === 'active');
    await say(i, { embeds: [embed({ title: 'CHALLENGES', description: ch.map((c) => `**${c.title}** — ${c.target} ${c.metric} — ends ${fmtIST(c.endsAt)}`).join('\n') || 'No active challenges.' })],
      components: [row(button('adm:chal-new', 'NEW CHALLENGE', ButtonStyle.Primary), button('adm:chal-end', 'END CHALLENGE', ButtonStyle.Secondary, !ch.length))] });
  });
  guarded('button', 'adm:chal-new', (i) => i.showModal(modal('adm:chal-modal', 'New Challenge', input('title', 'Title', { max: 80 }), input('desc', 'Description', { long: true, max: 600 }), input('metric', 'Metric: commits or pull_requests', { value: 'commits', max: 14 }), input('target', 'Target count per member', { max: 5, ph: '20' }), input('days', 'Duration in days', { max: 3, ph: '14' }))));
  guarded('modal', 'adm:chal-modal', async (i) => {
    const metric = i.fields.getTextInputValue('metric').trim().toLowerCase(); const target = Number.parseInt(i.fields.getTextInputValue('target'), 10); const days = Number.parseInt(i.fields.getTextInputValue('days'), 10);
    if (!['commits', 'pull_requests'].includes(metric) || !(target > 0) || !(days > 0 && days <= 365)) return say(i, { embeds: [errEmbed('Metric must be commits or pull_requests; target and days must be positive numbers.')] });
    const c = { id: newId(), title: i.fields.getTextInputValue('title').trim(), description: i.fields.getTextInputValue('desc').trim(), metric, target, startsAt: Date.now(), endsAt: Date.now() + days * 86400000, status: 'active', participants: [], createdBy: i.user.id };
    await store.set('challenges', c.id, c);
    await audit.log({ action: 'challenge.created', actorId: i.user.id, details: { id: c.id, title: c.title } });
    await ctx.panels?.refresh?.('challenges');
    await say(i, { embeds: [okEmbed(`Challenge **${c.title}** is live in #github-challenges.`)] });
  });
  guarded('button', 'adm:chal-end', async (i) => {
    const ch = (await store.list('challenges')).filter((c) => c.status === 'active');
    await say(i, { content: 'Which challenge should end now?', components: [row(menu('adm:chal-end-sel', 'Select a challenge', ch.map((c) => ({ label: c.title.slice(0, 100), value: c.id }))))] });
  });
  guarded('select', 'adm:chal-end-sel', async (i) => {
    await store.merge('challenges', i.values[0], { status: 'ended', endedAt: Date.now() });
    await audit.log({ action: 'challenge.ended', actorId: i.user.id, details: { id: i.values[0] } });
    await ctx.panels?.refresh?.('challenges');
    await i.update({ content: 'Challenge ended.', components: [] });
  });

  // ---------- GitHub override ----------
  guarded('button', 'adm:gh', (i) => say(i, { content: 'Select the member whose GitHub account mapping you want to set (this overrides duplicate protection).', components: [row(new UserSelectMenuBuilder().setCustomId('adm:gh-user').setPlaceholder('Select member'))] }));
  guarded('select', 'adm:gh-user', (i) => i.showModal(modal(`adm:gh-modal:${i.values[0]}`, 'GitHub Profile Override', input('url', 'GitHub profile URL', { ph: 'https://github.com/username' }))));
  guarded('modal', 'adm:gh-modal', async (i, [uid]) => {
    await i.deferReply({ flags: 64 });
    const username = parseGithubUsername(i.fields.getTextInputValue('url'));
    if (!username) return say(i, { embeds: [errEmbed('Invalid GitHub profile URL.')] });
    const info = await ctx.github.verifyUser(username).catch(() => null);
    if (!info) return say(i, { embeds: [errEmbed('GitHub profile could not be verified.')] });
    await state.linkGithub(uid, info.login, { override: true });
    await audit.log({ action: 'github.link_override', actorId: i.user.id, targetId: uid, level: 'warn', details: { username: info.login } });
    await say(i, { embeds: [okEmbed(`Linked <@${uid}> to GitHub user **${info.login}**.`)] });
  });

  // ---------- repair + cleanup ----------
  guarded('button', 'adm:repair', async (i) => {
    await i.deferReply({ flags: 64 });
    const r = await sync('admin-repair');
    await audit.log({ action: 'structure.repair_requested', actorId: i.user.id, details: { created: r.created, repaired: r.repaired, adopted: r.adopted } });
    await say(i, { embeds: [embed({ title: 'STRUCTURE RECONCILIATION', color: r.errors?.length ? 0xcf222e : 0x2ea043, description: r.skipped ? 'Another reconciliation holds the lock. Try again shortly.' : `Reused: ${r.reused}\nAdopted: ${r.adopted}\nCreated: ${r.created}\nRepaired permissions: ${r.repaired}\nSkipped: ${r.skipped}\nErrors: ${r.errors.length}${r.errors.length ? `\n\n${truncate(r.errors.slice(0, 5).join('\n'), 800)}` : ''}\n\nNothing was deleted.` })] });
  });
  guarded('button', 'adm:clean', async (i) => {
    const orphans = await managed.orphans();
    if (!orphans.length) return say(i, { embeds: [okEmbed('No orphaned managed objects. Nothing to clean up.', 'Cleanup')] });
    const opts = orphans.slice(0, 25).map((o) => ({ label: `${o.type}: ${o.name}`.slice(0, 100), value: o.key.replaceAll(':', '|'), description: o.key.slice(0, 100) }));
    await say(i, { embeds: [errEmbed('These managed objects are no longer part of the configured structure (for example a team channel after un-mapping). Select one to delete. You will be asked to confirm.', 'Destructive Cleanup')], components: [row(menu('adm:clean-sel', 'Select an orphaned object', opts))] });
  });
  guarded('select', 'adm:clean-sel', async (i) => {
    const key = i.values[0];
    await i.update({ embeds: [errEmbed(`Permanently delete \`${key.replaceAll('|', ':')}\`? This cannot be undone.`, 'Confirm Deletion')], components: [row(button(`adm:clean-ok:${key}`, 'PERMANENTLY DELETE', ButtonStyle.Danger))] });
  });
  guarded('button', 'adm:clean-ok', async (i, [key]) => {
    await i.deferUpdate(); const real = key.replaceAll('|', ':');
    const ok = await managed.deleteManaged(real, 'IPDC admin cleanup');
    await audit.log({ action: 'structure.cleanup_deleted', actorId: i.user.id, level: 'warn', details: { key: real, deleted: ok } });
    await i.editReply({ embeds: [okEmbed(ok ? 'Deleted.' : 'Object was already gone.')], components: [] });
  });

  log.debug('admin panel handlers registered');
}
