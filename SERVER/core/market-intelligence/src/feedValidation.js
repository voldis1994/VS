/**
 * Multi-feed validation — never merges providers into a fake single feed.
 * Primary trading price requires agreement / quality gates.
 */
function median(nums) {
    if (!nums.length)
        return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stdev(nums) {
    if (nums.length < 2)
        return null;
    const m = nums.reduce((a, b) => a + b, 0) / nums.length;
    const v = nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1);
    return Math.sqrt(v);
}
/**
 * Validate multi-provider ticks for one instrument at one decision time.
 * Does not invent missing providers' prices.
 */
export function validateMultiFeed(input) {
    const now = input.nowMs ?? Date.now();
    const maxStale = input.maxStaleMs ?? 5000;
    const maxRel = input.maxRelativeDisagreement ?? 0.001;
    const expected = input.expectedProviders ?? [];
    const live = input.ticks.filter((t) => {
        if (t.instrument !== input.instrument)
            return false;
        if (!(t.bid > 0) || !(t.ask > 0) || t.ask < t.bid)
            return false;
        if (t.source_quality === 'ERROR')
            return false;
        return true;
    });
    if (live.length === 0) {
        return {
            instrument: input.instrument,
            timestamp: new Date(now).toISOString(),
            providers: [],
            median_mid: null,
            max_deviation: null,
            dispersion: null,
            staleness_ms: null,
            latency_ms_max: null,
            spread_anomaly: false,
            quote_disagreement: false,
            missing_providers: expected,
            outlier_score: null,
            provenance: [],
            trading_price: null,
            quality: 'INSUFFICIENT_DATA',
            block: 'FEED_UNAVAILABLE',
            detail: 'no valid provider ticks',
        };
    }
    const mids = live.map((t) => t.mid);
    const med = median(mids);
    const disp = stdev(mids);
    const maxDev = med == null ? null : Math.max(...mids.map((m) => Math.abs(m - med)));
    const ages = live.map((t) => Math.max(0, now - Date.parse(t.timestamp_source)));
    const staleMs = Math.max(...ages);
    const latencies = live.map((t) => t.latency_ms).filter((x) => x != null);
    const latencyMax = latencies.length ? Math.max(...latencies) : null;
    const spreads = live.map((t) => t.spread);
    const spreadMed = median(spreads);
    const spreadAnomaly = spreadMed != null && spreads.some((s) => s > spreadMed * 3 + 1e-9);
    const quoteDisagreement = med != null &&
        maxDev != null &&
        (input.maxDisagreement != null
            ? maxDev > input.maxDisagreement
            : maxDev / Math.max(Math.abs(med), 1e-9) > maxRel);
    const present = [...new Set(live.map((t) => t.provider))];
    const missing = expected.filter((p) => !present.includes(p));
    const outlierScore = med != null && disp != null && disp > 0 && maxDev != null ? maxDev / disp : null;
    let quality = 'OK';
    let block = null;
    let detail = 'multi-feed ok';
    if (staleMs > maxStale) {
        quality = 'BLOCK';
        block = 'DATA_QUALITY_BLOCK';
        detail = `staleness ${staleMs}ms > ${maxStale}ms`;
    }
    else if (quoteDisagreement) {
        quality = 'BLOCK';
        block = 'DATA_QUALITY_BLOCK';
        detail = `quote disagreement maxDev=${maxDev}`;
    }
    else if (spreadAnomaly || (outlierScore != null && outlierScore > 4)) {
        quality = 'DEGRADED';
        detail = spreadAnomaly ? 'spread anomaly' : `outlier_score=${outlierScore}`;
    }
    else if (live.length < 2 && expected.length >= 2) {
        quality = 'INSUFFICIENT_DATA';
        block = 'INSUFFICIENT_DATA';
        detail = 'need >=2 independent feeds for consensus';
    }
    // Trading price = median of live mids — never a single blind feed when multi available
    const tradingPrice = quality === 'BLOCK' || quality === 'INSUFFICIENT_DATA' ? null : med;
    return {
        instrument: input.instrument,
        timestamp: new Date(now).toISOString(),
        providers: present,
        median_mid: med,
        max_deviation: maxDev,
        dispersion: disp,
        staleness_ms: staleMs,
        latency_ms_max: latencyMax,
        spread_anomaly: spreadAnomaly,
        quote_disagreement: quoteDisagreement,
        missing_providers: missing,
        outlier_score: outlierScore,
        provenance: present,
        trading_price: tradingPrice,
        quality,
        block,
        detail,
    };
}
export function rawTickFromParts(input) {
    if (!(input.bid > 0) || !(input.ask > 0) || input.ask < input.bid)
        return null;
    const recv = input.timestamp_receive || new Date().toISOString();
    const src = Date.parse(input.timestamp_source);
    const rcv = Date.parse(recv);
    return {
        timestamp_source: input.timestamp_source,
        timestamp_receive: recv,
        provider: input.provider,
        instrument: input.instrument,
        bid: input.bid,
        ask: input.ask,
        mid: (input.bid + input.ask) / 2,
        spread: input.ask - input.bid,
        sequence_id: input.sequence_id ?? null,
        source_quality: input.source_quality || 'OK',
        latency_ms: Number.isFinite(src) && Number.isFinite(rcv) ? Math.max(0, rcv - src) : null,
    };
}
