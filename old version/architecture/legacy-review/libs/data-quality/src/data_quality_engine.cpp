#include "mr/data_quality/data_quality_engine.hpp"

namespace mr {

void DataQualityEngine::process(const NormalizedEvent& event, double stale_threshold_ms) {
    auto& health = health_map_[event.source];
    health.source = event.source;
    health.event_count++;

    auto now = event.normalized_timestamp;
    if (last_event_time_.count(event.source)) {
        double gap_ms = static_cast<double>(
            (now - last_event_time_[event.source]).count()) / 1e6;
        health.latency_ms = gap_ms;
        if (gap_ms > stale_threshold_ms) {
            stale_count_[event.source]++;
            health.status = HealthStatus::Degraded;
        } else {
            health.status = HealthStatus::Healthy;
        }
    }
    last_event_time_[event.source] = now;
    health.last_event_time = now;

    if (has_flag(event.quality, DataQualityFlag::SequenceGap)) {
        gap_count_[event.source]++;
    }
    if (has_flag(event.quality, DataQualityFlag::Duplicate)) {
        duplicate_count_[event.source]++;
    }
    if (has_flag(event.quality, DataQualityFlag::OutOfOrder)) {
        out_of_order_count_[event.source]++;
    }

    if (health.event_count > 0) {
        health.stale_rate = static_cast<double>(stale_count_[event.source]) / health.event_count;
        health.sequence_gap_rate = static_cast<double>(gap_count_[event.source]) / health.event_count;
        health.duplicate_rate = static_cast<double>(duplicate_count_[event.source]) / health.event_count;
        health.out_of_order_rate = static_cast<double>(out_of_order_count_[event.source]) / health.event_count;
        health.reliability = 1.0 - health.stale_rate - health.sequence_gap_rate * 0.5;
        if (health.reliability < 0) health.reliability = 0;
    }
}

SourceHealth DataQualityEngine::health(SourceId source) const {
    auto it = health_map_.find(source);
    if (it == health_map_.end()) return {};
    return it->second;
}

SourceQuality DataQualityEngine::quality(SourceId source) const {
    SourceQuality q;
    auto h = health(source);
    q.score = h.reliability;
    q.is_stale = h.stale_rate > 0.1;
    if (h.status == HealthStatus::Unhealthy) {
        q.flags |= static_cast<DataQualityFlags>(DataQualityFlag::Stale);
    }
    return q;
}

bool DataQualityEngine::is_feed_usable(SourceId source) const {
    auto h = health(source);
    return h.status != HealthStatus::Unhealthy && h.reliability > 0.5;
}

void DataQualityEngine::reset() {
    health_map_.clear();
    last_event_time_.clear();
    stale_count_.clear();
    gap_count_.clear();
    duplicate_count_.clear();
    out_of_order_count_.clear();
}

}  // namespace mr
