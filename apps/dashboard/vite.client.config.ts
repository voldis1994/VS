import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Standalone Client Control Panel.
 * Share this URL with clients — no admin desk.
 *
 * Local:  http://<your-lan-ip>:5174/
 * Start:  npm run dev:client
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
  },
  server: {
    port: 5174,
    strictPort: true,
    host: true,
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
  },
  build: {
    outDir: 'dist-client',
    emptyOutDir: true,
  },
});
