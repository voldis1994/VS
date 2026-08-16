#include "mr/telemetry/telemetry_hub.hpp"

namespace mr {

void HealthManager::set_component(const std::string& component, HealthStatus status) {
    if (component == "feeds") feeds = status;
    else if (component == "market_core") market_core = status;
    else if (component == "execution") execution = status;
    else if (component == "broker") broker = status;
    else if (component == "database") database = status;
    else if (component == "control_api") control_api = status;
}

HealthStatus HealthManager::overall() const {
    if (market_core == HealthStatus::Unhealthy ||
        execution == HealthStatus::Unhealthy) {
        return HealthStatus::Unhealthy;
    }
    if (feeds == HealthStatus::Degraded || market_core == HealthStatus::Degraded) {
        return HealthStatus::Degraded;
    }
    if (market_core == HealthStatus::Healthy) return HealthStatus::Healthy;
    return HealthStatus::Disconnected;
}

nlohmann::json HealthManager::to_json() const {
    auto status_str = [](HealthStatus s) {
        switch (s) {
            case HealthStatus::Healthy: return "HEALTHY";
            case HealthStatus::Degraded: return "DEGRADED";
            case HealthStatus::Unhealthy: return "UNHEALTHY";
            case HealthStatus::Disconnected: return "DISCONNECTED";
        }
        return "UNKNOWN";
    };
    return {
        {"feeds", status_str(feeds)},
        {"market_core", status_str(market_core)},
        {"execution", status_str(execution)},
        {"broker", status_str(broker)},
        {"database", status_str(database)},
        {"control_api", status_str(control_api)},
        {"overall", status_str(overall())}
    };
}

void TelemetryHub::set_publish_callback(PublishCallback cb) {
    publish_cb_ = std::move(cb);
}

void TelemetryHub::record_event() {
    event_count_.fetch_add(1, std::memory_order_relaxed);
}

void TelemetryHub::record_decision() {
    decision_count_.fetch_add(1, std::memory_order_relaxed);
}

void TelemetryHub::publish_metrics(const SystemMetrics& metrics, const ClockEngine& clock) {
    metrics_ = metrics;
    if (!publish_cb_) return;

    nlohmann::json j;
    j["type"] = "system_metrics";
    j["events_per_sec"] = metrics.events_per_sec;
    j["decisions_per_sec"] = metrics.decisions_per_sec;
    j["cpu_usage"] = metrics.cpu_usage;
    j["memory_mb"] = metrics.memory_mb;
    j["queue_depth"] = metrics.queue_depth;
    j["mode"] = static_cast<int>(metrics.mode);

    nlohmann::json latencies;
    for (const auto& name : clock.metric_names()) {
        auto stats = clock.stats(name);
        latencies[name] = {
            {"p50", stats.p50_ns},
            {"p90", stats.p90_ns},
            {"p95", stats.p95_ns},
            {"p99", stats.p99_ns},
            {"max", stats.max_ns},
            {"mean", stats.mean_ns},
            {"count", stats.count}
        };
    }
    j["latencies"] = latencies;
    publish_cb_(j);
}

void TelemetryHub::publish_market_state(const nlohmann::json& state) {
    if (publish_cb_) publish_cb_(state);
}

SystemMetrics TelemetryHub::metrics() const {
    return metrics_;
}

}  // namespace mr
