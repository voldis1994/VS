/** Incident severity model. */

export type IncidentSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type Incident = {
  id: string;
  severity: IncidentSeverity;
  code: string;
  message: string;
  open: boolean;
  createdAt: string;
};

export function createIncident(input: {
  id: string;
  severity: IncidentSeverity;
  code: string;
  message: string;
}): Incident {
  return {
    ...input,
    open: true,
    createdAt: new Date().toISOString(),
  };
}
