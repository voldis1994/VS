/**
 * VS Incident Center — structured CRITICAL/ERROR/WARNING with recovery actions.
 */

export type IncidentSeverity = 'CRITICAL' | 'ERROR' | 'WARNING';

export type Incident = {
  id: string;
  severity: IncidentSeverity;
  timestamp: string;
  client_id: number | null;
  component: string;
  error_code: string;
  reason: string;
  technical_details: string;
  retry_count: number;
  recovery_action: string;
  resolved: boolean;
  resolved_at: string | null;
};

import { randomUUID } from 'crypto';

export class IncidentCenter {
  private items: Incident[] = [];

  raise(input: {
    severity: IncidentSeverity;
    client_id?: number | null;
    component: string;
    error_code: string;
    reason: string;
    technical_details?: string;
    recovery_action?: string;
    retry_count?: number;
  }): Incident {
    const inc: Incident = {
      id: randomUUID(),
      severity: input.severity,
      timestamp: new Date().toISOString(),
      client_id: input.client_id ?? null,
      component: input.component,
      error_code: input.error_code,
      reason: input.reason,
      technical_details: input.technical_details || '',
      retry_count: input.retry_count ?? 0,
      recovery_action: input.recovery_action || 'investigate',
      resolved: false,
      resolved_at: null,
    };
    this.items.push(inc);
    return inc;
  }

  resolve(id: string): Incident | null {
    const inc = this.items.find((i) => i.id === id);
    if (!inc) return null;
    inc.resolved = true;
    inc.resolved_at = new Date().toISOString();
    return inc;
  }

  list(filter?: {
    severity?: IncidentSeverity;
    unresolved_only?: boolean;
    client_id?: number;
  }): Incident[] {
    return this.items.filter((i) => {
      if (filter?.severity && i.severity !== filter.severity) return false;
      if (filter?.unresolved_only && i.resolved) return false;
      if (filter?.client_id != null && i.client_id !== filter.client_id) return false;
      return true;
    });
  }

  unresolvedCritical(): Incident[] {
    return this.list({ severity: 'CRITICAL', unresolved_only: true });
  }
}

let shared: IncidentCenter | null = null;
export function getIncidentCenter(): IncidentCenter {
  if (!shared) shared = new IncidentCenter();
  return shared;
}
export function resetIncidentCenterForTests(): void {
  shared = new IncidentCenter();
}
