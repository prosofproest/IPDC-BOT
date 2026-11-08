// Imports every source module to catch broken imports/exports without needing credentials.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(new URL('../src', import.meta.url).pathname);
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') && files.push(p); } })(root);
let bad = 0;
for (const f of files) {
  if (f.endsWith('/index.js') && f === join(root, 'index.js')) continue; // entrypoint starts the bot
  try { await import(pathToFileURL(f).href); } catch (e) { bad++; console.error(`IMPORT FAIL ${f}: ${e.message}`); }
}
console.log(`${files.length - 1} modules imported, ${bad} failures`);
process.exit(bad ? 1 : 0);
