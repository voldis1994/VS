#include "mr/market_state/market_state_engine.hpp"

namespace mr {

MarketStateEngine::MarketStateEngine(IdGenerator& snapshot_ids)
    : snapshot_ids_(snapshot_ids) {}

MarketState MarketStateEngine::update(
    InstrumentId instrument, const FeatureSnapshot& features,
    const FeedConsensus& consensus, const FeedDivergence& divergence,
    const LeadLagState& lead_lag, const DataQualityEngine& dq) {
    MarketState state;
    state.snapshot_id = snapshot_ids_.generate();
    state.instrument = instrument;
    state.timestamp = features.timestamp;
    state.features = features;

    state.direction.pressure = features.price.directional_persistence;
    if (features.price.velocity > 0) state.direction.direction = Direction::Long;
    else if (features.price.velocity < 0) state.direction.direction = Direction::Short;
    state.direction.confidence = std::min(1.0, std::abs(features.price.directional_persistence));

    state.structure.range_position = features.price.displacement;
    state.structure.breakout_strength = features.structure.breakout_strength;
    state.structure.in_range = features.structure.range_width > 0 &&
        features.structure.range_boundary_distance < features.structure.range_width * 0.3;
    state.structure.breakout_active = features.structure.breakout_strength > 0.5;

    state.volatility.level = features.volatility.realized_volatility;
    state.volatility.trend = features.volatility.volatility_acceleration;
    state.volatility.compressed = features.volatility.compression > features.volatility.expansion;
    state.volatility.expanding = features.volatility.expansion > features.volatility.compression;

    state.flow.buy_pressure = features.microstructure.aggressive_buy_pressure;
    state.flow.sell_pressure = features.microstructure.aggressive_sell_pressure;
    state.flow.net_flow = state.flow.buy_pressure - state.flow.sell_pressure;
    state.flow.trade_intensity = features.microstructure.trade_intensity;

    state.liquidity.spread = features.microstructure.spread;
    state.liquidity.imbalance = features.microstructure.bid_ask_imbalance;
    state.liquidity.absorption = features.microstructure.absorption_proxy;

    state.multi_feed.consensus_confidence = consensus.confidence;
    state.multi_feed.divergence = divergence.mean_divergence;
    state.multi_feed.lead_lag_probability = lead_lag.lead_probability;
    state.multi_feed.active_sources = consensus.contributing_sources;

    state.data_quality.overall_score = consensus.confidence;
    state.data_quality.stale = consensus.contributing_sources == 0;
    state.data_quality.degraded = divergence.max_divergence > 0.001;

    latest_[instrument] = state;
    snapshots_[state.snapshot_id] = state;
    return state;
}

MarketState MarketStateEngine::latest(InstrumentId instrument) const {
    auto it = latest_.find(instrument);
    if (it == latest_.end()) return {};
    return it->second;
}

MarketState MarketStateEngine::snapshot(SnapshotId id) const {
    auto it = snapshots_.find(id);
    if (it == snapshots_.end()) return {};
    return it->second;
}

}  // namespace mr
