#pragma once

#include "mr/market_state/market_state_engine.hpp"
#include <unordered_map>

namespace mr {

enum class Regime : std::uint8_t {
    Unknown = 0,
    Range = 1,
    TrendUp = 2,
    TrendDown = 3,
    PullbackUptrend = 4,
    PullbackDowntrend = 5,
    Compression = 6,
    Expansion = 7,
    BreakoutUp = 8,
    BreakoutDown = 9,
    FailedBreakoutUp = 10,
    FailedBreakoutDown = 11,
    ReversalCandidate = 12,
    Transition = 13
};

inline const char* regime_name(Regime r) {
    switch (r) {
        case Regime::Unknown: return "UNKNOWN";
        case Regime::Range: return "RANGE";
        case Regime::TrendUp: return "TREND_UP";
        case Regime::TrendDown: return "TREND_DOWN";
        case Regime::PullbackUptrend: return "PULLBACK_UPTREND";
        case Regime::PullbackDowntrend: return "PULLBACK_DOWNTREND";
        case Regime::Compression: return "COMPRESSION";
        case Regime::Expansion: return "EXPANSION";
        case Regime::BreakoutUp: return "BREAKOUT_UP";
        case Regime::BreakoutDown: return "BREAKOUT_DOWN";
        case Regime::FailedBreakoutUp: return "FAILED_BREAKOUT_UP";
        case Regime::FailedBreakoutDown: return "FAILED_BREAKOUT_DOWN";
        case Regime::ReversalCandidate: return "REVERSAL_CANDIDATE";
        case Regime::Transition: return "TRANSITION";
    }
    return "UNKNOWN";
}

struct RegimeState {
    Regime current{Regime::Unknown};
    Regime previous{Regime::Unknown};
    double confidence{0};
    double transition_probability{0};
    Timestamp since{};
};

struct RegimeTransition {
    Regime from{Regime::Unknown};
    Regime to{Regime::Unknown};
    Timestamp timestamp{};
    double probability{0};
};

class RegimeEngine {
public:
    RegimeState update(InstrumentId instrument, const MarketState& state);
    [[nodiscard]] RegimeState current(InstrumentId instrument) const;
    [[nodiscard]] std::vector<RegimeTransition> transitions(InstrumentId instrument) const;

private:
    std::unordered_map<InstrumentId, RegimeState> regimes_;
    std::unordered_map<InstrumentId, std::vector<RegimeTransition>> transition_history_;
    Regime classify(const MarketState& state, Regime previous) const;
};

}  // namespace mr
