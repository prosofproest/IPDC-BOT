import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { BRAND } from './config/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const LOGO_PATH = path.join(ROOT, 'assets', BRAND.logoFile);

let logoBuf = null;
// The supplied logo is used byte-for-byte; it is never redrawn, recolored or cropped.
export function logoAttachment() {
  logoBuf ??= fs.readFileSync(LOGO_PATH);
  return new AttachmentBuilder(logoBuf, { name: BRAND.logoAttachmentName });
}
export const LOGO_URL = `attachment://${BRAND.logoAttachmentName}`;

export const FOOTER = `${BRAND.name}`;

export function embed({ title, description, color = BRAND.color, footer = FOOTER, fields, timestamp = false } = {}) {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  if (fields?.length) e.addFields(fields);
  if (footer) e.setFooter({ text: footer });
  if (timestamp) e.setTimestamp();
  return e;
}
export const okEmbed = (description, title = 'Done') => embed({ title, description, color: BRAND.accent });
export const errEmbed = (description, title = 'Unable to continue') => embed({ title, description, color: 0xcf222e });

export const button = (customId, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
export const row = (...components) => new ActionRowBuilder().addComponents(...components);

export function disabledRows(rows) {
  return rows.map((r) => {
    const json = r.toJSON ? r.toJSON() : r;
    const rr = new ActionRowBuilder();
    for (const c of json.components) { if (c.type === 2 && c.style !== 5) rr.addComponents(ButtonBuilder.from(c).setDisabled(true)); }
    return rr;
  }).filter((r) => r.components.length);
}

// Split text into Discord-safe chunks WITHOUT altering any character (used for the verbatim Code of Conduct).
export function chunkVerbatim(text, max = 4000) {
  const out = []; let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest.length) out.push(rest);
  return out;
}

export function bar(value, max, width = 12) {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}
