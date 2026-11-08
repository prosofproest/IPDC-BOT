import crypto from 'node:crypto';
import http from 'node:http';
import { createLogger } from './utils/logger.js';

const log = createLogger('http');
const MAX_BODY = 1_000_000;

export function verifySignature(secret, rawBody, header) {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const got = Buffer.from(header);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

export function startHttp(ctx) {
  const { port, } = ctx.cfg.http; const secret = ctx.cfg.github.webhookSecret;
  if (!port) { log.info('HTTP server disabled (no PORT set)'); return null; }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, ready: ctx.client.isReady() })); }
      if (req.method === 'POST' && req.url === '/github/webhook') {
        if (!secret) { res.writeHead(404); return res.end(); }
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413); return res.end(); } chunks.push(c); }
        const raw = Buffer.concat(chunks);
        if (!verifySignature(secret, raw, req.headers['x-hub-signature-256'])) { log.warn('webhook signature rejected'); res.writeHead(401); return res.end(); }
        res.writeHead(202); res.end();
        const event = req.headers['x-github-event']; const body = JSON.parse(raw.toString('utf8'));
        await handleEvent(ctx, event, body);
        return;
      }
      res.writeHead(404); res.end();
    } catch (e) { log.error('http handler failed', e); try { res.writeHead(500); res.end(); } catch { /* closed */ } }
  });
  server.listen(port, () => log.info(`HTTP listening on :${port}${secret ? ' (GitHub webhook enabled)' : ''}`));
  return server;
}

export async function handleEvent(ctx, event, body) {
  if (!['push', 'pull_request', 'create', 'delete'].includes(event)) return 0;
  const full = body.repository?.full_name?.toLowerCase(); if (!full) return 0;
  let n = 0;
  for (const pm of await ctx.state.pms()) {
    if (pm.repo && `${pm.repo.owner}/${pm.repo.name}`.toLowerCase() === full) {
      ctx.github.invalidate(pm.repo.owner, pm.repo.name);
      ctx.monitoring.scheduleRefreshPm(pm.id); n++;
    }
  }
  if (n) log.info(`webhook ${event} scheduled refresh for ${n} PM team(s)`);
  return n;
}
