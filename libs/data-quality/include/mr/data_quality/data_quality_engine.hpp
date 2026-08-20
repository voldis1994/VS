#pragma once

#include "mr/common/market_event.hpp"
#include "mr/common/ring_buffer.hpp"
#include <unordered_map>

namespace mr {

struct SourceHealth {
    SourceId source{kInvalidSource};
    HealthStatus status{HealthStatus::Disconnected};
    double latency_ms{0};
    double jitter_ms{0};
    double stale_rate{0};
    double disconnect_rate{0};
    double sequence_gap_rate{0};
    double duplicate_rate{0};
    double out_of_order_rate{0};
    double divergence{0};
    double reliability{1.0};
    double predictive_usefulness{0};
    Timestamp last_event_time{};
    std::uint64_t event_count{0};
};

struct SourceQuality {
    double score{0};
    DataQualityFlags flags{0};
    bool is_stale{false};
};

struct SourceWeight {
    SourceId source{kInvalidSource};
    double weight{0};
};

class DataQualityEngine {
public:
    void process(const NormalizedEvent& event, double stale_threshold_ms);
    [[nodiscard]] SourceHealth health(SourceId source) const;
    [[nodiscard]] SourceQuality quality(SourceId source) const;
    [[nodiscard]] bool is_feed_usable(SourceId source) const;
    void reset();

private:
    std::unordered_map<SourceId, SourceHealth> health_map_;
    std::unordered_map<SourceId, Timestamp> last_event_time_;
    std::unordered_map<SourceId, std::uint64_t> stale_count_;
    std::unordered_map<SourceId, std::uint64_t> gap_count_;
    std::unordered_map<SourceId, std::uint64_t> duplicate_count_;
    std::unordered_map<SourceId, std::uint64_t> out_of_order_count_;
};

}  // namespace mr
