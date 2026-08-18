import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerClientPanelStatic } from './clientPanelStatic.js';

describe('client panel static (tunnel Host)', () => {
  let clientDir = '';
  let deskDir = '';

  afterEach(() => {
    if (clientDir) fs.rmSync(clientDir, { recursive: true, force: true });
    if (deskDir) fs.rmSync(deskDir, { recursive: true, force: true });
    clientDir = '';
    deskDir = '';
    delete process.env.CLIENT_PANEL_DIST;
    delete process.env.DESK_PANEL_DIST;
  });

  function makeClient(html = '<html>PANEL_OK SIGN IN VS CLIENT</html>') {
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-client-'));
    fs.writeFileSync(path.join(clientDir, 'index.html'), html);
    process.env.CLIENT_PANEL_DIST = clientDir;
  }

  function makeDesk(html = '<html>VS SYSTEM TACTICAL DESK ROBOT COMMAND SAFETY SL</html>') {
    deskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-desk-'));
    fs.writeFileSync(path.join(deskDir, 'index.html'), html);
    process.env.DESK_PANEL_DIST = deskDir;
  }

  it('serves HTML for a random trycloudflare Host (not Vite 403)', async () => {
    makeClient();
    process.env.DESK_PANEL_DIST = path.join(os.tmpdir(), 'vs-desk-missing');

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

  it('never serves VS CLIENT login on /robot — that is TACTICAL DESK', async () => {
    makeClient();
    makeDesk();

    const app = Fastify();
    await registerClientPanelStatic(app);
    await app.ready();

    const robot = await app.inject({ method: 'GET', url: '/robot' });
    expect(robot.statusCode).toBe(200);
    expect(robot.body).toContain('TACTICAL DESK');
    expect(robot.body).toContain('ROBOT COMMAND');
    expect(robot.body).not.toContain('VS CLIENT');
    expect(robot.body).not.toContain('SIGN IN');
    expect(robot.headers['x-vs-panel']).toBe('tactical-desk');
    expect(robot.headers['cache-control']).toBe('no-store');

    const home = await app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('VS CLIENT');
    expect(home.headers['x-vs-panel']).toBe('control-api');

    await app.close();
  });

  it('returns 503 on /robot when desk dist is missing instead of falling back to VS CLIENT', async () => {
    makeClient();
    process.env.DESK_PANEL_DIST = path.join(os.tmpdir(), 'vs-desk-missing');

    const app = Fastify();
    await registerClientPanelStatic(app);
    await app.ready();

    const robot = await app.inject({ method: 'GET', url: '/robot' });
    expect(robot.statusCode).toBe(503);
    expect(robot.body).toMatch(/Tactical desk not built/i);
    expect(robot.body).not.toContain('VS CLIENT');
    expect(robot.body).not.toContain('SIGN IN');
    expect(robot.body).not.toContain('PANEL_OK');

    await app.close();
  });

  it('picks up ADMIN/desk dist after boot (does not freeze CLIENT dist)', async () => {
    makeClient();
    deskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-desk-late-'));
    process.env.DESK_PANEL_DIST = deskDir;

    const app = Fastify();
    await registerClientPanelStatic(app);
    await app.ready();

    const before = await app.inject({ method: 'GET', url: '/robot' });
    expect(before.statusCode).toBe(503);

    fs.writeFileSync(
      path.join(deskDir, 'index.html'),
      '<html>VS SYSTEM TACTICAL DESK ROBOT COMMAND</html>'
    );

    const after = await app.inject({ method: 'GET', url: '/robot' });
    expect(after.statusCode).toBe(200);
    expect(after.body).toContain('TACTICAL DESK');
    expect(after.body).not.toContain('VS CLIENT');

    await app.close();
  });
});
