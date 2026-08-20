import type { Plugin, ViteDevServer } from 'vite';

type ConnectLike = { stack?: Array<{ handle?: { name?: string } }> };

function stripHostCheck(server: { middlewares: unknown }): void {
  const stack = (server.middlewares as ConnectLike).stack;
  if (!Array.isArray(stack)) return;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]?.handle?.name === 'viteHostCheckMiddleware') {
      stack.splice(i, 1);
    }
  }
}

/**
 * Cloudflare quick tunnels mint a NEW hostname every launch
 * (`likes-….trycloudflare.com`, `collecting-….trycloudflare.com`, …).
 * Vite's Host allowlist blocks those unless we disable the check.
 */
export function allowTunnelHosts(): Plugin {
  return {
    name: 'allow-tunnel-hosts',
    config() {
      return {
        server: { allowedHosts: true },
        preview: { allowedHosts: true },
      };
    },
    configureServer(server: ViteDevServer) {
      server.config.server.allowedHosts = true;
      return () => stripHostCheck(server);
    },
    configurePreviewServer(server) {
      return () => stripHostCheck(server);
    },
  };
}
