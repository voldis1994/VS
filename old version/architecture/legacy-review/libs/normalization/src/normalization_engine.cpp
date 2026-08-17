#include "mr/normalization/normalization_engine.hpp"

namespace mr {

NormalizationEngine::NormalizationEngine(ClockEngine& clock) : clock_(clock) {}

NormalizedEvent NormalizationEngine::normalize(const MarketEvent& event) {
    NormalizedEvent normalized;
    static_cast<MarketEvent&>(normalized) = event;
    normalized.processing_start = now_utc_ns();
    normalized.normalized_timestamp = normalized.processing_start;

    if (event.source < 256) {
        auto& last_seq = last_sequence_per_source_[event.source];
        if (last_seq > 0 && event.sequence <= last_seq) {
            normalized.quality |= static_cast<DataQualityFlags>(DataQualityFlag::OutOfOrder);
        }
        if (last_seq > 0 && event.sequence > last_seq + 1) {
            normalized.quality |= static_cast<DataQualityFlags>(DataQualityFlag::SequenceGap);
        }
        last_seq = event.sequence;
    }

    normalized.processing_end = now_utc_ns();
    PipelineTimestamps ts;
    ts.exchange_timestamp = normalized.exchange_timestamp;
    ts.provider_timestamp = normalized.provider_timestamp;
    ts.receive_timestamp = normalized.receive_timestamp;
    ts.processing_start = normalized.processing_start;
    ts.processing_end = normalized.processing_end;
    clock_.record_pipeline(ts);
    return normalized;
}

}  // namespace mr
