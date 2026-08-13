import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Standalone Client Control Panel for REMOTE clients (not same Wi‑Fi).
 *
 * Local listen: http://localhost:5174/
 * Public share: double-click VS.bat (Cloudflare tunnel in that window)
 *   → https://xxxx.trycloudflare.com
 *
 * API + WS go same-origin via Vite proxy (required for tunnels).
 */
export default defineConfig({
  plugins: [
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
    port: 5174,
    strictPort: true,
    host: true,
    // Cloudflare tunnel host changes every launch (*.trycloudflare.com)
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
  preview: {
    port: 5174,
    strictPort: true,
    host: true,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist-client',
    emptyOutDir: true,
  },
});
