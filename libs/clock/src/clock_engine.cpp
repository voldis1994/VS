#include "mr/clock/clock_engine.hpp"

namespace mr {

void ClockEngine::record(ClockPoint /*point*/, const std::string& /*label*/) {
    // Steady clock recording for point-in-time markers
}

void ClockEngine::record_pipeline(const PipelineTimestamps& ts) {
    if (ts.receive_timestamp.count() > 0 && ts.processing_start.count() > 0) {
        double latency = static_cast<double>(
            (ts.processing_start - ts.receive_timestamp).count());
        record_latency("receive_to_processing_start", latency);
    }
    if (ts.processing_start.count() > 0 && ts.processing_end.count() > 0) {
        double latency = static_cast<double>(
            (ts.processing_end - ts.processing_start).count());
        record_latency("processing_duration", latency);
    }
    if (ts.processing_end.count() > 0 && ts.decision_timestamp.count() > 0) {
        double latency = static_cast<double>(
            (ts.decision_timestamp - ts.processing_end).count());
        record_latency("processing_to_decision", latency);
    }
    if (ts.decision_timestamp.count() > 0 && ts.order_send.count() > 0) {
        double latency = static_cast<double>(
            (ts.order_send - ts.decision_timestamp).count());
        record_latency("decision_to_order_send", latency);
    }
    if (ts.order_send.count() > 0 && ts.broker_ack.count() > 0) {
        double latency = static_cast<double>(
            (ts.broker_ack - ts.order_send).count());
        record_latency("order_send_to_ack", latency);
    }
    if (ts.broker_ack.count() > 0 && ts.fill_timestamp.count() > 0) {
        double latency = static_cast<double>(
            (ts.fill_timestamp - ts.broker_ack).count());
        record_latency("ack_to_fill", latency);
    }
}

void ClockEngine::record_latency(const std::string& name, double latency_ns) {
    auto& samples = latency_samples_[name];
    if (samples.size() >= kMaxSamples) {
        samples.erase(samples.begin(), samples.begin() + samples.size() / 2);
    }
    samples.push_back(latency_ns);
}

LatencyStats ClockEngine::stats(const std::string& name) const {
    auto it = latency_samples_.find(name);
    if (it == latency_samples_.end()) {
        return {};
    }
    return compute_latency_stats(it->second);
}

std::vector<std::string> ClockEngine::metric_names() const {
    std::vector<std::string> names;
    names.reserve(latency_samples_.size());
    for (const auto& [name, _] : latency_samples_) {
        names.push_back(name);
    }
    return names;
}

void ClockEngine::reset() {
    latency_samples_.clear();
}

}  // namespace mr
