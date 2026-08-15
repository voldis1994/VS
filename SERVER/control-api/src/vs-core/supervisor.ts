/**
 * VS Supervisor — watches services, restart policy, crash-loop detection.
 * Does not reboot the whole machine for a single service failure.
 */

export type ServiceHealth = 'OK' | 'WARNING' | 'ERROR' | 'CRITICAL' | 'STARTING' | 'STOPPED';

export type ServiceDef = {
  name: string;
  critical: boolean;
  /** Dependencies must be OK before start. */
  depends_on: string[];
  start_timeout_ms: number;
  max_restarts: number;
  restart_window_ms: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  health: () => Promise<{ status: ServiceHealth; detail: string }>;
};

type RuntimeState = {
  def: ServiceDef;
  status: ServiceHealth;
  detail: string;
  restarts: number[];
  crash_loop: boolean;
  last_heartbeat: string | null;
};

export type SupervisorSnapshot = {
  overall: 'READY' | 'DEGRADED' | 'NOT_READY' | 'CRITICAL_SERVICE_CRASH_LOOP';
  reason_code: string | null;
  services: Array<{
    name: string;
    status: ServiceHealth;
    detail: string;
    crash_loop: boolean;
    restart_count: number;
    last_heartbeat: string | null;
  }>;
};

export class VsSupervisor {
  private services = new Map<string, RuntimeState>();
  private started = false;

  register(def: ServiceDef): void {
    this.services.set(def.name, {
      def,
      status: 'STOPPED',
      detail: 'not started',
      restarts: [],
      crash_loop: false,
      last_heartbeat: null,
    });
  }

  private topoOrder(): ServiceDef[] {
    const defs = [...this.services.values()].map((s) => s.def);
    const done = new Set<string>();
    const out: ServiceDef[] = [];
    let guard = 0;
    while (out.length < defs.length && guard++ < defs.length * defs.length + 2) {
      for (const d of defs) {
        if (done.has(d.name)) continue;
        if (d.depends_on.every((x) => done.has(x))) {
          out.push(d);
          done.add(d.name);
        }
      }
    }
    if (out.length !== defs.length) {
      throw new Error('Service dependency cycle or missing dependency');
    }
    return out;
  }

  async startAll(): Promise<SupervisorSnapshot> {
    this.started = true;
    for (const def of this.topoOrder()) {
      const rt = this.services.get(def.name)!;
      rt.status = 'STARTING';
      rt.detail = 'starting';
      try {
        await Promise.race([
          def.start(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('startup timeout')), def.start_timeout_ms)
          ),
        ]);
        const h = await def.health();
        rt.status = h.status;
        rt.detail = h.detail;
        rt.last_heartbeat = new Date().toISOString();
      } catch (e) {
        rt.status = 'CRITICAL';
        rt.detail = e instanceof Error ? e.message : String(e);
      }
    }
    return this.snapshot();
  }

  async heartbeat(): Promise<SupervisorSnapshot> {
    for (const rt of this.services.values()) {
      if (!this.started) continue;
      try {
        const h = await rt.def.health();
        rt.status = h.status;
        rt.detail = h.detail;
        rt.last_heartbeat = new Date().toISOString();
        if (h.status === 'CRITICAL' || h.status === 'ERROR') {
          await this.maybeRestart(rt);
        }
      } catch (e) {
        rt.status = 'CRITICAL';
        rt.detail = e instanceof Error ? e.message : String(e);
        await this.maybeRestart(rt);
      }
    }
    return this.snapshot();
  }

  private async maybeRestart(rt: RuntimeState): Promise<void> {
    const now = Date.now();
    rt.restarts = rt.restarts.filter((t) => now - t < rt.def.restart_window_ms);
    if (rt.restarts.length >= rt.def.max_restarts) {
      rt.crash_loop = true;
      rt.status = 'CRITICAL';
      rt.detail = 'CRITICAL_SERVICE_CRASH_LOOP';
      return;
    }
    try {
      await rt.def.stop().catch(() => undefined);
      await rt.def.start();
      rt.restarts.push(now);
      const h = await rt.def.health();
      rt.status = h.status;
      rt.detail = `restarted: ${h.detail}`;
      rt.last_heartbeat = new Date().toISOString();
    } catch (e) {
      rt.restarts.push(now);
      rt.status = 'CRITICAL';
      rt.detail = e instanceof Error ? e.message : String(e);
    }
  }

  async shutdown(): Promise<void> {
    const order = this.topoOrder().reverse();
    for (const def of order) {
      const rt = this.services.get(def.name)!;
      try {
        await def.stop();
        rt.status = 'STOPPED';
        rt.detail = 'graceful shutdown';
      } catch (e) {
        rt.detail = e instanceof Error ? e.message : String(e);
      }
    }
    this.started = false;
  }

  snapshot(): SupervisorSnapshot {
    const services = [...this.services.values()].map((rt) => ({
      name: rt.def.name,
      status: rt.status,
      detail: rt.detail,
      crash_loop: rt.crash_loop,
      restart_count: rt.restarts.length,
      last_heartbeat: rt.last_heartbeat,
    }));

    if (services.some((s) => s.crash_loop && this.services.get(s.name)!.def.critical)) {
      return {
        overall: 'CRITICAL_SERVICE_CRASH_LOOP',
        reason_code: 'CRITICAL_SERVICE_CRASH_LOOP',
        services,
      };
    }
    const criticalBad = services.filter((s) => {
      const def = this.services.get(s.name)!.def;
      return def.critical && (s.status === 'CRITICAL' || s.status === 'ERROR' || s.status === 'STOPPED');
    });
    if (criticalBad.length) {
      return {
        overall: 'NOT_READY',
        reason_code: `SERVICE_${criticalBad[0]!.name.toUpperCase()}_${criticalBad[0]!.status}`,
        services,
      };
    }
    if (services.some((s) => s.status === 'WARNING' || s.status === 'ERROR')) {
      return { overall: 'DEGRADED', reason_code: 'SERVICE_DEGRADED', services };
    }
    return { overall: 'READY', reason_code: null, services };
  }
}
