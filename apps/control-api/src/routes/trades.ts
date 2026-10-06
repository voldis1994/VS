import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { fetchExpectancyReport, parseExpectancyWindow } from '../services/tradeLedger.js';
import { computeConditionalEv, type HtfTaggedTrade } from '../services/htfConditionalEv.js';
import { replayStrategy, syntheticTrendBars } from '../services/strategyReplay.js';

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trades/expectancy', async (request) => {
    const query = request.query as {
      window?: string;
      client_id?: string;
      account_id?: string;
      epic?: string;
    };
    return fetchExpectancyReport(query);
  });

  /**
   * Conditional EV by HTF structure × phase × setup × side.
   * Measurement only — does not gate entries.
   */
  app.get('/api/trades/conditional-ev', async (request) => {
    const query = request.query as {
      window?: string;
      client_id?: string;
      account_id?: string;
      epic?: string;
      min_trades?: string;
    };
    const { window, since } = parseExpectancyWindow(query.window);
    let sql = `
      SELECT t.pnl_pts, t.pnl, t.regime, t.setup_type, t.exit_reason, t.epic,
             t.mfe, t.mae, t.hold_ms, t.direction, t.closed_at,
             t.htf_structure, t.htf_phase, t.htf_bias, t.htf_path_status, t.htf_state,
             t.thesis_direction_correct
      FROM trades t
      JOIN broker_accounts ba ON ba.id = t.broker_account_id
      JOIN broker_connections bc ON bc.id = ba.broker_connection_id
      WHERE t.closed_at IS NOT NULL`;
    const params: unknown[] = [];
    let idx = 1;
    if (since) {
      sql += ` AND t.closed_at >= $${idx++}`;
      params.push(since.toISOString());
    }
    if (query.client_id) {
      sql += ` AND bc.client_id = $${idx++}`;
      params.push(query.client_id);
    }
    if (query.account_id) {
      sql += ` AND t.broker_account_id = $${idx++}`;
      params.push(query.account_id);
    }
    if (query.epic) {
      sql += ` AND t.epic = $${idx++}`;
      params.push(query.epic);
    }
    sql += ` ORDER BY t.closed_at DESC LIMIT 5000`;
    const { rows } = await pool.query(sql, params);
    // Default 20 / OOS 8 — N>=5 alone is never enough for has_edge
    const minTrades = Math.max(1, parseInt(query.min_trades || '20', 10) || 20);
    return computeConditionalEv(rows as HtfTaggedTrade[], {
      window,
      since: since ? since.toISOString() : null,
      min_trades: minTrades,
    });
  });

  /** Offline TS-brain smoke replay (synthetic bars) — measurement only, no orders. */
  app.post('/api/trades/replay/smoke', async () => {
    const bars = syntheticTrendBars({ n: 360, step: 0.12 });
    const result = replayStrategy(bars, { spread_pts: 0.15 });
    return {
      ok: true,
      bars: result.bars,
      trades: result.trades.length,
      entries_attempted: result.entries_attempted,
      expectancy: result.expectancy.total,
      by_regime: result.expectancy.by_regime.slice(0, 8),
    };
  });

  app.get('/api/trades', async (request) => {
    const query = request.query as {
      client_id?: string;
      instrument_id?: string;
      direction?: string;
      epic?: string;
      limit?: string;
    };
    let sql = `SELECT t.*, c.name as client_name, ba.display_name as account_name
               FROM trades t
               JOIN broker_accounts ba ON ba.id = t.broker_account_id
               JOIN broker_connections bc ON bc.id = ba.broker_connection_id
               JOIN clients c ON c.id = bc.client_id
               WHERE 1=1`;
    const params: unknown[] = [];
    let idx = 1;

    if (query.client_id) {
      sql += ` AND bc.client_id = $${idx++}`;
      params.push(query.client_id);
    }
    if (query.instrument_id) {
      sql += ` AND t.instrument_id = $${idx++}`;
      params.push(query.instrument_id);
    }
    if (query.direction) {
      sql += ` AND t.direction = $${idx++}`;
      params.push(query.direction);
    }
    if (query.epic) {
      sql += ` AND t.epic = $${idx++}`;
      params.push(query.epic);
    }

    sql += ` ORDER BY t.closed_at DESC NULLS LAST LIMIT $${idx}`;
    params.push(parseInt(query.limit || '100', 10));

    const { rows } = await pool.query(sql, params);
    return rows;
  });

  app.get('/api/trades/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await pool.query('SELECT * FROM trades WHERE id = $1', [id]);
    if (rows.length === 0) return { error: 'Not found' };

    const trade = rows[0];
    const intent = trade.setup_id
      ? await pool.query('SELECT * FROM trade_intents WHERE setup_id = $1 LIMIT 1', [trade.setup_id])
      : { rows: [] };
    const evidence = intent.rows[0]?.evidence_report_id
      ? await pool.query('SELECT * FROM evidence_reports WHERE id = $1', [intent.rows[0].evidence_report_id])
      : { rows: [] };

    return {
      trade,
      intent: intent.rows[0] || null,
      evidence: evidence.rows[0] || null,
    };
  });

  app.get('/api/intents', async () => {
    const { rows } = await pool.query(
      'SELECT * FROM trade_intents ORDER BY created_at DESC LIMIT 50'
    );
    return rows;
  });
}
