import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const newId = () => crypto.randomBytes(5).toString('hex');
export const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

// Discord-style channel slug: lowercase, hyphen separated, ascii.
export function slugify(name) {
  return String(name)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s_-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 90) || 'unnamed';
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export async function retry(fn, { attempts = 3, baseMs = 400, shouldRetry = () => true } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (i === attempts - 1 || !shouldRetry(e)) break;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Run async tasks with limited concurrency, preserving order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export function dayKeyIST(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function fmtIST(date) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(date)) + ' IST';
}

export function parseGithubUsername(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/?(?:[?#].*)?$/i);
  if (!m) return null;
  const u = m[1];
  if (u.endsWith('-') || u.includes('--')) return null;
  const reserved = new Set(['orgs', 'settings', 'login', 'about', 'pricing', 'features', 'topics', 'marketplace', 'sponsors', 'explore', 'notifications']);
  if (reserved.has(u.toLowerCase())) return null;
  return u;
}

export function parseRepoRef(input) {
  if (!input) return null;
  const s = String(input).trim().replace(/\.git$/i, '');
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)\/?(?:[?#/].*)?$/i);
  if (!m) m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}
