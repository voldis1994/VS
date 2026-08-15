/**
 * Raw market store with retention/rotation — keep enough to reproduce decisions.
 */

import { mkdirSync, appendFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { ValidatedTick } from './marketCore.js';

export type StoredDecision = {
  decision_id: string;
  strategy_version: string;
  config_version: string;
  market_snapshot_id: string;
  payload: Record<string, unknown>;
  at: string;
};

export class RawMarketStore {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(root: string, maxBytes = 2 * 1024 * 1024 * 1024) {
    this.root = root;
    this.maxBytes = maxBytes;
    mkdirSync(join(root, 'raw'), { recursive: true });
    mkdirSync(join(root, 'normalized'), { recursive: true });
    mkdirSync(join(root, 'decisions'), { recursive: true });
    mkdirSync(join(root, 'orders'), { recursive: true });
    mkdirSync(join(root, 'events'), { recursive: true });
  }

  appendTick(tick: ValidatedTick): void {
    const day = tick.receive_timestamp.slice(0, 10);
    const file = join(this.root, 'raw', `${tick.epic}_${day}.jsonl`);
    appendFileSync(file, `${JSON.stringify(tick)}\n`, 'utf8');
    this.rotateIfNeeded();
  }

  appendDecision(d: StoredDecision): void {
    const day = d.at.slice(0, 10);
    const file = join(this.root, 'decisions', `${day}.jsonl`);
    appendFileSync(file, `${JSON.stringify(d)}\n`, 'utf8');
    this.rotateIfNeeded();
  }

  appendEvent(event: Record<string, unknown>): void {
    const at = String(event.timestamp || new Date().toISOString());
    const day = at.slice(0, 10);
    const file = join(this.root, 'events', `${day}.jsonl`);
    appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    this.rotateIfNeeded();
  }

  /** Rotate secondary raw/event files only — never delete order/decision blindly. */
  rotateIfNeeded(): { freed: number; incident: boolean } {
    let total = this.dirSize(this.root);
    if (total < this.maxBytes * 0.92) return { freed: 0, incident: false };

    let freed = 0;
    const rawFiles = this.listSorted(join(this.root, 'raw'));
    const eventFiles = this.listSorted(join(this.root, 'events'));
    // Delete oldest raw/event files first; keep decisions/orders.
    for (const f of [...rawFiles, ...eventFiles]) {
      if (total < this.maxBytes * 0.8) break;
      const sz = statSync(f).size;
      unlinkSync(f);
      freed += sz;
      total -= sz;
    }
    return { freed, incident: total > this.maxBytes * 0.9 };
  }

  private listSorted(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((n) => join(dir, n))
      .filter((p) => statSync(p).isFile())
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  }

  private dirSize(dir: string): number {
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) n += this.dirSize(p);
      else n += st.size;
    }
    return n;
  }
}
