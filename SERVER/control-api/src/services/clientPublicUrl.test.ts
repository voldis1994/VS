import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stablePublicClientUrl } from './clientPublicUrl.js';

describe('stablePublicClientUrl', () => {
  it('reads VS_CLIENT_URL_FILE and does not invent trycloudflare', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-url-'));
    const file = join(dir, 'client-url.txt');
    writeFileSync(file, 'http://127.0.0.1:8443/\n');
    const prevFile = process.env.VS_CLIENT_URL_FILE;
    const prevPub = process.env.VS_PUBLIC_CLIENT_URL;
    process.env.VS_CLIENT_URL_FILE = file;
    delete process.env.VS_PUBLIC_CLIENT_URL;
    try {
      expect(stablePublicClientUrl()).toBe('http://127.0.0.1:8443/');
      expect(stablePublicClientUrl()).not.toMatch(/trycloudflare/);
    } finally {
      if (prevFile) process.env.VS_CLIENT_URL_FILE = prevFile;
      else delete process.env.VS_CLIENT_URL_FILE;
      if (prevPub !== undefined) process.env.VS_PUBLIC_CLIENT_URL = prevPub;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
