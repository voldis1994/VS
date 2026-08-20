#pragma once

#include "mr/common/types.hpp"
#include "mr/common/ring_buffer.hpp"
#include <string>
#include <unordered_map>
#include <vector>

namespace mr {

enum class ClockPoint : std::uint8_t {
    ExchangeTimestamp = 0,
    ProviderTimestamp = 1,
    ReceiveTimestamp = 2,
    ProcessingStart = 3,
    ProcessingEnd = 4,
    DecisionTimestamp = 5,
    OrderSend = 6,
    BrokerAck = 7,
    FillTimestamp = 8
};

struct ClockMeasurement {
    ClockPoint point;
    SteadyTimestamp steady_time{};
    Timestamp wall_time{};
    std::string label;
};

struct PipelineTimestamps {
    Timestamp exchange_timestamp{};
    Timestamp provider_timestamp{};
    Timestamp receive_timestamp{};
    Timestamp processing_start{};
    Timestamp processing_end{};
    Timestamp decision_timestamp{};
    Timestamp order_send{};
    Timestamp broker_ack{};
    Timestamp fill_timestamp{};
};

class ClockEngine {
public:
    void record(ClockPoint point, const std::string& label = {});
    void record_pipeline(const PipelineTimestamps& ts);
    void record_latency(const std::string& name, double latency_ns);
    [[nodiscard]] LatencyStats stats(const std::string& name) const;
    [[nodiscard]] std::vector<std::string> metric_names() const;
    void reset();

private:
    std::unordered_map<std::string, std::vector<double>> latency_samples_;
    static constexpr std::size_t kMaxSamples = 10000;
};

}  // namespace mr
