import { FastifyInstance } from 'fastify';
import { logAudit } from '../services/audit.js';
import {
  deskCalibrationCatalog,
  getDeskCalibration,
  setDeskCalibration,
  type DeskCalibration,
} from '../services/deskCalibration.js';
import {
  beginAutoCalibrateSession,
  getAutoCalibrateStatus,
  isAutoCalibrateEnabled,
  setAutoCalibrateEnabled,
} from '../services/autoCalibrate.js';

export async function registerDeskCalibrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/desk/calibration', async () => ({
    calibration: getDeskCalibration(),
    catalog: deskCalibrationCatalog(),
    auto: getAutoCalibrateStatus(),
  }));

  app.put('/api/desk/calibration', async (request) => {
    const body = (request.body || {}) as Partial<DeskCalibration>;
    const calibration = setDeskCalibration(body);
    await logAudit('admin', 'desk_calibration_updated', 'desk', 'calibration', null, {
      hardinv_abs: calibration.hardinv_abs,
      peak_retention: calibration.peak_retention,
      enabled_regimes: calibration.enabled_regimes,
    });
    return { success: true, calibration, auto: getAutoCalibrateStatus() };
  });

  app.get('/api/desk/auto-calibrate', async () => getAutoCalibrateStatus());

  app.post('/api/desk/auto-calibrate', async (request) => {
    const body = (request.body || {}) as { enabled?: boolean; reset?: boolean };
    if (typeof body.enabled === 'boolean') {
      setAutoCalibrateEnabled(body.enabled);
    }
    if (body.reset) {
      beginAutoCalibrateSession('manual_reset');
    }
    await logAudit('admin', 'desk_auto_calibrate', 'desk', 'auto', null, {
      enabled: isAutoCalibrateEnabled(),
      reset: Boolean(body.reset),
    });
    return { success: true, auto: getAutoCalibrateStatus() };
  });
}
