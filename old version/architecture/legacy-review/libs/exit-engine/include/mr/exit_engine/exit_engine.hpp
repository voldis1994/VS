#pragma once

#include "mr/position_engine/position_manager.hpp"

namespace mr {

class ExitEngine {
public:
    PositionDecision decide(const PositionState& position, const MarketState& state,
                            const RegimeState& regime, const EvidenceReport& evidence,
                            double continuation_prob, double reversal_prob);
};

}  // namespace mr
