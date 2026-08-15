/**
 * VS ADMIN diagnostic entry — polls REAL SERVER telemetry.
 * Usage: VS_SERVER_URL=http://host:3000 API_ADMIN_TOKEN=... npm start
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AdminConnectionClient } from '../connection/adminConnectionClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig(): { baseUrl: string; adminToken: string } {
  const cfgPath = process.env.VS_ADMIN_CONFIG || join(__dirname, '..', 'config', 'admin.connection.json');
  let file: Partial<{ baseUrl: string; adminToken: string }> = {};
  if (existsSync(cfgPath)) {
    try {
      file = JSON.parse(readFileSync(cfgPath, 'utf8'));
    } catch {
      /* ignore */
    }
  }
  const baseUrl = process.env.VS_SERVER_URL || file.baseUrl || '';
  const adminToken = process.env.API_ADMIN_TOKEN || file.adminToken || '';
  return { baseUrl, adminToken };
}

async function main() {
  const { baseUrl, adminToken } = loadConfig();
  if (!baseUrl) {
    console.error('FAIL: set VS_SERVER_URL or ADMIN/config/admin.connection.json');
    process.exit(1);
  }
  if (!adminToken || adminToken === 'CHANGE_ME_ADMIN_TOKEN') {
    console.error('FAIL: set API_ADMIN_TOKEN (non-default) for Admin channel');
    process.exit(1);
  }

  const client = new AdminConnectionClient({
    baseUrl,
    adminToken,
    pollIntervalMs: Number(process.env.VS_ADMIN_POLL_MS || 2000),
  });

  console.log('VS ADMIN starting…');
  console.log(`SERVER URL ${baseUrl}`);

  const once = process.argv.includes('--once');
  if (once) {
    await client.fetchSnapshot();
    console.clear?.();
    console.log(client.renderDiagnostic());
    const st = client.getStatus();
    process.exit(st.state === 'CONNECTED' ? 0 : 1);
  }

  client.startPolling((st) => {
    console.clear();
    console.log(client.renderDiagnostic());
    if (st.state === 'DISCONNECTED') {
      console.log('\n(Waiting for SERVER reconnect…)');
    }
  });

  process.on('SIGINT', () => {
    client.stopPolling();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
