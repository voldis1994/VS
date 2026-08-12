#pragma once

#include "mr/clock/clock_engine.hpp"
#include "mr/normalization/normalization_engine.hpp"
#include "mr/data_quality/data_quality_engine.hpp"
#include "mr/feed_fusion/feed_fusion_engine.hpp"
#include "mr/feature_engine/feature_engine.hpp"
#include "mr/market_state/market_state_engine.hpp"
#include "mr/regime_engine/regime_engine.hpp"
#include "mr/setup_engine/setup_engine.hpp"
#include "mr/evidence_engine/evidence_engine.hpp"
#include "mr/entry_engine/entry_engine.hpp"
#include "mr/telemetry/telemetry_hub.hpp"
#include "mr/storage/raw_event_storage.hpp"
#include "mr/common/config.hpp"
#include <memory>
#include <unordered_map>

namespace mr {

class MarketCorePipeline {
public:
    MarketCorePipeline();
    void configure(const ConfigRegistry& config);
    void process_event(const MarketEvent& event);
    [[nodiscard]] MarketState latest_state(InstrumentId instrument) const;
    [[nodiscard]] RegimeState latest_regime(InstrumentId instrument) const;
    [[nodiscard]] std::vector<SetupCandidate> active_setups(InstrumentId instrument) const;
    [[nodiscard]] std::vector<TradeIntent> pending_intents() const;
    /** Return EntryReady intents and clear the pending queue (for publishers). */
    std::vector<TradeIntent> drain_pending_intents();
    [[nodiscard]] ClockEngine& clock() { return clock_; }
    [[nodiscard]] TelemetryHub& telemetry() { return telemetry_; }
    [[nodiscard]] HealthManager& health() { return health_; }
    void set_recording_path(const std::string& path);
    void enable_recording(bool enable);

private:
    ClockEngine clock_;
    NormalizationEngine normalization_;
    DataQualityEngine data_quality_;
    FeedFusionEngine feed_fusion_;
    std::unordered_map<InstrumentId, FeatureEngine> feature_engines_;
    MarketStateEngine market_state_;
    RegimeEngine regime_engine_;
    SetupEngine setup_engine_;
    EvidenceEngine evidence_engine_;
    BaselineProbabilityModel probability_model_;
    EntryEngine entry_engine_;
    TelemetryHub telemetry_;
    HealthManager health_;

    IdGenerator snapshot_ids_;
    IdGenerator setup_ids_;
    IdGenerator report_ids_;
    IdGenerator intent_ids_;

    std::vector<TradeIntent> pending_intents_;
    std::unique_ptr<RawEventWriter> recorder_;
    bool recording_enabled_{false};
    double stale_threshold_ms_{500.0};

    FeatureEngine& features_for(InstrumentId instrument);
};

}  // namespace mr
