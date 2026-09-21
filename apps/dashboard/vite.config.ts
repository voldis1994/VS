import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { allowTunnelHosts } from './vite.allow-tunnels';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig(({ mode }) => {
  // VS.bat writes API_ADMIN_TOKEN to repo-root .env — expose as VITE_ADMIN_TOKEN
  // so the desk always sends x-admin-token after restart (local desk also has
  // loopback auth bypass; this covers LAN / explicit token paths).
  const env = loadEnv(mode, repoRoot, '');
  const adminToken = (env.VITE_ADMIN_TOKEN || env.API_ADMIN_TOKEN || '').trim();

  return {
    plugins: [allowTunnelHosts(), react()],
    envDir: repoRoot,
    define: {
      'import.meta.env.VITE_ADMIN_TOKEN': JSON.stringify(adminToken),
    },
    server: {
      port: 5173,
      host: '127.0.0.1',
      allowedHosts: true,
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          timeout: 600_000,
          proxyTimeout: 600_000,
        },
        '/ws': { target: 'ws://localhost:3000', ws: true },
      },
    },
  };
});
