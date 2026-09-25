import { FastifyInstance } from 'fastify';
import { logAudit } from '../services/audit.js';
import {
  deskCalibrationCatalog,
  getDeskCalibration,
  setDeskCalibration,
  type DeskCalibration,
} from '../services/deskCalibration.js';
import {
  getAutoCalibrateStatus,
  isAutoCalibrateEnabled,
  resetClientToOpenTradeAll,
  setAutoCalibrateEnabled,
} from '../services/autoCalibrate.js';
import { runWithDeskClientAsync } from '../services/deskClientScope.js';
import { getLearnerStatus } from '../services/deskLearner.js';

function parseClientId(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export async function registerDeskCalibrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/desk/calibration', async (request) => {
    const q = (request.query || {}) as { client_id?: string | number };
    const clientId = parseClientId(q.client_id);
    return runWithDeskClientAsync(clientId, async () => ({
      client_id: clientId,
      calibration: getDeskCalibration(clientId),
      catalog: deskCalibrationCatalog(),
      auto: getAutoCalibrateStatus(undefined, clientId),
      learner: getLearnerStatus(clientId),
    }));
  });

  app.put('/api/desk/calibration', async (request) => {
    const body = (request.body || {}) as Partial<DeskCalibration> & { client_id?: number };
    const q = (request.query || {}) as { client_id?: string | number };
    const clientId = parseClientId(body.client_id ?? q.client_id);
    return runWithDeskClientAsync(clientId, async () => {
      const { client_id: _c, ...patch } = body;
      const calibration = setDeskCalibration(patch, clientId);
      await logAudit('admin', 'desk_calibration_updated', 'desk', 'calibration', null, {
        client_id: clientId,
        hardinv_abs: calibration.hardinv_abs,
        peak_retention: calibration.peak_retention,
        enabled_regimes: calibration.enabled_regimes,
      });
      return {
        success: true,
        client_id: clientId,
        calibration,
        auto: getAutoCalibrateStatus(undefined, clientId),
        learner: getLearnerStatus(clientId),
      };
    });
  });

  app.get('/api/desk/auto-calibrate', async (request) => {
    const q = (request.query || {}) as { client_id?: string | number };
    const clientId = parseClientId(q.client_id);
    return runWithDeskClientAsync(clientId, async () =>
      getAutoCalibrateStatus(undefined, clientId)
    );
  });

  app.get('/api/desk/learner', async (request) => {
    const q = (request.query || {}) as { client_id?: string | number };
    const clientId = parseClientId(q.client_id);
    return runWithDeskClientAsync(clientId, async () => getLearnerStatus(clientId));
  });

  app.post('/api/desk/auto-calibrate', async (request) => {
    const body = (request.body || {}) as {
      enabled?: boolean;
      reset?: boolean;
      factory_open?: boolean;
      client_id?: number;
    };
    const clientId = parseClientId(body.client_id);
    return runWithDeskClientAsync(clientId, async () => {
      if (typeof body.enabled === 'boolean') {
        setAutoCalibrateEnabled(body.enabled, clientId);
      }
      if (body.reset || body.factory_open) {
        resetClientToOpenTradeAll(clientId, body.factory_open ? 'factory_open' : 'manual_reset');
      }
      await logAudit('admin', 'desk_auto_calibrate', 'desk', 'auto', null, {
        client_id: clientId,
        enabled: isAutoCalibrateEnabled(clientId),
        reset: Boolean(body.reset || body.factory_open),
        factory_open: Boolean(body.factory_open || body.reset),
      });
      return {
        success: true,
        client_id: clientId,
        calibration: getDeskCalibration(clientId),
        auto: getAutoCalibrateStatus(undefined, clientId),
        learner: getLearnerStatus(clientId),
      };
    });
  });
}
