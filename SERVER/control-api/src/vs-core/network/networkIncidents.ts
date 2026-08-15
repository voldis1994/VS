/**
 * Raise network incidents into Incident Engine (in-process).
 */

import { getIncidentCenter } from '../incidentCenter.js';

export type NetworkIncidentCode =
  | 'WIREGUARD_DOWN'
  | 'FIREWALL_INVALID'
  | 'DEVICE_AUTH_FAILURE'
  | 'REPEATED_AUTH_FAILURE'
  | 'NETWORK_AUTHORITY_DOWN'
  | 'SERVER_ENDPOINT_UNREACHABLE'
  | 'SERVER_NOT_EXTERNALLY_REACHABLE';

export function raiseNetworkIncident(input: {
  code: NetworkIncidentCode;
  reason: string;
  severity?: 'CRITICAL' | 'ERROR' | 'WARNING';
  technical_details?: string;
}): void {
  getIncidentCenter().raise({
    severity: input.severity || (input.code === 'WIREGUARD_DOWN' ? 'CRITICAL' : 'ERROR'),
    component: 'VS_PRIVATE_NETWORK',
    error_code: input.code,
    reason: input.reason,
    technical_details: input.technical_details,
    recovery_action:
      input.code === 'SERVER_NOT_EXTERNALLY_REACHABLE'
        ? 'Provide public UDP endpoint / DDNS / port-forward for WireGuard; do not fake reachability'
        : 'investigate network authority',
  });
}
