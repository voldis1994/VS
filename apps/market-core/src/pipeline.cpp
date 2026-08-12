#include "mr/market_core/pipeline.hpp"

namespace mr {

MarketCorePipeline::MarketCorePipeline()
    : normalization_(clock_),
      market_state_(snapshot_ids_),
      setup_engine_(setup_ids_),
      evidence_engine_(report_ids_),
      entry_engine_(intent_ids_, probability_model_) {}

void MarketCorePipeline::configure(const ConfigRegistry& config) {
    config.validate();
    for (const auto& feed : config.feeds()) {
        stale_threshold_ms_ = feed.stale_threshold_ms;
    }
    health_.set_component("market_core", HealthStatus::Healthy);
}

FeatureEngine& MarketCorePipeline::features_for(InstrumentId instrument) {
    return feature_engines_[instrument];
}

void MarketCorePipeline::set_recording_path(const std::string& path) {
    recorder_ = std::make_unique<RawEventWriter>(path);
}

void MarketCorePipeline::enable_recording(bool enable) {
    recording_enabled_ = enable;
}

void MarketCorePipeline::process_event(const MarketEvent& event) {
    if (recording_enabled_ && recorder_) {
        recorder_->write(event);
    }

    auto normalized = normalization_.normalize(event);
    data_quality_.process(normalized, stale_threshold_ms_);
    auto health = data_quality_.health(event.source);

    feed_fusion_.ingest(normalized, health);
    auto consensus = feed_fusion_.consensus(event.instrument);
    auto divergence = feed_fusion_.divergence(event.instrument);
    auto lead_lag = feed_fusion_.lead_lag(event.instrument);

    auto& fe = features_for(event.instrument);
    fe.update(normalized, consensus.mid_price, divergence.mean_divergence,
              lead_lag.lead_probability);
    auto features = fe.snapshot();

    auto state = market_state_.update(event.instrument, features, consensus,
                                       divergence, lead_lag, data_quality_);
    auto regime = regime_engine_.update(event.instrument, state);

    auto new_setups = setup_engine_.update(event.instrument, state, regime);
    for (auto& setup : new_setups) {
        evidence_engine_.observe(setup.id, state, regime, setup);
    }

    auto active = setup_engine_.active_setups(event.instrument);
    for (const auto& setup : active) {
        evidence_engine_.observe(setup.id, state, regime, setup);
        auto evidence = evidence_engine_.evaluate(setup.id, setup, state);
        if (!evidence.is_valid) continue;

        BrokerQuote quote;
        quote.bid = consensus.mid_price - consensus.spread / 2.0;
        quote.ask = consensus.mid_price + consensus.spread / 2.0;
        quote.timestamp = state.timestamp;
        quote.valid = consensus.mid_price > 0;

        auto intent = entry_engine_.evaluate(setup, evidence, state, regime,
                                              quote, consensus.spread);
        if (intent.decision == EntryDecision::EntryReady) {
            // Bound pending intents for memory safety; consumers drain this queue.
            if (pending_intents_.size() < 1024) {
                pending_intents_.push_back(intent);
            }
        }
    }

    telemetry_.record_event();
    telemetry_.record_decision();
}

MarketState MarketCorePipeline::latest_state(InstrumentId instrument) const {
    return market_state_.latest(instrument);
}

RegimeState MarketCorePipeline::latest_regime(InstrumentId instrument) const {
    return regime_engine_.current(instrument);
}

std::vector<SetupCandidate> MarketCorePipeline::active_setups(InstrumentId instrument) const {
    return setup_engine_.active_setups(instrument);
}

std::vector<TradeIntent> MarketCorePipeline::pending_intents() const {
    return pending_intents_;
}

std::vector<TradeIntent> MarketCorePipeline::drain_pending_intents() {
    std::vector<TradeIntent> out;
    out.swap(pending_intents_);
    return out;
}

}  // namespace mr
