import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAdminPanelStatic } from './adminPanelStatic.js';

describe('admin panel static', () => {
  let dir = '';

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ADMIN_PANEL_DIR;
  });

  it('serves /admin control panel HTML', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-admin-panel-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>VS ADMIN CONTROL PANEL</html>');
    process.env.ADMIN_PANEL_DIR = dir;

    const app = Fastify();
    await registerAdminPanelStatic(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/admin/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('VS ADMIN CONTROL PANEL');
    expect(res.headers['x-vs-panel']).toBe('admin');
    await app.close();
  });
});
