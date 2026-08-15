/**
 * Admin Agent — VS CORE side agent for future VS ADMIN.
 * Exposes authenticated health/telemetry JSON. Not a desktop UI.
 * Does not start VS ADMIN native app (next master task — blocked).
 */

import type { FastifyInstance } from 'fastify';
import { collectHostSystemSnapshot } from './hostTelemetry.js';
import { evaluateReadiness, type ProbeResult } from './readiness.js';
import { getIncidentCenter } from './incidentCenter.js';
import { getEventBus } from './eventBus.js';
import { versionBundle } from './versions.js';
import { renderCoreTui, servicesFromProbes, type CoreTuiModel } from './coreTui.js';
import { FeedManager } from './feedManager.js';

export type AdminAgentDeps = {
  getProbes: () => ProbeResult[] | Promise<ProbeResult[]>;
  feedManager?: FeedManager;
  adminToken?: string;
};

function authorizeAdmin(req: { headers: Record<string, unknown> }, expected?: string): boolean {
  if (!expected || expected === 'CHANGE_ME_ADMIN_TOKEN') {
    // Dev only — production must set API_ADMIN_TOKEN
    return process.env.NODE_ENV !== 'production';
  }
  const token = String(req.headers['x-admin-token'] || '');
  return token === expected;
}

export async function registerAdminAgentRoutes(
  app: FastifyInstance,
  deps: AdminAgentDeps
): Promise<void> {
  const token = deps.adminToken ?? process.env.API_ADMIN_TOKEN;

  app.get('/api/v1/admin/health', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const probes = await deps.getProbes();
    const readiness = evaluateReadiness(probes);
    const host = collectHostSystemSnapshot({
      cpuSampleMs: 50,
      probeNetwork: false,
      dataRoot: process.env.VS_CORE_DATA || '/',
    });
    const incidents = getIncidentCenter().list({ unresolved_only: true });
    return {
      ok: true,
      role: 'admin_agent',
      versions: versionBundle(),
      readiness,
      host: {
        server_id: host.server_id,
        cpu_percent: host.cpu_percent,
        ram_used_bytes: host.ram_used_bytes,
        ram_total_bytes: host.ram_total_bytes,
        ssd_used_bytes: host.ssd_used_bytes,
        ssd_total_bytes: host.ssd_total_bytes,
        network_online: host.network_online,
        network_latency_ms: host.network_latency_ms,
        time_sync_ok: host.time_sync_ok,
        uptime_human: host.uptime_human,
      },
      incidents_unresolved: incidents.length,
      // Never include Capital secrets
    };
  });

  app.get('/api/v1/admin/tui', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const probes = await deps.getProbes();
    const readiness = evaluateReadiness(probes);
    const host = collectHostSystemSnapshot({
      cpuSampleMs: 50,
      probeNetwork: true,
      dataRoot: process.env.VS_CORE_DATA || '/',
    });
    const center = getIncidentCenter();
    const model: CoreTuiModel = {
      host,
      readiness,
      services: servicesFromProbes(probes),
      feeds: deps.feedManager?.snapshot('GOLD') ?? null,
      capital: {
        connection: probes.find((p) => p.name === 'CAPITAL')?.status || 'NO_DATA',
        accounts: null,
        positions: null,
        working_orders: null,
        last_sync: null,
        latency_ms: null,
      },
      clients: {
        registered: null,
        active: null,
        trading: null,
        paused: null,
        disabled: null,
      },
      incidents: {
        critical: center.list({ severity: 'CRITICAL', unresolved_only: true }).length,
        error: center.list({ severity: 'ERROR', unresolved_only: true }).length,
        warning: center.list({ severity: 'WARNING', unresolved_only: true }).length,
        info: 0,
      },
      events: getEventBus().recent(20),
    };
    const text = renderCoreTui(model);
    reply.header('content-type', 'text/plain; charset=utf-8');
    return text;
  });
}
