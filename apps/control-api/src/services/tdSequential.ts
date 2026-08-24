/**
 * TD Sequential (Tom DeMark) on OHLC bars.
 *
 * Buy Setup: after a bearish price flip, 9 consecutive closes each < close 4 bars earlier.
 * Sell Setup: after a bullish price flip, 9 consecutive closes each > close 4 bars earlier.
 *
 * Buy Countdown (after buy setup complete): 13 closes ≤ low 2 bars earlier.
 * Sell Countdown (after sell setup complete): 13 closes ≥ high 2 bars earlier.
 *
 * Entry: Countdown 13 preferred; else Setup 9 completion on the latest bar.
 */
import type { RegimeEntry } from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

export type TdSequentialState = {
  buy_setup: number;
  sell_setup: number;
  buy_countdown: number;
  sell_countdown: number;
  buy_setup_complete: boolean;
  sell_setup_complete: boolean;
  buy_countdown_complete: boolean;
  sell_countdown_complete: boolean;
  phase: string;
};

type Phase = 'none' | 'buy_setup' | 'sell_setup' | 'buy_countdown' | 'sell_countdown';

/** Compute TD Sequential state through the last bar. */
export function computeTdSequential(bars: TenSecBar[]): TdSequentialState {
  const empty: TdSequentialState = {
    buy_setup: 0,
    sell_setup: 0,
    buy_countdown: 0,
    sell_countdown: 0,
    buy_setup_complete: false,
    sell_setup_complete: false,
    buy_countdown_complete: false,
    sell_countdown_complete: false,
    phase: 'none',
  };
  if (!bars || bars.length < 6) return empty;

  let buySetup = 0;
  let sellSetup = 0;
  let buyCountdown = 0;
  let sellCountdown = 0;
  let phase: Phase = 'none';
  let buySetupJustDone = false;
  let sellSetupJustDone = false;
  let buyCdJustDone = false;
  let sellCdJustDone = false;

  for (let i = 5; i < bars.length; i++) {
    buySetupJustDone = false;
    sellSetupJustDone = false;
    buyCdJustDone = false;
    sellCdJustDone = false;

    const c = bars[i]!.close;
    const c4 = bars[i - 4]!.close;
    const prevC = bars[i - 1]!.close;
    const prevC4 = bars[i - 5]!.close;

    const buyFlip = prevC >= prevC4 && c < c4;
    const sellFlip = prevC <= prevC4 && c > c4;

    // ——— SETUP ———
    if (phase === 'none') {
      if (buyFlip) {
        phase = 'buy_setup';
        buySetup = 1;
        sellSetup = 0;
      } else if (sellFlip) {
        phase = 'sell_setup';
        sellSetup = 1;
        buySetup = 0;
      }
    } else if (phase === 'buy_setup') {
      if (c < c4) {
        buySetup += 1;
        if (buySetup >= 9) {
          buySetup = 9;
          buySetupJustDone = true;
          phase = 'buy_countdown';
          buyCountdown = 0;
        }
      } else if (sellFlip) {
        phase = 'sell_setup';
        sellSetup = 1;
        buySetup = 0;
      } else {
        phase = 'none';
        buySetup = 0;
      }
    } else if (phase === 'sell_setup') {
      if (c > c4) {
        sellSetup += 1;
        if (sellSetup >= 9) {
          sellSetup = 9;
          sellSetupJustDone = true;
          phase = 'sell_countdown';
          sellCountdown = 0;
        }
      } else if (buyFlip) {
        phase = 'buy_setup';
        buySetup = 1;
        sellSetup = 0;
      } else {
        phase = 'none';
        sellSetup = 0;
      }
    } else if (phase === 'buy_countdown') {
      // Opposing sell setup can recycle
      if (sellFlip) {
        // start tracking opposing setup in parallel — if it completes, cancel CD
        // Simplified: any fresh sell flip resets to sell setup
        phase = 'sell_setup';
        sellSetup = 1;
        buyCountdown = 0;
        buySetup = 0;
      } else if (c <= bars[i - 2]!.low) {
        buyCountdown += 1;
        if (buyCountdown >= 13) {
          buyCountdown = 13;
          buyCdJustDone = true;
          phase = 'none';
          buySetup = 0;
        }
      }
    } else if (phase === 'sell_countdown') {
      if (buyFlip) {
        phase = 'buy_setup';
        buySetup = 1;
        sellCountdown = 0;
        sellSetup = 0;
      } else if (c >= bars[i - 2]!.high) {
        sellCountdown += 1;
        if (sellCountdown >= 13) {
          sellCountdown = 13;
          sellCdJustDone = true;
          phase = 'none';
          sellSetup = 0;
        }
      }
    }
  }

  return {
    buy_setup: buySetup,
    sell_setup: sellSetup,
    buy_countdown: buyCountdown,
    sell_countdown: sellCountdown,
    buy_setup_complete: buySetupJustDone,
    sell_setup_complete: sellSetupJustDone,
    buy_countdown_complete: buyCdJustDone,
    sell_countdown_complete: sellCdJustDone,
    phase,
  };
}

export function describeTdSequential(s: TdSequentialState): string {
  if (s.buy_countdown_complete) return 'TD Buy Countdown 13';
  if (s.sell_countdown_complete) return 'TD Sell Countdown 13';
  if (s.buy_setup_complete) return 'TD Buy Setup 9';
  if (s.sell_setup_complete) return 'TD Sell Setup 9';
  if (s.phase === 'buy_countdown') return `TD Buy CD ${s.buy_countdown}/13`;
  if (s.phase === 'sell_countdown') return `TD Sell CD ${s.sell_countdown}/13`;
  if (s.phase === 'buy_setup') return `TD Buy Setup ${s.buy_setup}/9`;
  if (s.phase === 'sell_setup') return `TD Sell Setup ${s.sell_setup}/9`;
  return 'TD idle';
}

/**
 * Entry from TD Sequential on the latest closed bar.
 * Countdown 13 > Setup 9. Null when no completion this bar.
 */
export function decideEntryFromTdSequential(bars: TenSecBar[] | null | undefined): RegimeEntry | null {
  if (!bars || bars.length < 14) return null;
  const s = computeTdSequential(bars);
  const last = bars[bars.length - 1]!;
  const candle = `10s O=${last.open.toFixed(2)} C=${last.close.toFixed(2)}`;

  if (s.buy_countdown_complete) {
    return {
      direction: 'BUY',
      setup: 'REVERSAL',
      reason: `TD Buy Countdown 13 · ${candle}`,
    };
  }
  if (s.sell_countdown_complete) {
    return {
      direction: 'SELL',
      setup: 'REVERSAL',
      reason: `TD Sell Countdown 13 · ${candle}`,
    };
  }
  if (s.buy_setup_complete) {
    return {
      direction: 'BUY',
      setup: 'REVERSAL',
      reason: `TD Buy Setup 9 · ${candle}`,
    };
  }
  if (s.sell_setup_complete) {
    return {
      direction: 'SELL',
      setup: 'REVERSAL',
      reason: `TD Sell Setup 9 · ${candle}`,
    };
  }
  return null;
}
