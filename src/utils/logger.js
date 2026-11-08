// Minimal structured logger with secret redaction. Never logs raw env or private keys.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_ENV_KEYS = [
  'DISCORD_TOKEN', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'GEMINI_API_KEY', 'GROQ_API_KEY',
  'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'SMTP_PASS', 'SMTP_USER',
  'CLOUDINARY_API_SECRET', 'CLOUDINARY_API_KEY',
];
let secrets = [];

export function refreshSecrets(env = process.env) {
  secrets = [];
  for (const k of SECRET_ENV_KEYS) {
    const v = env[k];
    if (!v || v.length < 6) continue;
    secrets.push(v);
    if (v.includes('\\n')) secrets.push(v.replace(/\\n/g, '\n'));
    if (v.includes('\n')) secrets.push(v.replace(/\n/g, '\\n'));
  }
  secrets.sort((a, b) => b.length - a.length);
}
refreshSecrets();

export function redact(input) {
  let s = typeof input === 'string' ? input : safeStringify(input);
  for (const sec of secrets) if (sec && s.includes(sec)) s = s.split(sec).join('[REDACTED]');
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  s = s.replace(/\b[MN][A-Za-z\d_-]{23,27}\.[\w-]{6}\.[\w-]{27,}\b/g, '[REDACTED_DISCORD_TOKEN]');
  s = s.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]');
  return s;
}

function safeStringify(v) {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try { return JSON.stringify(v); } catch { return String(v); }
}

let threshold = LEVELS.info;
export function setLogLevel(level) { threshold = LEVELS[level] ?? LEVELS.info; }

function emit(level, scope, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), scope ? `[${scope}]` : '', redact(msg)];
  if (meta !== undefined) parts.push(redact(meta instanceof Error ? `${meta.name}: ${meta.message}` : meta));
  const line = parts.filter(Boolean).join(' ');
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export function createLogger(scope = '') {
  return {
    debug: (m, x) => emit('debug', scope, m, x),
    info: (m, x) => emit('info', scope, m, x),
    warn: (m, x) => emit('warn', scope, m, x),
    error: (m, x) => emit('error', scope, m, x),
    child: (s) => createLogger(scope ? `${scope}:${s}` : s),
  };
}
