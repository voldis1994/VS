/** Wire Capital.com into MasterBroker using existing capitalCom session helpers. */
import {
  acquireCapitalSession,
  closeCapitalPosition,
  confirmCapitalDeal,
  createCapitalPosition,
  fetchCapitalAccountEquity,
  fetchCapitalMarketQuote,
  fetchCapitalPrices,
  listCapitalOpenPositions,
  modifyCapitalPosition,
} from '../services/capitalCom.js';
import { CapitalBroker } from './broker.js';

export type CapitalBrokerCreds = {
  environment: string;
  apiKey: string;
  identifier: string;
  password: string;
  connectionId?: number;
  capitalAccountId?: string | null;
};

export function createCapitalBroker(creds: CapitalBrokerCreds): CapitalBroker {
  return new CapitalBroker({
    credentials: creds,
    acquire: async (input) => {
      const opened = await acquireCapitalSession(input);
      if (!opened.ok) {
        return { ok: false, detail: opened.result.detail };
      }
      return { ok: true, session: opened.session, detail: 'ok' };
    },
    quote: async (session, epic) => {
      const q = await fetchCapitalMarketQuote(session, epic);
      return {
        bid: q.bid,
        ask: q.ask,
        mid: q.mid,
        epic: q.epic || epic,
        raw_ok: q.raw_ok,
        detail: q.detail,
        min_deal_size: q.min_deal_size,
        max_deal_size: q.max_deal_size,
        deal_size_step: q.deal_size_step,
        point_size: q.point_size,
        min_stop_distance: q.min_stop_distance,
      };
    },
    list: async (session) => listCapitalOpenPositions(session),
    create: async (session, input) =>
      createCapitalPosition(session, {
        epic: input.epic,
        direction: input.direction,
        size: input.size,
        stopLevel: input.stopLevel,
        profitLevel: input.profitLevel,
      }),
    close: async (session, dealId, size) => closeCapitalPosition(session, dealId, size),
    modify: async (session, input) =>
      modifyCapitalPosition(session, {
        dealId: input.dealId,
        stopLevel: input.stopLevel,
        profitLevel: input.profitLevel,
        stopDistance: input.stopDistance,
        trailingStop: input.trailingStop,
      }),
    confirm: async (session, ref) => confirmCapitalDeal(session, ref),
    prices: async (session, epic, resolution, max) =>
      fetchCapitalPrices(session, epic, resolution, max),
    ensureAccount: async (session) => {
      const id = String(creds.capitalAccountId || '').trim();
      if (!id) return { ok: true, detail: 'no_account_id' };
      const { switchCapitalAccount } = await import('../services/capitalCom.js');
      return switchCapitalAccount(session, id);
    },
    account: async (session) => {
      const eq = await fetchCapitalAccountEquity(session, creds.capitalAccountId);
      if (!eq) return null;
      return {
        equity: eq.equity,
        balance: eq.balance,
        currency: eq.currency,
        available: eq.available,
      };
    },
  });
}
