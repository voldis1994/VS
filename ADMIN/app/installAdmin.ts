/**
 * ADMIN install orchestration — used by Windows INSTALL_ADMIN.bat and Linux INSTALL_ADMIN.
 * Discovers VS-CORE-01, ensures keys, enrolls device, verifies real ADMIN_SNAPSHOT.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { discoverVsServer } from '../connection/discoverServer.js';
import {
  ensureDeviceKeys,
  completeAdminEnrollment,
  createAdminEnrollment,
  replaceLostAdminDevice,
  renderAdminPeerWgConf,
  publicKeyFingerprint,
} from '../connection/enrollAdmin.js';
import { AdminConnectionClient } from '../connection/adminConnectionClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = join(__dirname, '..');
const REPO_ROOT = join(ADMIN_ROOT, '..');

export type InstallPaths = {
  dataDir: string;
  configDir: string;
  keysDir: string;
  connectionPath: string;
  controlPanelEnvPath: string;
  secureTokenPath: string;
  wgConfPath: string;
};

function defaultPaths(): InstallPaths {
  const dataDir =
    process.env.VS_ADMIN_DATA ||
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(ADMIN_ROOT, '.local'), 'VS', 'admin')
      : join(REPO_ROOT, 'data', 'vs-admin'));
  const configDir = join(ADMIN_ROOT, 'config');
  return {
    dataDir,
    configDir,
    keysDir: join(dataDir, 'keys'),
    connectionPath: join(configDir, 'admin.connection.json'),
    controlPanelEnvPath: join(configDir, 'control-panel.env'),
    secureTokenPath: join(dataDir, 'api-admin.token'),
    wgConfPath: join(dataDir, 'VS-ADMIN-01.conf'),
  };
}

function loadJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSecure(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }
}

function resolveAdminToken(paths: InstallPaths, fileCfg: Record<string, unknown>): string {
  const fromEnv = (process.env.API_ADMIN_TOKEN || process.env.VITE_API_ADMIN_TOKEN || '').trim();
  if (fromEnv && fromEnv !== 'CHANGE_ME_ADMIN_TOKEN') return fromEnv;
  if (existsSync(paths.secureTokenPath)) {
    const t = readFileSync(paths.secureTokenPath, 'utf8').trim();
    if (t) return t;
  }
  const fromFile = String(fileCfg.adminToken || '').trim();
  if (fromFile && fromFile !== 'CHANGE_ME_ADMIN_TOKEN') return fromFile;
  // Token files from USB / Desktop (Windows)
  const candidates = [
    join(ADMIN_ROOT, 'ADMIN_TOKEN.txt'),
    join(REPO_ROOT, 'ADMIN_TOKEN.txt'),
    process.env.USERPROFILE
      ? join(process.env.USERPROFILE, 'Desktop', 'ADMIN_TOKEN.txt')
      : '',
    process.env.USERPROFILE
      ? join(process.env.USERPROFILE, 'Desktop', 'VS-USB', 'ADMIN_TOKEN.txt')
      : '',
  ].filter(Boolean);
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const text = readFileSync(c, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*API_ADMIN_TOKEN\s*=\s*(.+)\s*$/i);
      if (m) return m[1].trim();
    }
  }
  return '';
}

async function enrollOrReuse(
  baseUrl: string,
  adminToken: string,
  publicKey: string,
  existing: Record<string, unknown>,
  enrollmentCodeHint: string
): Promise<{
  device_id: string;
  device_token: string;
  private_address?: string;
  server_public_key?: string | null;
  wg_endpoint?: string | null;
}> {
  const existingToken = String(existing.device_token || '').trim();
  const existingId = String(existing.device_id || 'VS-ADMIN-01');
  if (existingToken) {
    // Verify device auth still works
    try {
      const res = await fetch(`${baseUrl}/api/v1/network/device/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_id: existingId, device_token: existingToken }),
      });
      if (res.ok) {
        return { device_id: existingId, device_token: existingToken };
      }
    } catch {
      /* re-enroll below */
    }
  }

  let code = enrollmentCodeHint || String(existing.enrollment_code || '').trim();
  if (!code) {
    try {
      const created = await createAdminEnrollment({
        baseUrl,
        adminToken,
        device_id: 'VS-ADMIN-01',
      });
      code = created.enrollment_code;
    } catch {
      // Device may already be registered — issue replacement enrollment
      const lost = await replaceLostAdminDevice({
        baseUrl,
        adminToken,
        device_id: 'VS-ADMIN-01',
      });
      code = lost.enrollment_code;
    }
  }

  if (!code) throw new Error('NO_ENROLLMENT_CODE');

  try {
    const done = await completeAdminEnrollment({
      baseUrl,
      enrollment_code: code,
      public_key: publicKey,
      device_name: 'VS-ADMIN-01',
    });
    return {
      device_id: done.device_id,
      device_token: done.device_token,
      private_address: done.private_address,
      server_public_key: done.server_public_key,
      wg_endpoint: done.wg_endpoint,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('DEVICE_ID_EXISTS') || msg.includes('PUBLIC_KEY_EXISTS')) {
      const lost = await replaceLostAdminDevice({
        baseUrl,
        adminToken,
        device_id: 'VS-ADMIN-01',
      });
      const done = await completeAdminEnrollment({
        baseUrl,
        enrollment_code: lost.enrollment_code,
        public_key: publicKey,
        device_name: 'VS-ADMIN-01',
      });
      return {
        device_id: done.device_id,
        device_token: done.device_token,
        private_address: done.private_address,
        server_public_key: done.server_public_key,
        wg_endpoint: done.wg_endpoint,
      };
    }
    throw e;
  }
}

export async function runAdminInstall(): Promise<number> {
  const paths = defaultPaths();
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.keysDir, { recursive: true });

  console.log('VS ADMIN INSTALL');
  console.log(`DATA=${paths.dataDir}`);

  const existing = loadJson(paths.connectionPath);
  const keys = ensureDeviceKeys(paths.keysDir);
  console.log(`DEVICE_KEY fp=${publicKeyFingerprint(keys.publicKey)}`);

  const discovered = await discoverVsServer({
    expectedServerId: 'VS-CORE-01',
    candidates: existing.baseUrl ? [String(existing.baseUrl)] : undefined,
  });
  if (!discovered) {
    console.error('FAIL: could not discover VS-CORE-01 on LAN or WireGuard (10.77.0.1)');
    console.error('  Ensure i3 SERVER is running: [i3] sudo bash SERVER/STATUS_SERVER');
    console.error('  Same Wi-Fi as MSI, or WireGuard tunnel up');
    return 1;
  }
  const baseUrl = discovered.baseUrl;
  console.log(`DISCOVERED ${baseUrl} via=${discovered.via} server_id=${discovered.server_id || '?'}`);

  const adminToken = resolveAdminToken(paths, existing);
  if (!adminToken) {
    console.error('FAIL: API_ADMIN_TOKEN required');
    console.error('  On i3: sudo grep API_ADMIN_TOKEN /var/lib/vs-server/server.env');
    console.error('  Or place ADMIN_TOKEN.txt next to INSTALL_ADMIN.bat / on Desktop');
    console.error('  Format: API_ADMIN_TOKEN=<token>');
    return 1;
  }
  writeSecure(paths.secureTokenPath, adminToken + '\n');

  let enroll: Awaited<ReturnType<typeof enrollOrReuse>>;
  try {
    enroll = await enrollOrReuse(
      baseUrl,
      adminToken,
      keys.publicKey,
      existing,
      (process.env.VS_ENROLLMENT_CODE || '').trim()
    );
    console.log(`ENROLLED device_id=${enroll.device_id}`);
  } catch (e) {
    console.error('FAIL: enrollment', e instanceof Error ? e.message : e);
    return 1;
  }

  if (enroll.private_address && enroll.server_public_key && enroll.wg_endpoint) {
    const conf = renderAdminPeerWgConf({
      privateKey: keys.privateKey,
      privateAddress: enroll.private_address,
      serverPublicKey: enroll.server_public_key,
      endpoint: enroll.wg_endpoint,
    });
    writeSecure(paths.wgConfPath, conf);
    console.log(`WIREGUARD_CONF ${paths.wgConfPath} (import for remote access)`);
  }

  const connection = {
    server_id: discovered.server_id || 'VS-CORE-01',
    device_id: enroll.device_id || 'VS-ADMIN-01',
    baseUrl,
    adminToken: '', // never store plaintext token in JSON if we have secure path
    device_token: enroll.device_token,
    enrollment_code: '',
    note: 'Tokens live under data dir; Control Panel reads control-panel.env',
  };
  writeSecure(paths.connectionPath, JSON.stringify(connection, null, 2) + '\n');

  // Rewrite with adminToken empty intentionally — put token only in env + secure file
  const envLines = [
    `# VS Control Panel → i3 SERVER (generated by INSTALL_ADMIN — do not commit)`,
    `VS_SERVER_URL=${baseUrl}`,
    `VITE_API_URL=${baseUrl}`,
    `VITE_WS_URL=${baseUrl.replace(/^http/, 'ws')}/ws`,
    `API_ADMIN_TOKEN=${adminToken}`,
    `VITE_API_ADMIN_TOKEN=${adminToken}`,
    `VS_DEVICE_ID=${enroll.device_id}`,
    '',
  ];
  writeSecure(paths.controlPanelEnvPath, envLines.join('\n'));

  const client = new AdminConnectionClient({ baseUrl, adminToken, timeoutMs: 8000 });
  const snap = await client.fetchSnapshot();
  const st = client.getStatus();
  if (st.state !== 'CONNECTED' || !snap) {
    console.error('FAIL: authenticated ADMIN_SNAPSHOT failed');
    console.error(`  state=${st.state} error=${st.last_error || 'none'}`);
    return 1;
  }

  console.log('');
  console.log('VS ADMIN INSTALLED');
  console.log(`SERVER: ${snap.server_id || discovered.server_id || 'VS-CORE-01'}`);
  console.log('CONNECTION: CONNECTED');
  console.log(`SNAPSHOT: ok core=${snap.core?.state || 'NO_DATA'}`);
  console.log('');
  console.log('Next: START_ADMIN.bat  (opens Control Panel → real i3 API)');
  return 0;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('installAdmin.ts') || process.argv[1].endsWith('installAdmin.js'));

if (isMain) {
  runAdminInstall()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('FAIL', e);
      process.exit(1);
    });
}
