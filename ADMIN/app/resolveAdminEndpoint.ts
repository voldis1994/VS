/**
 * Resolve ADMIN → VS-CORE-01 endpoint (LAN-first).
 * Prints machine-readable lines for PowerShell START/STATUS helpers.
 *
 * Usage: npx tsx app/resolveAdminEndpoint.ts
 *
 * Windows: never call process.exit() immediately after fetch — that triggers
 * libuv UV_HANDLE_CLOSING. Set process.exitCode and let the event loop drain.
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { discoverVsServer, isWireGuardUrl } from '../connection/discoverServer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = join(__dirname, '..');
const REPO_ROOT = join(ADMIN_ROOT, '..');

function dataDir(): string {
  return (
    process.env.VS_ADMIN_DATA ||
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(ADMIN_ROOT, '.local'), 'VS', 'admin')
      : join(REPO_ROOT, 'data', 'vs-admin'))
  );
}

function readSavedUrls(): string[] {
  const out: string[] = [];
  const connPath = join(ADMIN_ROOT, 'config', 'admin.connection.json');
  const envPath = join(ADMIN_ROOT, 'config', 'control-panel.env');
  if (existsSync(connPath)) {
    try {
      const j = JSON.parse(readFileSync(connPath, 'utf8')) as { baseUrl?: string };
      if (j.baseUrl) out.push(j.baseUrl);
    } catch {
      /* ignore */
    }
  }
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(VS_SERVER_URL|VITE_API_URL|VS_LAN_SERVER_URL)=(.*)$/);
      if (m) out.push(m[2].trim());
    }
  }
  return out;
}

function wgProfileConfigured(): boolean {
  if (process.env.VS_ADMIN_TRANSPORT === 'wireguard') return true;
  if (process.env.VS_ADMIN_ALLOW_WIREGUARD === '1') return true;
  const conf = join(dataDir(), 'VS-ADMIN-01.conf');
  return existsSync(conf);
}

async function main(): Promise<number> {
  const saved = readSavedUrls();
  const allowWg = wgProfileConfigured();
  const hit = await discoverVsServer({
    expectedServerId: 'VS-CORE-01',
    lanCandidates: saved.filter((u) => !isWireGuardUrl(u)),
    allowWireGuard: allowWg,
    wireguardCandidates: saved.filter((u) => isWireGuardUrl(u)),
  });

  if (!hit) {
    console.log('OK=0');
    console.log('ERROR=SERVER_UNREACHABLE');
    console.log(
      allowWg
        ? 'HINT=LAN down and WireGuard profile did not reach 10.77.0.1'
        : 'HINT=Could not reach VS-CORE-01 on LAN — check i3 STATUS_SERVER / same Wi-Fi (WireGuard not required for home ADMIN)'
    );
    return 1;
  }

  console.log('OK=1');
  console.log(`SERVER_URL=${hit.baseUrl}`);
  console.log(`TRANSPORT=${hit.via === 'lan' ? 'LAN' : 'WIREGUARD'}`);
  console.log(`SERVER_ID=${hit.server_id || 'VS-CORE-01'}`);
  return 0;
}

main()
  .then((c) => {
    process.exitCode = c;
  })
  .catch((e) => {
    console.log('OK=0');
    console.log(`ERROR=${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
