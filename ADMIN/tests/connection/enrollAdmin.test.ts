import { describe, it, expect } from 'vitest';
import { generateDeviceX25519KeyPair, renderAdminPeerWgConf } from './enrollAdmin.js';

describe('enrollAdmin keys', () => {
  it('generates x25519 base64 keypair', () => {
    const pair = generateDeviceX25519KeyPair();
    expect(Buffer.from(pair.privateKey, 'base64').length).toBe(32);
    expect(Buffer.from(pair.publicKey, 'base64').length).toBe(32);
  });

  it('renders peer conf without leaking placeholder ports in product note', () => {
    const conf = renderAdminPeerWgConf({
      privateKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      privateAddress: '10.77.1.1',
      serverPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      endpoint: '203.0.113.10:51820',
    });
    expect(conf).toContain('PrivateKey = AAAA');
    expect(conf).toContain('Endpoint = 203.0.113.10:51820');
    expect(conf).toContain('AllowedIPs = 10.77.0.0/16');
  });
});
