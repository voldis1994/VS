# Desk backtests

## Gold day (public Yahoo GC=F 1m)

```bash
cd apps/control-api
npm run backtest:gold-day
# or
npx tsx scripts/goldDayBacktest.ts --lot 0.1 --spread 0.5
```

- Data: `scripts/data/gc_f_YYYY-MM-DD_1m.csv` (Yahoo Finance public chart API)
- Report: `scripts/out/gold-*-backtest.md` + `.json`
- Brain: same as live desk — `buildStructure` → `updateSetupSticky` → `decideUnifiedEntry` (ARMED only) → `decideBestOutcomeExit`
- Rolling 120×1m window (matches Capital history cap)
- PnL model: £1 / point / 1.0 lot (lot 0.1 → £0.10/pt), default spread 0.50

Re-fetch a day:

```bash
P1=$(python3 -c "import datetime; print(int(datetime.datetime(2026,9,2,tzinfo=datetime.timezone.utc).timestamp()))")
P2=$(python3 -c "import datetime; print(int(datetime.datetime(2026,9,3,tzinfo=datetime.timezone.utc).timestamp()))")
curl -sS -A 'Mozilla/5.0' \
  "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?period1=${P1}&period2=${P2}&interval=1m&includePrePost=true" \
  -o /tmp/gc.json
```
