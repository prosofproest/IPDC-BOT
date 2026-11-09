import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { STATIC_NAMES } from '../config/constants.js';
import { slugify } from '../utils/misc.js';

// ---------------------------------------------------------------------------
// Permission groups
// ---------------------------------------------------------------------------
const READ = ['ViewChannel', 'ReadMessageHistory'];
const NO_POST = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'];
const CHAT = [...READ, 'SendMessages', 'SendMessagesInThreads', 'AttachFiles', 'EmbedLinks', 'AddReactions', 'UseExternalEmojis'];
const STAFF = [...CHAT, 'ManageMessages'];
const VOICE = ['ViewChannel', 'Connect', 'Speak', 'Stream', 'UseVAD'];
const BOT_TEXT = [...READ, 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ManageMessages', 'AddReactions'];
const BOT_VOICE = ['ViewChannel', 'Connect'];
const FORUM_STAFF = [...STAFF, 'ManageThreads'];

export const PERM_GROUPS = { READ, NO_POST, CHAT, STAFF, VOICE, BOT_TEXT, BOT_VOICE, FORUM_STAFF };

export function bitsOf(names = []) {
  let b = 0n;
  for (const n of names) {
    const v = PermissionFlagsBits[n];
    if (v === undefined) throw new Error(`Unknown permission flag: ${n}`);
    b |= v;
  }
  return b;
}

const ov = (to, allow = [], deny = []) => ({ to, allow, deny });
const HIDE = ov('everyone', [], ['ViewChannel']);

export const KEYS = {
  roleGrid: 'role:grid', roleAdmin: 'role:admin', roleIpdc: 'role:ipdc',
  pmRole: (id) => `pm:${id}:role`,
  teamRole: (id) => `team:${id}:role`,
  pmCategory: (id) => `pm:${id}:category`,
  pmControl: (id) => `pm:${id}:control`,
  pmUpdates: (id) => `pm:${id}:updates`,
  pmActivity: (id) => `pm:${id}:github-activity`,
  pmTeamText: (pmId, teamId) => `pm:${pmId}:team:${teamId}:text`,
  pmVoiceMeeting: (id) => `pm:${id}:voice:meeting`,
  pmVoiceProject: (id) => `pm:${id}:voice:project`,
  resourceForum: (teamId) => `resource:${teamId}:forum`,
};

const bot = (voice = false) => ov('bot', voice ? BOT_VOICE : BOT_TEXT);

/**
 * Pure function: configuration state -> ordered list of desired managed objects.
 * No PM or team names are hardcoded; everything dynamic comes from `state`.
 * Each item: { key, kind, name, parentKey?, overwrites[], fixedId?, adopt? }
 */
export function buildStructure({ pms = [], teams = [], members = [], settings = {}, cfg }) {
  const items = [];
  const adminGrants = settings.adminGrants || [];
  const adminPm = adminGrants.includes('pm.channels.view');
  const adminResources = adminGrants.includes('resource.manage');
  const G = KEYS.roleGrid; const A = KEYS.roleAdmin; const I = KEYS.roleIpdc;

  // ---- roles ----
  items.push({ key: G, kind: 'role', name: 'IPDC GRID', fixedId: cfg.roles.grid });
  items.push({ key: A, kind: 'role', name: 'ADMIN', fixedId: cfg.roles.admin });
  items.push({ key: I, kind: 'role', name: 'IPDC', fixedId: cfg.roles.ipdc || undefined, adopt: true });
  for (const t of teams) items.push({ key: KEYS.teamRole(t.id), kind: 'role', name: t.name, fixedId: t.roleId || undefined, adopt: true, meta: { teamId: t.id } });
  for (const p of pms) {
    const roleName = p.roleName || (p.name.startsWith('PM - ') ? p.name : `PM - ${p.name}`);
    items.push({ key: KEYS.pmRole(p.id), kind: 'role', name: roleName, altName: p.name, fixedId: p.roleId || undefined, adopt: true, meta: { pmId: p.id } });
  }

  const cat = (key, name, overwrites) => items.push({ key, kind: 'category', name, overwrites });
  const text = (key, name, parentKey, overwrites, extra = {}) => items.push({ key, kind: 'text', name, parentKey, overwrites, ...extra });
  const voice = (key, name, parentKey, overwrites) => items.push({ key, kind: 'voice', name, parentKey, overwrites });
  const forum = (key, name, parentKey, overwrites, extra = {}) => items.push({ key, kind: 'forum', name, parentKey, overwrites, ...extra });

  // member-facing read-only / chat overwrite sets
  const ipdcReadOnly = [HIDE, ov(I, READ, NO_POST), ov(A, READ, NO_POST), ov(G, STAFF), bot()];
  const ipdcChat = [HIDE, ov(I, CHAT), ov(A, STAFF), ov(G, STAFF), bot()];
  const ipdcVoice = [HIDE, ov(I, VOICE), ov(A, VOICE), ov(G, VOICE), bot(true)];

  // ---- WELCOME ----
  const welcomeOv = [ov('everyone', READ, NO_POST), ov(A, STAFF), ov(G, STAFF), bot()];
  cat('cat:welcome', STATIC_NAMES.catWelcome, welcomeOv);
  text('ch:welcome', 'welcome', 'cat:welcome', welcomeOv, { topic: 'Entry point and verification instructions.' });

  // ---- GENERAL ----
  cat('cat:general', STATIC_NAMES.catGeneral, ipdcReadOnly);
  text('ch:announcements', 'announcements', 'cat:general', [HIDE, ov(I, READ, NO_POST), ov(A, STAFF), ov(G, STAFF), bot()], { topic: 'Official server-wide announcements.' });
  text('ch:general', 'general', 'cat:general', ipdcChat, { topic: 'Approved IPDC member discussion.' });
  voice('vc:general-meeting', 'General Meeting', 'cat:general', ipdcVoice);
  voice('vc:open-discussion', 'Open Discussion', 'cat:general', ipdcVoice);

  // ---- CHALLENGES ----
  cat('cat:challenges', STATIC_NAMES.catChallenges, ipdcReadOnly);
  text('ch:github-contributions', 'github-contributions', 'cat:challenges', ipdcReadOnly, { topic: 'Member contribution heatmaps. Updated daily at 9 PM IST.' });
  text('ch:contribution-leaderboard', 'contribution-leaderboard', 'cat:challenges', ipdcReadOnly, { topic: 'Server-wide contribution ranking.' });
  text('ch:server-activity', 'server-activity', 'cat:challenges', ipdcReadOnly, { topic: 'Server-wide and PM team activity dashboard.' });
  text('ch:github-challenges', 'github-challenges', 'cat:challenges', ipdcReadOnly, { topic: 'Coding and contribution challenges.' });
  voice('vc:coding-room', 'Coding Room', 'cat:challenges', ipdcVoice);
  voice('vc:collaboration-room', 'Collaboration Room', 'cat:challenges', ipdcVoice);

  // ---- IPDC RESOURCES (one forum per team role) ----
  cat('cat:resources', STATIC_NAMES.catResources, [HIDE, ov(I, READ, NO_POST), ov(A, READ, NO_POST), ov(G, FORUM_STAFF), bot()]);
  for (const t of teams) {
    forum(KEYS.resourceForum(t.id), slugify(t.name), 'cat:resources', [
      HIDE,
      ov(KEYS.teamRole(t.id), READ, ['SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads']),
      ov(G, FORUM_STAFF),
      ...(adminResources ? [ov(A, FORUM_STAFF)] : []),
      bot(),
    ], { topic: `Official resources for the ${t.name} team. Resources are posted and maintained by authorized IPDC administrators.`, meta: { teamId: t.id } });
  }

  // ---- PM categories ----
  for (const p of pms) {
    const R = KEYS.pmRole(p.id); const U = `user:${p.discordUserId}`;
    const adm = adminPm ? [ov(A, READ)] : [];
    const catKey = KEYS.pmCategory(p.id);
    cat(catKey, p.name, [HIDE, ov(R, READ, NO_POST), ov(A, READ, NO_POST), ov(G, STAFF), bot()]);
    text(KEYS.pmControl(p.id), `${p.slug}-control`, catKey,
      [HIDE, ov(U, CHAT), ov(A, STAFF), ov(G, STAFF), bot()],
      { topic: 'Private PM control: applications, change requests, repository settings.', meta: { pmId: p.id } });
    text(KEYS.pmUpdates(p.id), `${p.slug}-updates`, catKey,
      [HIDE, ov(R, READ, NO_POST), ov(U, CHAT), ov(A, STAFF), ov(G, STAFF), bot()],
      { topic: 'PM announcements, deadlines and meeting updates.', meta: { pmId: p.id } });
    const mapped = teams.filter((t) => (p.teamIds || []).includes(t.id));
    for (const t of mapped) {
      const memberOv = members
        .filter((m) => m.status === 'approved' && m.pmId === p.id && m.teamId === t.id)
        .map((m) => ov(`user:${m.id}`, CHAT));
      text(KEYS.pmTeamText(p.id, t.id), slugify(t.name), catKey,
        [HIDE, ov(U, CHAT), ...memberOv, ...(adminPm ? [ov(A, STAFF)] : []), ov(G, STAFF), bot()],
        { topic: `${t.name} channel for ${p.name}'s team.`, meta: { pmId: p.id, teamId: t.id } });
    }
    text(KEYS.pmActivity(p.id), 'github-activity', catKey,
      [HIDE, ov(R, READ, NO_POST), ov(U, READ, NO_POST), ...adm, ov(G, STAFF), bot()],
      { topic: 'Daily consolidated GitHub activity for this PM team.', meta: { pmId: p.id } });
    const pmVoice = [HIDE, ov(R, VOICE), ov(U, VOICE), ...(adminPm ? [ov(A, VOICE)] : []), ov(G, VOICE), bot(true)];
    voice(KEYS.pmVoiceMeeting(p.id), 'Team Meeting', catKey, pmVoice);
    voice(KEYS.pmVoiceProject(p.id), 'Project Discussion', catKey, pmVoice);
  }

  // ---- IPDC SUPPORT ----
  cat('cat:support', STATIC_NAMES.catSupport, [HIDE, ov(I, READ, NO_POST), ov(A, STAFF), ov(G, STAFF), bot()]);
  text('ch:support-center', 'support-center', 'cat:support', [HIDE, ov(I, READ, NO_POST), ov(A, STAFF), ov(G, STAFF), bot()], { topic: 'Open a support ticket.' });
  voice('vc:support-voice', 'Support Voice', 'cat:support', [HIDE, ov(A, VOICE), ov(G, VOICE), bot(true)]);

  // ---- SUPPORT TICKETS ----
  cat('cat:tickets', STATIC_NAMES.catTickets, [HIDE, ov(A, STAFF), ov(G, STAFF), bot()]);

  // ---- ADMIN CONTROL ----
  const gridOnly = [HIDE, ov(G, STAFF), bot()];
  cat('cat:admin', STATIC_NAMES.catAdmin, gridOnly);
  text('ch:admin-panel', 'admin-panel', 'cat:admin', gridOnly, { topic: 'Private bot Admin Panel (IPDC GRID).' });
  text('ch:server-monitoring', 'server-monitoring', 'cat:admin', gridOnly, { topic: 'Server-wide monitoring dashboard (IPDC GRID).' });
  text('ch:admin-approvals', 'admin-approvals', 'cat:admin', [HIDE, ov(A, STAFF), ov(G, STAFF), bot()], { topic: 'PM applications and cross-PM transfer approvals.' });
  text('ch:admin-audit-logs', 'admin-audit-logs', 'cat:admin', gridOnly, { topic: 'Bot, server configuration and workflow audit trail.' });
  voice('vc:admin-meeting', 'Admin Meeting', 'cat:admin', [HIDE, ov(G, VOICE), bot(true)]);
  voice('vc:pm-coordination', 'PM Coordination', 'cat:admin', [HIDE, ov(G, VOICE), bot(true)]);

  return items;
}

export const CHANNEL_TYPES = {
  category: ChannelType.GuildCategory,
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  forum: ChannelType.GuildForum,
};
export { OverwriteType };
