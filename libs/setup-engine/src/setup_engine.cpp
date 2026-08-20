#include "mr/setup_engine/setup_engine.hpp"
#include <algorithm>

namespace mr {

SetupEngine::SetupEngine(IdGenerator& setup_ids) : setup_ids_(setup_ids) {}

bool SetupEngine::detect_continuation_setup(
    const MarketState& state, const RegimeState& regime, SetupCandidate& setup) const {
    const auto& ohlc = state.features.ohlc_10s;
    // Prefer reading closed 10s bar: continuation = bar in trend direction, not exhausted
    if (ohlc.has_closed) {
        const double bp = ohlc.last_closed.body_pct();
        if (regime.current == Regime::PullbackUptrend && state.flow.net_flow > 0 &&
            bp > 0.0 && bp < 0.0008 && state.structure.range_position < 0.85) {
            setup.setup_type = "CONTINUATION";
            setup.direction = Direction::Long;
            setup.regime = regime.current;
            setup.confidence = std::min(1.0, regime.confidence + 0.1);
            return true;
        }
        if (regime.current == Regime::PullbackDowntrend && state.flow.net_flow < 0 &&
            bp < 0.0 && bp > -0.0008 && state.structure.range_position > 0.15) {
            setup.setup_type = "CONTINUATION";
            setup.direction = Direction::Short;
            setup.regime = regime.current;
            setup.confidence = std::min(1.0, regime.confidence + 0.1);
            return true;
        }
    }
    // Fallback without closed bar yet
    if (regime.current == Regime::PullbackUptrend && state.flow.net_flow > 0 &&
        state.structure.range_position < 0.85) {
        setup.setup_type = "CONTINUATION";
        setup.direction = Direction::Long;
        setup.regime = regime.current;
        setup.confidence = regime.confidence;
        return true;
    }
    if (regime.current == Regime::PullbackDowntrend && state.flow.net_flow < 0 &&
        state.structure.range_position > 0.15) {
        setup.setup_type = "CONTINUATION";
        setup.direction = Direction::Short;
        setup.regime = regime.current;
        setup.confidence = regime.confidence;
        return true;
    }
    return false;
}

bool SetupEngine::detect_pullback_setup(
    const MarketState& state, const RegimeState& regime, SetupCandidate& setup) const {
    const auto& ohlc = state.features.ohlc_10s;
    // Pullback = last closed 10s bar against trend (dip-buy / rally-sell)
    if (ohlc.has_closed) {
        const double bp = ohlc.last_closed.body_pct();
        if (regime.current == Regime::TrendUp && bp < -0.00015 &&
            state.structure.range_position < 0.55 && state.structure.range_position > 0.05) {
            setup.setup_type = "PULLBACK";
            setup.direction = Direction::Long;
            setup.regime = regime.current;
            setup.confidence = std::min(1.0, regime.confidence * 0.9 + 0.1);
            return true;
        }
        if (regime.current == Regime::TrendDown && bp > 0.00015 &&
            state.structure.range_position > 0.45 && state.structure.range_position < 0.95) {
            setup.setup_type = "PULLBACK";
            setup.direction = Direction::Short;
            setup.regime = regime.current;
            setup.confidence = std::min(1.0, regime.confidence * 0.9 + 0.1);
            return true;
        }
    }
    if (regime.current == Regime::TrendUp && state.structure.range_position < 0.4 &&
        state.structure.range_position > 0.05) {
        setup.setup_type = "PULLBACK";
        setup.direction = Direction::Long;
        setup.regime = regime.current;
        setup.confidence = regime.confidence * 0.85;
        return true;
    }
    if (regime.current == Regime::TrendDown && state.structure.range_position > 0.6 &&
        state.structure.range_position < 0.95) {
        setup.setup_type = "PULLBACK";
        setup.direction = Direction::Short;
        setup.regime = regime.current;
        setup.confidence = regime.confidence * 0.85;
        return true;
    }
    return false;
}

void SetupEngine::expire_stale(Timestamp now) {
    for (auto& [inst, candidates] : setups_) {
        candidates.erase(
            std::remove_if(candidates.begin(), candidates.end(),
                [now](SetupCandidate& c) {
                    if (c.expiry.count() > 0 && now > c.expiry &&
                        c.lifecycle != SetupLifecycle::Triggered) {
                        c.lifecycle = SetupLifecycle::Expired;
                        return true;
                    }
                    return false;
                }),
            candidates.end());
    }
}

std::vector<SetupCandidate> SetupEngine::update(
    InstrumentId instrument, const MarketState& state, const RegimeState& regime) {
    expire_stale(state.timestamp);
    std::vector<SetupCandidate> new_setups;

    SetupCandidate candidate;
    candidate.instrument = instrument;
    candidate.created_at = state.timestamp;
    candidate.expiry = Timestamp(state.timestamp.count() + static_cast<long long>(horizon_ns_));
    candidate.supporting_snapshot_id = state.snapshot_id;
    candidate.lifecycle = SetupLifecycle::Discovered;

    bool found = detect_continuation_setup(state, regime, candidate)
              || detect_pullback_setup(state, regime, candidate);

    if (!found || candidate.confidence <= 0.3) {
        return new_setups;
    }

    // Do not spawn duplicate active setups of the same type/direction.
    for (const auto& existing : setups_[instrument]) {
        if ((existing.lifecycle == SetupLifecycle::Building ||
             existing.lifecycle == SetupLifecycle::Confirmed) &&
            existing.setup_type == candidate.setup_type &&
            existing.direction == candidate.direction) {
            return new_setups;
        }
    }

    candidate.id = setup_ids_.generate();
    candidate.lifecycle = SetupLifecycle::Building;
    if (candidate.confidence > 0.6) {
        candidate.lifecycle = SetupLifecycle::Confirmed;
    }
    setups_[instrument].push_back(candidate);
    new_setups.push_back(candidate);
    return new_setups;
}

std::vector<SetupCandidate> SetupEngine::active_setups(InstrumentId instrument) const {
    auto it = setups_.find(instrument);
    if (it == setups_.end()) return {};
    std::vector<SetupCandidate> active;
    for (const auto& s : it->second) {
        if (s.lifecycle == SetupLifecycle::Confirmed ||
            s.lifecycle == SetupLifecycle::Building) {
            active.push_back(s);
        }
    }
    return active;
}

void SetupEngine::invalidate(SetupId id, const std::string& /*reason*/) {
    for (auto& [inst, candidates] : setups_) {
        for (auto& c : candidates) {
            if (c.id == id) {
                c.lifecycle = SetupLifecycle::Invalidated;
            }
        }
    }
}

}  // namespace mr
