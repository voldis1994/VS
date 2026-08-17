/**
 * ADMIN install orchestration — used by Windows INSTALL_ADMIN.bat and Linux INSTALL_ADMIN.
 * Discovers VS-CORE-01 on LAN, authenticates with API_ADMIN_TOKEN, creates a FRESH
 * enrollment session, enrolls this device, verifies ADMIN API.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { discoverVsServer, isWireGuardUrl } from '../connection/discoverServer.js';
import {
  ensureDeviceKeys,
  renderAdminPeerWgConf,
  publicKeyFingerprint,
} from '../connection/enrollAdmin.js';
import {
  enrollAdminDevice,
  normalizeAdminSecret,
  verifyAdminToken,
  InstallStageError,
} from '../connection/installEnrollment.js';
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
  const fromEnv = normalizeAdminSecret(
    process.env.API_ADMIN_TOKEN || process.env.VITE_API_ADMIN_TOKEN || ''
  );
  if (fromEnv && fromEnv !== 'CHANGE_ME_ADMIN_TOKEN') return fromEnv;
  if (existsSync(paths.secureTokenPath)) {
    const t = normalizeAdminSecret(readFileSync(paths.secureTokenPath, 'utf8'));
    if (t) return t;
  }
  const fromFile = normalizeAdminSecret(String(fileCfg.adminToken || ''));
  if (fromFile && fromFile !== 'CHANGE_ME_ADMIN_TOKEN') return fromFile;
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
      if (m) return normalizeAdminSecret(m[1]);
    }
  }
  return '';
}

function stage(name: string, detail?: string): void {
  if (detail) console.log(`${name}: ${detail}`);
  else console.log(name);
}

/**
 * Windows Node/libuv: abrupt process.exit while fetch sockets close triggers
 * UV_HANDLE_CLOSING assertions. Delay a single exit after setting exitCode.
 */
function exitOnce(code: number): void {
  if ((globalThis as { __vsAdminExiting?: boolean }).__vsAdminExiting) return;
  (globalThis as { __vsAdminExiting?: boolean }).__vsAdminExiting = true;
  process.exitCode = code;
  setTimeout(() => {
    process.exit(code);
  }, process.platform === 'win32' ? 200 : 50);
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

  const allowWireGuard =
    process.env.VS_ADMIN_TRANSPORT === 'wireguard' ||
    process.env.VS_ADMIN_ALLOW_WIREGUARD === '1' ||
    existsSync(paths.wgConfPath);

  const savedUrl = existing.baseUrl ? String(existing.baseUrl) : '';
  const discovered = await discoverVsServer({
    expectedServerId: 'VS-CORE-01',
    lanCandidates: savedUrl && !isWireGuardUrl(savedUrl) ? [savedUrl] : undefined,
    allowWireGuard,
    wireguardCandidates: savedUrl && isWireGuardUrl(savedUrl) ? [savedUrl] : undefined,
  });
  if (!discovered) {
    console.error('FAIL STAGE=SERVER_DISCOVER');
    console.error('  could not discover VS-CORE-01 on LAN');
    console.error('  example: http://192.168.0.10:3000/health');
    console.error('  WireGuard is NOT required for home ADMIN');
    return 1;
  }
  const baseUrl = discovered.baseUrl;
  const transport = discovered.via === 'lan' ? 'LAN' : 'WIREGUARD';
  stage('SERVER DISCOVERED', `${baseUrl} TRANSPORT=${transport} server_id=${discovered.server_id || 'VS-CORE-01'}`);

  const adminToken = resolveAdminToken(paths, existing);
  if (!adminToken) {
    console.error('FAIL STAGE=ADMIN_AUTH code=ADMIN_TOKEN_REQUIRED');
    console.error('  On i3: sudo grep API_ADMIN_TOKEN /var/lib/vs-server/server.env');
    console.error('  Or place ADMIN_TOKEN.txt next to INSTALL_ADMIN.bat');
    console.error('  Format: API_ADMIN_TOKEN=<token>');
    return 1;
  }
  writeSecure(paths.secureTokenPath, adminToken + '\n');

  try {
    await verifyAdminToken(baseUrl, adminToken);
    stage('ADMIN AUTH OK');
  } catch (e) {
    const err = e instanceof InstallStageError ? e : null;
    console.error(`FAIL STAGE=${err?.stage || 'ADMIN_AUTH'} code=${err?.code || 'ERROR'}`);
    if (err?.message) console.error(`  ${err.message}`);
    console.error('  Token is never printed. Re-copy API_ADMIN_TOKEN from i3 server.env');
    return 1;
  }

  let enroll;
  try {
    // Never reuse stale enrollment_code from local config — only optional fresh env override
    const override = normalizeAdminSecret(process.env.VS_ENROLLMENT_CODE || '');
    enroll = await enrollAdminDevice({
      baseUrl,
      adminToken,
      publicKey: keys.publicKey,
      deviceId: 'VS-ADMIN-01',
      existingDeviceToken: String(existing.device_token || ''),
      enrollmentCodeOverride: override || undefined,
      log: (s, d) => stage(s.replace(/_/g, ' '), d),
    });
  } catch (e) {
    const err = e instanceof InstallStageError ? e : null;
    console.error(`FAIL STAGE=${err?.stage || 'ENROLLMENT'} code=${err?.code || 'ERROR'}`);
    if (err?.message) console.error(`  ${err.message}`);
    console.error('  No secrets printed. Re-run INSTALL_ADMIN after fixing the stage above.');
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
    stage('WIREGUARD CONF WRITTEN', '(optional remote ADMIN; LAN remains primary at home)');
  }

  const connection = {
    server_id: discovered.server_id || 'VS-CORE-01',
    device_id: enroll.device_id || 'VS-ADMIN-01',
    baseUrl,
    transport: discovered.via,
    adminToken: '',
    device_token: enroll.device_token,
    enrollment_code: '',
    note: 'Never reuse enrollment_code from this file. Tokens under data dir / control-panel.env.',
  };
  writeSecure(paths.connectionPath, JSON.stringify(connection, null, 2) + '\n');

  const envLines = [
    `# VS Control Panel → i3 SERVER (generated by INSTALL_ADMIN — do not commit)`,
    `VS_SERVER_URL=${baseUrl}`,
    `VS_LAN_SERVER_URL=${discovered.via === 'lan' ? baseUrl : ''}`,
    `VS_ADMIN_TRANSPORT=${discovered.via}`,
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
    console.error('FAIL STAGE=ADMIN_API_VERIFY');
    console.error(`  state=${st.state} error=${st.last_error || 'none'}`);
    return 1;
  }
  stage('ADMIN API VERIFIED', `core=${snap.core?.state || 'NO_DATA'}`);

  console.log('');
  stage('INSTALL SUCCESS');
  console.log(`SERVER: ${snap.server_id || discovered.server_id || 'VS-CORE-01'}`);
  console.log(`TRANSPORT: ${transport}`);
  console.log(`SERVER_URL: ${baseUrl}`);
  console.log('AUTH: OK');
  console.log('CONNECTION: CONNECTED');
  console.log('');
  console.log('Next: START_ADMIN.bat');
  return 0;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('installAdmin.ts') || process.argv[1].endsWith('installAdmin.js'));

if (isMain) {
  runAdminInstall()
    .then((code) => exitOnce(code))
    .catch((e) => {
      console.error('FAIL STAGE=INSTALL', e instanceof Error ? e.message : e);
      exitOnce(1);
    });
}
