#pragma once

#include "mr/feature_engine/feature_engine.hpp"
#include "mr/feed_fusion/feed_fusion_engine.hpp"
#include "mr/data_quality/data_quality_engine.hpp"
#include "mr/clock/clock_engine.hpp"

namespace mr {

struct DirectionState {
    Direction direction{Direction::Flat};
    double pressure{0};
    double confidence{0};
};

struct StructureState {
    double range_position{0.5};
    double breakout_strength{0};
    bool in_range{true};
    bool breakout_active{false};
};

struct VolatilityState {
    double level{0};
    double trend{0};
    bool compressed{false};
    bool expanding{false};
};

struct FlowState {
    double buy_pressure{0};
    double sell_pressure{0};
    double net_flow{0};
    double trade_intensity{0};
};

struct LiquidityState {
    double spread{0};
    double spread_velocity{0};
    double imbalance{0};
    double absorption{0};
};

struct MultiFeedState {
    double consensus_confidence{0};
    double divergence{0};
    double lead_lag_probability{0};
    std::uint32_t active_sources{0};
};

struct DataQualityState {
    double overall_score{1.0};
    bool stale{false};
    bool degraded{false};
    std::uint32_t unhealthy_sources{0};
};

struct LatencyState {
    double feed_latency_ms{0};
    double processing_latency_ms{0};
};

struct MarketState {
    SnapshotId snapshot_id{0};
    InstrumentId instrument{kInvalidInstrument};
    Timestamp timestamp{};
    DirectionState direction;
    StructureState structure;
    VolatilityState volatility;
    FlowState flow;
    LiquidityState liquidity;
    MultiFeedState multi_feed;
    DataQualityState data_quality;
    LatencyState latency;
    FeatureSnapshot features;
};

class MarketStateEngine {
public:
    MarketStateEngine(IdGenerator& snapshot_ids);
    MarketState update(InstrumentId instrument, const FeatureSnapshot& features,
                       const FeedConsensus& consensus, const FeedDivergence& divergence,
                       const LeadLagState& lead_lag, const DataQualityEngine& dq);
    [[nodiscard]] MarketState latest(InstrumentId instrument) const;
    [[nodiscard]] MarketState snapshot(SnapshotId id) const;

private:
    IdGenerator& snapshot_ids_;
    std::unordered_map<InstrumentId, MarketState> latest_;
    std::unordered_map<SnapshotId, MarketState> snapshots_;
};

}  // namespace mr
