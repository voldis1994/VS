#pragma once

#include "mr/common/types.hpp"
#include "mr/clock/clock_engine.hpp"
#include <nlohmann/json.hpp>
#include <string>
#include <functional>
#include <atomic>

namespace mr {

struct SystemMetrics {
    HealthStatus market_core{HealthStatus::Disconnected};
    HealthStatus execution{HealthStatus::Disconnected};
    HealthStatus database{HealthStatus::Disconnected};
    OperatingMode mode{OperatingMode::Paper};
    std::uint64_t events_per_sec{0};
    std::uint64_t decisions_per_sec{0};
    double cpu_usage{0};
    double memory_mb{0};
    std::uint64_t queue_depth{0};
    std::uint64_t reconnect_count{0};
};

struct HealthManager {
    HealthStatus feeds{HealthStatus::Disconnected};
    HealthStatus market_core{HealthStatus::Disconnected};
    HealthStatus execution{HealthStatus::Disconnected};
    HealthStatus broker{HealthStatus::Disconnected};
    HealthStatus database{HealthStatus::Disconnected};
    HealthStatus control_api{HealthStatus::Disconnected};

    void set_component(const std::string& component, HealthStatus status);
    [[nodiscard]] HealthStatus overall() const;
    [[nodiscard]] nlohmann::json to_json() const;
};

class TelemetryHub {
public:
    using PublishCallback = std::function<void(const nlohmann::json&)>;

    void set_publish_callback(PublishCallback cb);
    void record_event();
    void record_decision();
    void publish_metrics(const SystemMetrics& metrics, const ClockEngine& clock);
    void publish_market_state(const nlohmann::json& state);
    [[nodiscard]] SystemMetrics metrics() const;

private:
    PublishCallback publish_cb_;
    std::atomic<std::uint64_t> event_count_{0};
    std::atomic<std::uint64_t> decision_count_{0};
    SystemMetrics metrics_;
};

}  // namespace mr
