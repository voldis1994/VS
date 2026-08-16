/** Theory constants — not trade gates by themselves. */

export const TREND_CONTINUATION_THEORY = {
  id: 'trend_continuation',
  phenomenon: 'Directional persistence on closed 10s OHLC with bounded noise',
  requires_multi_feed_consensus: true,
  forbids_label_only_entry: true,
  emergency_sl_ceiling_pct: 0.2,
} as const;
