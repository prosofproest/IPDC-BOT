import { DEFAULT_ADMIN_ROLE_ID, DEFAULT_GRID_ROLE_ID } from './constants.js';

const REQUIRED = [
  'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID',
  'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY',
  'GEMINI_API_KEY', 'GROQ_API_KEY',
];
const PLACEHOLDER = /^replace_/i;

// Parse private keys safely: hosts often store newlines as literal "\n" and may wrap in quotes.
export function normalizePrivateKey(raw) {
  if (!raw) return raw;
  let k = String(raw).trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1);
  return k.replace(/\\n/g, '\n');
}

const present = (v) => !!v && !PLACEHOLDER.test(v.trim());
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };

export function loadConfig(env = process.env, { strict = true } = {}) {
  const missing = REQUIRED.filter((k) => !present(env[k]));
  if (strict && missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}. See .env.example and README.md.`);
  }
  const githubApp = present(env.GITHUB_APP_ID) && present(env.GITHUB_APP_PRIVATE_KEY) && present(env.GITHUB_INSTALLATION_ID);
  const githubToken = present(env.GITHUB_TOKEN);
  const smtp = present(env.SMTP_HOST) && present(env.SMTP_USER) && present(env.SMTP_PASS) && present(env.SMTP_FROM);
  return {
    discord: { token: env.DISCORD_TOKEN, clientId: env.DISCORD_CLIENT_ID, guildId: env.DISCORD_GUILD_ID },
    roles: {
      grid: env.GRID_ROLE_ID || DEFAULT_GRID_ROLE_ID,
      admin: env.ADMIN_ROLE_ID || DEFAULT_ADMIN_ROLE_ID,
      ipdc: present(env.IPDC_ROLE_ID) ? env.IPDC_ROLE_ID : null, // optional: otherwise found/created by name
    },
    firebase: {
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: normalizePrivateKey(env.FIREBASE_PRIVATE_KEY),
    },
    ai: {
      geminiKey: env.GEMINI_API_KEY, groqKey: env.GROQ_API_KEY,
      geminiModel: env.GEMINI_MODEL || 'gemini-2.5-flash',
      groqModel: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      timeoutMs: int(env.AI_TIMEOUT_MS, 8000),
    },
    github: {
      enabled: githubApp || githubToken,
      appId: env.GITHUB_APP_ID,
      privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
      installationId: env.GITHUB_INSTALLATION_ID,
      token: githubToken ? env.GITHUB_TOKEN : null,
      webhookSecret: present(env.GITHUB_WEBHOOK_SECRET) ? env.GITHUB_WEBHOOK_SECRET : null,
    },
    smtp: {
      enabled: smtp,
      host: env.SMTP_HOST, port: int(env.SMTP_PORT, 587), user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM,
      recipients: list(present(env.REPORT_RECIPIENT_EMAIL) ? env.REPORT_RECIPIENT_EMAIL : ''),
    },
    cloudinary: { enabled: present(env.CLOUDINARY_CLOUD_NAME) && present(env.CLOUDINARY_API_KEY) && present(env.CLOUDINARY_API_SECRET) },
    http: { port: int(env.PORT || env.SERVER_PORT, 0) }, // 0 = HTTP server disabled unless webhook secret is set
    logLevel: env.LOG_LEVEL || 'info',
    tz: 'Asia/Kolkata',
    cocFile: env.CODE_OF_CONDUCT_FILE || 'config/code-of-conduct.txt',
    missing,
  };
}
