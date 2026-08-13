import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allowTunnelHosts } from './vite.allow-tunnels';

export default defineConfig({
  plugins: [allowTunnelHosts(), react()],
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
});
