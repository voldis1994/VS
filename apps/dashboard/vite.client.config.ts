import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allowTunnelHosts } from './vite.allow-tunnels';

/**
 * Standalone Client Control Panel for REMOTE clients (not same Wi‑Fi).
 *
 * Local listen: http://127.0.0.1:5175/ (Vite, localhost Host only)
 * Public share: client-gateway.mjs on :5174 → Cloudflare tunnel
 *   → https://xxxx.trycloudflare.com
 *
 * API + WS go same-origin via Vite proxy (required for tunnels).
 */
export default defineConfig({
  plugins: [
    allowTunnelHosts(),
    react(),
    {
      name: 'client-entry',
      transformIndexHtml(html) {
        return html
          .replace('/src/main.tsx', '/src/main.client.tsx')
          .replace('<title>VS SYSTEM</title>', '<title>VS Client Control</title>');
      },
    },
  ],
  define: {
    'import.meta.env.VITE_APP_MODE': JSON.stringify('client'),
    // Force same-origin — never point remote phones at localhost:3000
    'import.meta.env.VITE_API_URL': JSON.stringify(''),
    'import.meta.env.VITE_CLIENT_WS_URL': JSON.stringify(''),
    'import.meta.env.VITE_WS_URL': JSON.stringify(''),
  },
  server: {
    port: 5175,
    strictPort: true,
    host: '127.0.0.1',
    allowedHosts: true,
    hmr: false,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        timeout: 600_000,
        proxyTimeout: 600_000,
      },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  preview: {
    port: 5175,
    strictPort: true,
    host: '127.0.0.1',
    allowedHosts: true,
  },
  build: {
    outDir: 'dist-client',
    emptyOutDir: true,
  },
});
