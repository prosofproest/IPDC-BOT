import { MessageFlags } from 'discord.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('router');

export class Router {
  constructor() { this.maps = { button: new Map(), select: new Map(), modal: new Map(), command: new Map() }; this.ctx = null; }
  button(key, fn) { this.maps.button.set(key, fn); }
  select(key, fn) { this.maps.select.set(key, fn); }
  modal(key, fn) { this.maps.modal.set(key, fn); }
  command(name, fn) { this.maps.command.set(name, fn); }

  _find(map, customId) {
    const parts = customId.split(':');
    for (let n = Math.min(3, parts.length); n >= 1; n--) {
      const key = parts.slice(0, n).join(':');
      if (map.has(key)) return { fn: map.get(key), args: parts.slice(n) };
    }
    return null;
  }

  async dispatch(i) {
    try {
      let found = null;
      if (i.isChatInputCommand()) { const fn = this.maps.command.get(i.commandName); if (fn) found = { fn, args: [] }; }
      else if (i.isButton()) found = this._find(this.maps.button, i.customId);
      else if (i.isAnySelectMenu()) found = this._find(this.maps.select, i.customId);
      else if (i.isModalSubmit()) found = this._find(this.maps.modal, i.customId);
      if (!found) return;
      await found.fn(i, found.args, this.ctx);
    } catch (e) {
      log.error(`interaction failed (${i.customId || i.commandName})`, e);
      const msg = { content: 'Something went wrong while handling that action. The incident was logged. Please try again or open a support ticket.', flags: MessageFlags.Ephemeral };
      try {
        if (i.deferred && !i.replied) {
          await i.editReply(msg);
          i.replied = true;
        } else if (i.replied || i.deferred) {
          await i.followUp(msg);
        } else {
          await i.reply(msg);
          i.replied = true;
        }
      } catch { /* interaction expired */ }
    }
  }
}

// Ephemeral reply helper that works whether or not the interaction was already acknowledged.
export async function say(i, content, extra = {}) {
  const payload = typeof content === 'string' ? { content, ...extra } : { ...content, ...extra };
  payload.flags = MessageFlags.Ephemeral;
  if (i.deferred && !i.replied) {
    const res = await i.editReply({ ...payload, flags: undefined });
    i.replied = true;
    return res;
  }
  if (i.replied || i.deferred) return i.followUp(payload);
  const res = await i.reply(payload);
  i.replied = true;
  return res;
}
