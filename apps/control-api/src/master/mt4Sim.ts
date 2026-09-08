/**
 * Local MT4/Check- bridge simulator — proves LIVE broker path without Capital.
 * Reads OPEN/MODIFY/CLOSE commands, writes market/status/acks (CHECK.mq4 protocol).
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  existsSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';

export type SimPosition = {
  ticket: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  lot: number;
  open: number;
  sl: number;
  tp: number;
  profit: number;
  open_time: number;
};

export class Mt4BridgeSimulator {
  private ticketSeq = 100000;
  private positions = new Map<number, SimPosition>();
  private bid = 4470;
  private ask = 4470.4;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Test fault: OPEN ignores payload SL (naked ticket until MODIFY). */
  ignoreOpenSl = false;
  /** Test fault: MODIFY ACK without mutating SL/TP (prove status verification). */
  ackModifyWithoutApply = false;
  /** Test fault: ACK fill differs from status open (prove fill preference). */
  ackFillOverride: number | null = null;

  constructor(private readonly root: string) {
    mkdirSync(join(root, 'commands'), { recursive: true });
    mkdirSync(join(root, 'acks'), { recursive: true });
    mkdirSync(join(root, 'market'), { recursive: true });
    mkdirSync(join(root, 'status'), { recursive: true });
  }

  setQuote(bid: number, ask: number) {
    this.bid = bid;
    this.ask = ask;
    this.markProfits();
    this.writeMarket();
    this.writeStatus();
  }

  start(pollMs = 200) {
    this.writeMarket();
    this.writeStatus();
    this.timer = setInterval(() => this.poll(), pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  listPositions() {
    return [...this.positions.values()];
  }

  private markProfits() {
    const mid = (this.bid + this.ask) / 2;
    for (const p of this.positions.values()) {
      p.profit = p.side === 'BUY' ? (mid - p.open) * p.lot : (p.open - mid) * p.lot;
    }
  }

  private writeMarket() {
    const path = join(this.root, 'market', 'latest.json');
    const tmp = path + '.tmp';
    writeFileSync(
      tmp,
      JSON.stringify({
        bid: this.bid,
        ask: this.ask,
        symbol: 'XAUUSD',
        time: new Date().toISOString(),
      }) + '\n'
    );
    renameSync(tmp, path);
  }

  private writeStatus() {
    const path = join(this.root, 'status', 'latest.json');
    const tmp = path + '.tmp';
    writeFileSync(
      tmp,
      JSON.stringify({
        equity: 10_000 + [...this.positions.values()].reduce((s, p) => s + p.profit, 0),
        balance: 10_000,
        currency: 'USD',
        margin: 0,
        margin_free: 10_000,
        connected: true,
        trading_allowed: true,
        positions: [...this.positions.values()].map((p) => ({
          ticket: p.ticket,
          symbol: p.symbol,
          side: p.side,
          lot: p.lot,
          open: p.open,
          sl: p.sl,
          tp: p.tp,
          profit: p.profit,
          open_time: p.open_time,
        })),
      }) + '\n'
    );
    renameSync(tmp, path);
  }

  private writeAck(
    id: string,
    ok: boolean,
    ticket = 0,
    detail = '',
    extra?: { fill?: number | null; profit?: number | null }
  ) {
    const path = join(this.root, 'acks', `ack_${id}.json`);
    const tmp = path + '.tmp';
    const body: Record<string, unknown> = { id, ok, ticket, detail, error: detail };
    if (extra?.fill != null && Number.isFinite(extra.fill)) body.fill = extra.fill;
    if (extra?.profit != null && Number.isFinite(extra.profit)) body.profit = extra.profit;
    writeFileSync(tmp, JSON.stringify(body) + '\n');
    renameSync(tmp, path);
  }

  private poll() {
    const folder = join(this.root, 'commands');
    if (!existsSync(folder)) return;
    for (const f of readdirSync(folder).filter((x) => x.startsWith('cmd_') && x.endsWith('.json'))) {
      const full = join(folder, f);
      let payload: any;
      try {
        payload = JSON.parse(readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      const id = String(payload.id || f);
      try {
        this.handle(payload, id);
        unlinkSync(full);
      } catch (e) {
        this.writeAck(id, false, 0, e instanceof Error ? e.message : String(e));
        try {
          unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
    }
    this.markProfits();
    this.writeMarket();
    this.writeStatus();
  }

  private handle(payload: any, id: string) {
    const action = String(payload.action || '').toUpperCase();
    if (action === 'OPEN') {
      const side = String(payload.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      const ticket = ++this.ticketSeq;
      const open = side === 'BUY' ? this.ask : this.bid;
      const sl = this.ignoreOpenSl ? 0 : Number(payload.sl || 0);
      const tp = Number(payload.tp || 0);
      this.positions.set(ticket, {
        ticket,
        symbol: String(payload.symbol || 'XAUUSD'),
        side,
        lot: Number(payload.lot || 0.01),
        open,
        sl,
        tp,
        profit: 0,
        open_time: Math.floor(Date.now() / 1000),
      });
      const fill =
        this.ackFillOverride != null && Number.isFinite(this.ackFillOverride)
          ? this.ackFillOverride
          : open;
      this.writeAck(id, true, ticket, 'opened', { fill, profit: 0 });
      return;
    }
    if (action === 'CLOSE') {
      const ticket = Number(payload.ticket);
      const p = this.positions.get(ticket);
      if (!p) {
        this.writeAck(id, false, ticket, 'not_found');
        return;
      }
      this.markProfits();
      const fill = p.side === 'BUY' ? this.bid : this.ask;
      const profit =
        p.side === 'BUY' ? (fill - p.open) * p.lot : (p.open - fill) * p.lot;
      this.positions.delete(ticket);
      this.writeAck(id, true, ticket, 'closed', { fill, profit });
      return;
    }
    if (action === 'MODIFY') {
      const ticket = Number(payload.ticket);
      const p = this.positions.get(ticket);
      if (!p) {
        this.writeAck(id, false, ticket, 'not_found');
        return;
      }
      if (!this.ackModifyWithoutApply) {
        if (payload.sl != null) p.sl = Number(payload.sl);
        if (payload.tp != null) p.tp = Number(payload.tp);
      }
      this.writeAck(id, true, ticket, 'modified');
      return;
    }
    this.writeAck(id, false, 0, `unknown action ${action}`);
  }
}
