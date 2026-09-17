import { FastifyInstance } from 'fastify';
import { logAudit } from '../services/audit.js';
import {
  deskCalibrationCatalog,
  getDeskCalibration,
  setDeskCalibration,
  type DeskCalibration,
} from '../services/deskCalibration.js';

export async function registerDeskCalibrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/desk/calibration', async () => ({
    calibration: getDeskCalibration(),
    catalog: deskCalibrationCatalog(),
  }));

  app.put('/api/desk/calibration', async (request) => {
    const body = (request.body || {}) as Partial<DeskCalibration>;
    const calibration = setDeskCalibration(body);
    await logAudit('admin', 'desk_calibration_updated', 'desk', 'calibration', null, {
      hardinv_abs: calibration.hardinv_abs,
      peak_retention: calibration.peak_retention,
      enabled_regimes: calibration.enabled_regimes,
    });
    return { success: true, calibration };
  });
}
