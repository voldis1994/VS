/** Wire Capital.com into MasterBroker using existing capitalCom session helpers. */
import {
  acquireCapitalSession,
  closeCapitalPosition,
  confirmCapitalDeal,
  createCapitalPosition,
  fetchCapitalAccountEquity,
  fetchCapitalMarketQuote,
  listCapitalOpenPositions,
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
    close: async (session, dealId) => closeCapitalPosition(session, dealId),
    confirm: async (session, ref) => confirmCapitalDeal(session, ref),
    account: async (session) => {
      const eq = await fetchCapitalAccountEquity(session, creds.capitalAccountId);
      if (!eq) return null;
      return { equity: eq.equity, balance: eq.balance, currency: eq.currency };
    },
  });
}
