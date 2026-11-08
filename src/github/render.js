import path from 'node:path';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { ROOT } from '../ui.js';
import { dayKeyIST } from '../utils/misc.js';

let fontsReady = false;
function fonts() {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(path.join(ROOT, 'assets/fonts/DejaVuSans.ttf'), 'IPDC Sans');
  GlobalFonts.registerFromPath(path.join(ROOT, 'assets/fonts/DejaVuSans-Bold.ttf'), 'IPDC Sans Bold');
  fontsReady = true;
}

const COLORS = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'];
export const levelOf = (n, max) => (n <= 0 ? 0 : max <= 4 ? Math.min(4, n) : Math.min(4, Math.ceil((n / max) * 4)));

/** Build the list of `weeks`*7 day keys ending today (IST), aligned so each column is a week starting Sunday. */
export function gridDays(weeks, now = new Date()) {
  const end = new Date(`${dayKeyIST(now)}T00:00:00Z`);
  const dow = end.getUTCDay();
  const start = new Date(end.getTime() - ((weeks - 1) * 7 + dow) * 86400000);
  const days = [];
  for (let i = 0; i < weeks * 7; i++) { const d = new Date(start.getTime() + i * 86400000); days.push(d > end ? null : d.toISOString().slice(0, 10)); }
  return days;
}

/**
 * rows: [{ label, sub, total, counts: Map<dateKey,count> }]. Returns a PNG Buffer.
 * Green contribution cells on a dark canvas, one block per member.
 */
export function renderHeatmaps(rows, { weeks = 20, title = 'IPDC Contribution Heatmaps', note = '' } = {}) {
  fonts();
  const cell = 12; const gap = 3; const step = cell + gap; const labelW = 230; const pad = 24; const rowH = 7 * step + 26;
  const width = pad * 2 + labelW + weeks * step + 70; const headH = 64; const foot = 34;
  const height = headH + Math.max(1, rows.length) * rowH + foot;
  const c = createCanvas(width, height); const g = c.getContext('2d');
  g.fillStyle = '#0d1117'; g.fillRect(0, 0, width, height);
  g.fillStyle = '#e6edf3'; g.font = '20px "IPDC Sans Bold"'; g.fillText(title, pad, 36);
  g.fillStyle = '#8b949e'; g.font = '12px "IPDC Sans"'; g.fillText(`Last ${weeks} weeks  |  green = more GitHub activity`, pad, 54);
  const days = gridDays(weeks);
  let max = 0; for (const r of rows) for (const v of r.counts.values()) max = Math.max(max, v);
  rows.forEach((r, idx) => {
    const y0 = headH + idx * rowH;
    g.fillStyle = idx % 2 ? '#0d1117' : '#10161d'; g.fillRect(0, y0, width, rowH);
    g.fillStyle = '#e6edf3'; g.font = '15px "IPDC Sans Bold"'; g.fillText(clip(g, r.label, labelW - 16), pad, y0 + 30);
    g.fillStyle = '#8b949e'; g.font = '12px "IPDC Sans"'; g.fillText(clip(g, r.sub || '', labelW - 16), pad, y0 + 50);
    g.fillStyle = '#39d353'; g.font = '12px "IPDC Sans Bold"'; g.fillText(`${r.total} contributions`, pad, y0 + 70);
    days.forEach((d, i) => {
      if (!d) return;
      const col = Math.floor(i / 7); const rowi = i % 7;
      g.fillStyle = COLORS[levelOf(r.counts.get(d) || 0, max)];
      g.beginPath(); g.roundRect(pad + labelW + col * step, y0 + 12 + rowi * step, cell, cell, 2); g.fill();
    });
  });
  if (!rows.length) { g.fillStyle = '#8b949e'; g.font = '14px "IPDC Sans"'; g.fillText('No members with a linked GitHub account yet.', pad, headH + 40); }
  g.fillStyle = '#6e7681'; g.font = '11px "IPDC Sans"'; g.fillText(note || 'Activity counts are evidence of GitHub activity, not a productivity score.', pad, height - 12);
  return c.toBuffer('image/png');
}

function clip(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let t = text; while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
