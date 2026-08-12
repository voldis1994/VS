#pragma once

#include "mr/common/market_event.hpp"
#include "mr/clock/clock_engine.hpp"

namespace mr {

class NormalizationEngine {
public:
    explicit NormalizationEngine(ClockEngine& clock);
    NormalizedEvent normalize(const MarketEvent& event);

private:
    ClockEngine& clock_;
    SequenceNumber last_sequence_per_source_[256]{};
};

}  // namespace mr
