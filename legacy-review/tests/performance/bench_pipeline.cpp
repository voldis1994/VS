#include <benchmark/benchmark.h>
#include "mr/feature_engine/feature_engine.hpp"
#include "mr/market_state/market_state_engine.hpp"
#include "mr/regime_engine/regime_engine.hpp"
#include "mr/data_quality/data_quality_engine.hpp"

static void BM_FeatureEngineUpdate(benchmark::State& state) {
    mr::FeatureEngine fe;
    mr::NormalizedEvent event;
    event.instrument = 1;
    event.normalized_timestamp = mr::now_utc_ns();
    event.bid = 1.0850;
    event.ask = 1.0851;
    event.type = mr::MarketEventType::Quote;
    for (auto _ : state) {
        fe.update(event, 1.08505, 0.0, 0.5);
    }
}
BENCHMARK(BM_FeatureEngineUpdate);

static void BM_FullPipelineSlice(benchmark::State& state) {
    mr::IdGenerator ids;
    mr::FeatureEngine fe;
    mr::MarketStateEngine mse(ids);
    mr::RegimeEngine re;
    mr::DataQualityEngine dq;
    mr::FeedConsensus consensus;
    consensus.mid_price = 1.08505;
    consensus.confidence = 0.9;
    mr::FeedDivergence divergence;
    mr::LeadLagState ll;
    mr::NormalizedEvent event;
    event.instrument = 1;
    event.normalized_timestamp = mr::now_utc_ns();
    event.bid = 1.0850;
    event.ask = 1.0851;
    for (auto _ : state) {
        fe.update(event, consensus.mid_price, 0, 0.5);
        auto features = fe.snapshot();
        auto ms = mse.update(1, features, consensus, divergence, ll, dq);
        re.update(1, ms);
    }
}
BENCHMARK(BM_FullPipelineSlice);

BENCHMARK_MAIN();
