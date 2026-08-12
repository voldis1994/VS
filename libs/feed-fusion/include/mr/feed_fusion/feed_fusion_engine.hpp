#pragma once

#include "mr/common/market_event.hpp"
#include "mr/data_quality/data_quality_engine.hpp"
#include "mr/common/ring_buffer.hpp"
#include <unordered_map>
#include <vector>

namespace mr {

struct FeedConsensus {
    double mid_price{0};
    double spread{0};
    double confidence{0};
    std::uint32_t contributing_sources{0};
};

struct FeedDivergence {
  double max_divergence{0};
    double mean_divergence{0};
    SourceId most_divergent_source{kInvalidSource};
};

struct LeadLagState {
    SourceId leader{kInvalidSource};
    SourceId lagger{kInvalidSource};
    double lead_lag_ms{0};
    double lead_probability{0};
    double directional_agreement{0};
};

struct ReactionEvent {
    SourceId source{kInvalidSource};
    Timestamp timestamp{};
    double price_change{0};
};

class FeedFusionEngine {
public:
    void ingest(const NormalizedEvent& event, const SourceHealth& health);
    [[nodiscard]] FeedConsensus consensus(InstrumentId instrument) const;
    [[nodiscard]] FeedDivergence divergence(InstrumentId instrument) const;
    [[nodiscard]] LeadLagState lead_lag(InstrumentId instrument) const;
    [[nodiscard]] std::vector<SourceWeight> weights(InstrumentId instrument) const;
    [[nodiscard]] NormalizedEvent fused_event(InstrumentId instrument) const;

private:
    struct SourceState {
        NormalizedEvent last_event;
        SourceHealth health;
        double weight{1.0};
        Timestamp last_update{};
    };

    struct InstrumentState {
        std::unordered_map<SourceId, SourceState> sources;
        RingBuffer<ReactionEvent, 64> reaction_sequence;
        double last_mid{0};
    };

    std::unordered_map<InstrumentId, InstrumentState> instruments_;
    void update_lead_lag(InstrumentId instrument, const NormalizedEvent& event, double price_change);
    [[nodiscard]] double compute_mid(const NormalizedEvent& event) const;
};

}  // namespace mr
