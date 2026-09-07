/**
 * VS-System multi-TP ladder — app-managed intermediate scale-outs;
 * native broker TP should sit at the final level only.
 */

export type MultiTpLevel = {
  index: number;
  price: number;
  close_volume: number;
  status: 'PENDING' | 'EXECUTED' | 'FAILED';
};

/**
 * Split total volume into `count` whole-step slices (remainder → earliest levels).
 * Returns [] when fewer than 2 executable slices are possible.
 */
export function splitVolumeIntoSteps(
  totalVolume: number,
  count: number,
  volumeStep = 0.01
): number[] {
  const step = Math.max(volumeStep, 1e-8);
  const volume = Number(totalVolume);
  if (!Number.isFinite(volume) || volume < step * 2) return [];

  const totalSteps = Math.floor(volume / step + 1e-12);
  if (totalSteps < 2) return [];

  const requested = Math.max(2, Math.min(10, Math.floor(count)));
  const n = Math.min(requested, totalSteps);
  const baseSteps = Math.floor(totalSteps / n);
  let remainder = totalSteps - baseSteps * n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    out.push(Number(((baseSteps + extra) * step).toFixed(8)));
  }
  return out.filter((v) => v > 0).length >= 2 ? out : [];
}

/** Equal ATR-spaced multi-TP plan. Empty → fall back to single TP. */
export function buildEqualMultiTpPlan(input: {
  side: 'BUY' | 'SELL';
  entry: number;
  initial_volume: number;
  count: number;
  atr: number;
  atr_tp_mult: number;
  volume_step?: number;
}): MultiTpLevel[] {
  const step = Math.max(input.volume_step ?? 0.01, 1e-8);
  const rawVolumes = splitVolumeIntoSteps(
    input.initial_volume,
    input.count,
    step
  );
  if (rawVolumes.length < 2) return [];

  const count = rawVolumes.length;
  const atrDist = Math.max(input.atr * Math.max(input.atr_tp_mult, 0.1), step);
  const priceStep = atrDist / count;
  const levels: MultiTpLevel[] = [];
  for (let i = 0; i < count; i++) {
    const close_volume = rawVolumes[i] ?? 0;
    if (close_volume <= 0) continue;
    const dist = priceStep * (i + 1);
    const price =
      input.side === 'BUY' ? input.entry + dist : input.entry - dist;
    levels.push({
      index: levels.length + 1,
      price,
      close_volume,
      status: 'PENDING',
    });
  }
  return levels.length >= 2 ? levels : [];
}

export function multiTpHit(
  side: 'BUY' | 'SELL',
  mark: number,
  levelPrice: number
): boolean {
  return side === 'BUY' ? mark >= levelPrice : mark <= levelPrice;
}

/** Format volume to broker step without exceeding available (leave 1 step unless final). */
export function clampCloseVolume(
  planned: number,
  available: number,
  volumeStep = 0.01,
  final = false
): number | null {
  const step = Math.max(volumeStep, 1e-8);
  let close = Math.min(planned, available);
  close = Math.floor(close / step + 1e-12) * step;
  if (close <= 0) return null;
  if (final || close >= available - 1e-12) {
    return Number(available.toFixed(8));
  }
  const maxCloseable = available - step;
  if (close > maxCloseable && available > step) {
    close = Math.floor(maxCloseable / step + 1e-12) * step;
  }
  if (close <= 0) return null;
  return Number(close.toFixed(8));
}

export function multiTpPendingIndex(levels: MultiTpLevel[]): number {
  return levels.findIndex((l) => l.status === 'PENDING' || l.status === 'FAILED');
}

export function multiTpFinalPrice(levels: MultiTpLevel[]): number | null {
  if (!levels.length) return null;
  return levels[levels.length - 1]!.price;
}

export function minLotForMultiTp(count: number, volumeStep = 0.01): number {
  const n = Math.max(2, Math.min(10, Math.floor(count) || 2));
  const step = Math.max(volumeStep, 1e-8);
  return Number((n * step).toFixed(8));
}
