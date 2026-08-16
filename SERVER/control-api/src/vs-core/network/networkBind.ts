/**
 * Production bind policy — fail closed on public exposure.
 *
 * Modes:
 * - Default: 127.0.0.1
 * - VS_LAN_MANAGEMENT=1: bind 0.0.0.0 so MSI on LAN + WG peers can reach Control API.
 *   MUST be paired with APPLY_FIREWALL (LAN CIDR + 10.77.0.0/16 only for :3000).
 * - VS_PRIVATE_NETWORK=1 without LAN management: bind WireGuard IP only (legacy).
 *
 * NEVER:
 *   silent public 0.0.0.0 without VS_LAN_MANAGEMENT
 *   WireGuard-down → public HTTP fallback
 */

import { networkInterfaces } from 'os';
import { VS_WG_SERVER_IP, VS_WG_INTERFACE_DEFAULT } from './networkConstants.js';

export type BindDecision = {
  host: string;
  reason: string;
  public_management_exposure: 'NONE' | 'DENIED_DEFAULT' | 'LAN_FIREWALL_REQUIRED' | string;
  wireguard_ready: boolean;
};

export function findWireGuardIpv4(ifaceName: string): string | null {
  const ifaces = networkInterfaces();
  const list = ifaces[ifaceName];
  if (!list) return null;
  for (const a of list) {
    if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

export function isWireGuardReady(
  env: NodeJS.ProcessEnv = process.env
): { ready: boolean; ip: string | null; iface: string } {
  const iface = env.VS_WG_INTERFACE || VS_WG_INTERFACE_DEFAULT;
  const ip = findWireGuardIpv4(iface);
  return { ready: Boolean(ip), ip, iface };
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Resolve CONTROL_API listen host.
 */
export function resolveManagementBind(env: NodeJS.ProcessEnv = process.env): BindDecision {
  const explicit = env.CONTROL_API_HOST;
  const isProd = env.NODE_ENV === 'production';
  const privateNet = truthy(env.VS_PRIVATE_NETWORK);
  const lanMgmt = truthy(env.VS_LAN_MANAGEMENT);
  const wg = isWireGuardReady(env);

  // Appliance: MSI on same Wi-Fi + remote clients on WireGuard.
  // Bind all interfaces; nftables/ufw MUST restrict TCP API to LAN+WG+lo.
  if (lanMgmt) {
    const host =
      explicit && explicit !== '' && explicit !== '127.0.0.1'
        ? explicit
        : '0.0.0.0';
    if (host === '0.0.0.0' || host === '::') {
      return {
        host,
        reason: 'LAN_MANAGEMENT_FIREWALL_ENFORCED',
        public_management_exposure: 'LAN_FIREWALL_REQUIRED',
        wireguard_ready: wg.ready,
      };
    }
    return {
      host,
      reason: 'LAN_MANAGEMENT_EXPLICIT_HOST',
      public_management_exposure: 'LAN_FIREWALL_REQUIRED',
      wireguard_ready: wg.ready,
    };
  }

  if (explicit === '0.0.0.0' || explicit === '::') {
    if (isProd || privateNet) {
      throw new Error(
        'PUBLIC_BIND_DENIED: set VS_LAN_MANAGEMENT=1 (firewall-enforced) or bind WireGuard IP — refuse open public bind'
      );
    }
    return {
      host: explicit,
      reason: 'DEV_ONLY_PUBLIC_BIND',
      public_management_exposure: 'DEV_OVERRIDE',
      wireguard_ready: wg.ready,
    };
  }

  if (privateNet) {
    const allowUnbound =
      truthy(env.VS_PRIVATE_NETWORK_ALLOW_UNBOUND) ||
      env.NODE_ENV === 'test' ||
      env.VITEST === 'true';

    if (!wg.ready && !allowUnbound) {
      throw new Error(
        'WIREGUARD_NOT_READY: VS_PRIVATE_NETWORK=1 but WireGuard interface is down — management NOT READY (no public HTTP fallback)'
      );
    }

    const host = wg.ip || (allowUnbound ? VS_WG_SERVER_IP : null);
    if (!host) {
      throw new Error('WIREGUARD_NOT_READY: no private address');
    }

    if (explicit && explicit !== '' && explicit !== host && explicit !== VS_WG_SERVER_IP) {
      if (explicit === '127.0.0.1' && !allowUnbound) {
        throw new Error(
          'PRIVATE_NETWORK_LOCALHOST_FALLBACK_DENIED: refuse localhost fallback when VS_PRIVATE_NETWORK=1'
        );
      }
    }

    return {
      host: explicit && explicit !== '' ? explicit : host,
      reason: wg.ready ? 'VS_PRIVATE_NETWORK_WG_READY' : 'VS_PRIVATE_NETWORK_TEST_UNBOUND',
      public_management_exposure: 'NONE',
      wireguard_ready: wg.ready,
    };
  }

  if (explicit && explicit !== '') {
    return {
      host: explicit,
      reason: 'EXPLICIT_CONTROL_API_HOST',
      public_management_exposure: 'NONE',
      wireguard_ready: wg.ready,
    };
  }

  return {
    host: '127.0.0.1',
    reason: 'DEFAULT_LOCALHOST',
    public_management_exposure: 'NONE',
    wireguard_ready: wg.ready,
  };
}
