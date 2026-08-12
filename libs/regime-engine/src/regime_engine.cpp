#include "mr/regime_engine/regime_engine.hpp"

namespace mr {

Regime RegimeEngine::classify(const MarketState& state, Regime previous) const {
    const auto& f = state.features;
    bool trending_up = f.price.directional_persistence > 0.5 && f.price.velocity > 0;
    bool trending_down = f.price.directional_persistence < -0.5 && f.price.velocity < 0;
    bool compressed = state.volatility.compressed;
    bool expanding = state.volatility.expanding;
    bool in_range = state.structure.in_range;
    bool breakout = state.structure.breakout_active;

    if (compressed && in_range) return Regime::Compression;
    if (expanding && breakout && trending_up) return Regime::BreakoutUp;
    if (expanding && breakout && trending_down) return Regime::BreakoutDown;
    if (expanding) return Regime::Expansion;
    if (trending_up && f.price.velocity < 0 && previous == Regime::TrendUp)
        return Regime::PullbackUptrend;
    if (trending_down && f.price.velocity > 0 && previous == Regime::TrendDown)
        return Regime::PullbackDowntrend;
    if (trending_up) return Regime::TrendUp;
    if (trending_down) return Regime::TrendDown;
    if (f.structure.reversal_candidate > 0.5) return Regime::ReversalCandidate;
    if (in_range) return Regime::Range;
    if (previous != Regime::Unknown && previous != Regime::Range)
        return Regime::Transition;
    return Regime::Unknown;
}

RegimeState RegimeEngine::update(InstrumentId instrument, const MarketState& state) {
    auto& rs = regimes_[instrument];
    Regime new_regime = classify(state, rs.current);

    if (new_regime != rs.current) {
        RegimeTransition tr;
        tr.from = rs.current;
        tr.to = new_regime;
        tr.timestamp = state.timestamp;
        tr.probability = state.direction.confidence;
        transition_history_[instrument].push_back(tr);
        if (transition_history_[instrument].size() > 100) {
            transition_history_[instrument].erase(
                transition_history_[instrument].begin());
        }
        rs.previous = rs.current;
        rs.current = new_regime;
        rs.since = state.timestamp;
    }

    rs.confidence = state.direction.confidence;
    rs.transition_probability = 0.1;
    return rs;
}

RegimeState RegimeEngine::current(InstrumentId instrument) const {
    auto it = regimes_.find(instrument);
    if (it == regimes_.end()) return {};
    return it->second;
}

std::vector<RegimeTransition> RegimeEngine::transitions(InstrumentId instrument) const {
    auto it = transition_history_.find(instrument);
    if (it == transition_history_.end()) return {};
    return it->second;
}

}  // namespace mr
