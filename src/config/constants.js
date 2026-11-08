// Fixed project constants. Role IDs come from the owner handoff and can be overridden by env.
export const DEFAULT_GRID_ROLE_ID = '1568690888413282396';
export const DEFAULT_ADMIN_ROLE_ID = '1568690393824891141';

export const BRAND = Object.freeze({
  name: 'INVICTUS PROJECT DEVELOPMENT CENTRE',
  short: 'IPDC',
  tagline: 'DEPTH CREATES ADVANTAGE',
  logoFile: 'IPDC_Official_Logo.png',
  logoAttachmentName: 'IPDC_Official_Logo.png',
  color: 0x1c1c1e,
  accent: 0x2ea043,
});

// Exact welcome copy from the master specification, section 3. Do not edit.
export const WELCOME_COPY = Object.freeze({
  title: 'WELCOME TO IPDC',
  description: 'Welcome, {member_mention}, to the INVICTUS PROJECT DEVELOPMENT CENTRE (IPDC).',
  body:
    'IPDC is a collaborative project development community where members come together to build, learn, share knowledge, and turn ideas into meaningful projects. We value commitment, teamwork, responsible participation, and continuous growth.',
  nextStep:
    'Before accessing the community, please review and accept the IPDC Code of Conduct. Your participation begins with understanding the standards that keep this community respectful, focused, and productive.',
  button: 'CONTINUE TO CODE OF CONDUCT',
  footer: 'INVICTUS PROJECT DEVELOPMENT CENTRE | Member Onboarding',
});

export const COC_BUTTONS = Object.freeze({
  accept: 'I AGREE — ACCEPT CODE OF CONDUCT',
  reject: 'I DO NOT AGREE',
});

export const COC_PLACEHOLDER_MARKER = '__REPLACE_WITH_OWNER_CODE_OF_CONDUCT__';

export const WELCOME_CHANNEL_TTL_MS = 10 * 60 * 1000;

export const SUPPORT_CATEGORIES_DEFAULT = Object.freeze([
  'Technical Support',
  'Role/Team Issues',
  'Resource Help',
  'Project Related',
  'Other',
]);

export const DEFAULT_SETTINGS = Object.freeze({
  inactivityDays: 7,
  supportCategories: [...SUPPORT_CATEGORIES_DEFAULT],
  supportRoleIds: [], // extra support staff roles (ADMIN + IPDC GRID are always staff)
  adminGrants: ['repo.change'], // extra permissions granted to the ADMIN role
  reportRecipients: [], // extra recipients on top of REPORT_RECIPIENT_EMAIL
  heatmapWeeks: 20,
  maxHeatmapMembersInline: 12,
  leaderboardDays: 30,
});

// Static structure names (no emojis, professional naming).
export const STATIC_NAMES = Object.freeze({
  catWelcome: 'WELCOME',
  catGeneral: 'GENERAL',
  catChallenges: 'CHALLENGES',
  catResources: 'IPDC RESOURCES',
  catSupport: 'IPDC SUPPORT',
  catTickets: 'SUPPORT TICKETS',
  catAdmin: 'ADMIN CONTROL',
});
