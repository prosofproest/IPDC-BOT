// Authorization matrix (spec section 14). These checks run in interaction handlers;
// Discord permission overwrites are the second, independent layer.
export function roleIdsOf(member) {
  if (!member) return [];
  if (Array.isArray(member.roleIds)) return member.roleIds;
  if (member.roles?.cache) return [...member.roles.cache.keys()];
  if (Array.isArray(member.roles)) return member.roles;
  return [];
}

export function makeActor(member, userId) {
  return { userId: userId ?? member?.id ?? member?.user?.id, roleIds: roleIdsOf(member) };
}

export class Auth {
  constructor({ ids, getSettings }) { this.ids = ids; this.getSettings = getSettings; }

  isGrid(actor) { return actor.roleIds.includes(this.ids.grid); }
  isAdminRole(actor) { return actor.roleIds.includes(this.ids.admin); }
  isIpdc(actor) { return !!this.ids.ipdc && actor.roleIds.includes(this.ids.ipdc); }
  isPmOf(actor, pm) { return !!pm && actor.userId === pm.discordUserId; }

  async isStaff(actor) {
    if (this.isGrid(actor) || this.isAdminRole(actor)) return true;
    const s = await this.getSettings();
    return (s.supportRoleIds || []).some((r) => actor.roleIds.includes(r));
  }

  /**
   * can(action, actor, ctx) -> boolean
   * ctx.pm is the PM record the action concerns, where relevant.
   */
  async can(action, actor, ctx = {}) {
    if (action === 'assign.grid' || action === 'assign.admin') return false; // never by the bot
    if (this.isGrid(actor)) return true;
    const adminGranted = this.isAdminRole(actor) && ((await this.getSettings()).adminGrants || []).includes(action);
    switch (action) {
      case 'admin.panel':
      case 'monitoring.view':
      case 'config.manage':
      case 'resource.manage':
        return adminGranted;
      case 'application.approve.initial':
      case 'teamchange.approve':
        return this.isPmOf(actor, ctx.pm) || adminGranted;
      case 'application.approve.pm':
      case 'transfer.approve':
        return this.isAdminRole(actor);
      case 'ticket.manage':
        return this.isStaff(actor);
      case 'ticket.create':
        return this.isIpdc(actor);
      case 'repo.change':
        return this.isPmOf(actor, ctx.pm) || adminGranted;
      case 'pm.panel':
        return this.isPmOf(actor, ctx.pm);
      case 'audit.view':
        return this.isAdminRole(actor) || this.isPmOf(actor, ctx.pm);
      default:
        return false;
    }
  }
}

// Roles the bot is never allowed to add or remove through any workflow.
export function protectedRoleIds(ids) { return new Set([ids.grid, ids.admin]); }
