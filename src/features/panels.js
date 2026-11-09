import { createLogger } from '../utils/logger.js';
import { KEYS } from '../core/structure.js';
import { embed } from '../ui.js';
import { adminPanelPayload } from './admin.js';
import { pmPanelPayload } from './pm.js';
import { supportPanelPayload } from './support.js';
import { welcomeEntryPayload } from './onboarding.js';
import { provisionPmWorkspace } from '../core/workspace.js';

const log = createLogger('panels');
const placeholder = (title) => ({ embeds: [embed({ title, description: 'Awaiting the first scheduled update. This message is edited in place daily at 9:00 PM IST.' })] });

// Long-lived interactive panels. Each is ONE persisted message that is edited, never duplicated.
export class Panels {
  constructor(ctx) { this.ctx = ctx; }

  async ensureAll() {
    const { messages, state } = this.ctx; const s = await state.settings();
    await messages.ensure('panel:welcome', 'ch:welcome', welcomeEntryPayload());
    await messages.ensure('panel:support', 'ch:support-center', supportPanelPayload(s.supportCategories));
    await messages.ensure('panel:admin', 'ch:admin-panel', adminPanelPayload());
    for (const pm of await state.pms()) {
      try {
        await provisionPmWorkspace(this.ctx, pm.id, { welcome: false });
      } catch (e) {
        log.warn(`workspace auto-provision for ${pm.name} failed: ${e.message}`);
        await messages.ensure(`pm:${pm.id}:panel`, KEYS.pmControl(pm.id), pmPanelPayload(pm));
        await messages.ensure(`pm:${pm.id}:dash`, KEYS.pmActivity(pm.id), placeholder(`GITHUB ACTIVITY — ${pm.name}`), { refresh: false });
      }
    }
    // dashboards: created once as placeholders, then edited by the monitoring job
    const ph = [['dash:heatmap', 'ch:github-contributions', 'GITHUB CONTRIBUTION HEATMAPS'], ['dash:leaderboard', 'ch:contribution-leaderboard', 'CONTRIBUTION LEADERBOARD'],
      ['dash:server-activity', 'ch:server-activity', 'SERVER ACTIVITY'], ['dash:challenges', 'ch:github-challenges', 'GITHUB CHALLENGES'], ['dash:monitoring:0', 'ch:server-monitoring', 'SERVER MONITORING']];
    for (const [k, ch, t] of ph) await messages.ensure(k, ch, placeholder(t), { refresh: false });
    log.info('panels ensured');
  }

  async refresh(name) {
    const { messages, state } = this.ctx;
    if (name === 'support') return messages.ensure('panel:support', 'ch:support-center', supportPanelPayload((await state.settings()).supportCategories));
    if (name === 'challenges') return this.ctx.monitoring.refreshPm ? this.ctx.monitoring.refreshAll().catch((e) => log.warn('challenge refresh failed', e)) : null;
  }
  async refreshPm(pmId) {
    const pm = await this.ctx.state.getPm(pmId); if (!pm) return;
    return this.ctx.messages.ensure(`pm:${pmId}:panel`, KEYS.pmControl(pmId), pmPanelPayload(pm));
  }
  async refreshStructureDependent() { try { await this.ensureAll(); } catch (e) { log.warn('panel refresh after structure change failed', e); } }
}
