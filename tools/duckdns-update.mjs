/**
 * DuckDNS IP updater — keeps vs-system.duckdns.org pointed at this PC's public IP.
 *
 * Env (from .env or process):
 *   DUCKDNS_TOKEN   — required (from duckdns.org account)
 *   DUCKDNS_DOMAIN  — vs-system.duckdns.org  OR  vs-system
 *   DUCKDNS_INTERVAL_SEC — default 300
 *
 * Disable: set PUBLIC_SHARE_MODE=cloudflare (or stop this window).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnv();

function subdomainFrom(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!s) return '';
  if (s.endsWith('.duckdns.org')) return s.slice(0, -'.duckdns.org'.length);
  return s.replace(/[^a-z0-9-]/g, '');
}

const token = String(process.env.DUCKDNS_TOKEN || '').trim();
const domain = subdomainFrom(process.env.DUCKDNS_DOMAIN || 'vs-system.duckdns.org');
const intervalSec = Math.max(60, Number(process.env.DUCKDNS_INTERVAL_SEC || 300) || 300);

if (!token || token === 'CHANGE_ME_DUCKDNS_TOKEN') {
  console.error('[duckdns] DUCKDNS_TOKEN missing in .env — get it from https://www.duckdns.org');
  process.exit(1);
}
if (!domain) {
  console.error('[duckdns] DUCKDNS_DOMAIN missing (e.g. vs-system.duckdns.org)');
  process.exit(1);
}

const host = `${domain}.duckdns.org`;

async function updateOnce() {
  const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(
    domain
  )}&token=${encodeURIComponent(token)}&ip=`;
  const res = await fetch(url);
  const text = (await res.text()).trim();
  const ok = text === 'OK';
  console.log(
    `[duckdns] ${new Date().toISOString()} ${host} → ${ok ? 'OK' : text || res.status}`
  );
  return ok;
}

console.log(`[duckdns] updating ${host} every ${intervalSec}s (Ctrl+C to stop)`);
console.log(`[duckdns] client URL: http://${host}:18080`);

let fails = 0;
async function tick() {
  try {
    const ok = await updateOnce();
    fails = ok ? 0 : fails + 1;
  } catch (e) {
    fails += 1;
    console.error(`[duckdns] error: ${e instanceof Error ? e.message : e}`);
  }
  if (fails >= 5) {
    console.error('[duckdns] 5 failures — check token / network. Still retrying…');
    fails = 0;
  }
}

await tick();
setInterval(() => void tick(), intervalSec * 1000);
