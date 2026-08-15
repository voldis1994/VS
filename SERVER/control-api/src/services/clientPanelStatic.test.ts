import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerClientPanelStatic } from './clientPanelStatic.js';

describe('client panel static (tunnel Host)', () => {
  let dir = '';

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CLIENT_PANEL_DIST;
  });

  it('serves HTML for a random trycloudflare Host (not Vite 403)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-panel-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>PANEL_OK</html>');
    process.env.CLIENT_PANEL_DIST = dir;

    const app = Fastify();
    await registerClientPanelStatic(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'appropriate-option-tension-tale.trycloudflare.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('PANEL_OK');
    expect(res.body).not.toContain('Blocked request');
    expect(res.headers['x-vs-panel']).toBe('control-api');
    await app.close();
  });
});
