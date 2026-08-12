#include "mr/replay/replay_engine.hpp"

namespace mr {

ReplayEngine::ReplayEngine() = default;

ReplayEngine::~ReplayEngine() {
    stop();
}

bool ReplayEngine::load(const std::string& path) {
    events_.clear();
    RawEventReader reader(path);
    MarketEvent event;
    while (reader.read_next(event)) {
        events_.push_back(event);
    }
    return !events_.empty();
}

void ReplayEngine::set_speed(ReplaySpeed speed) {
    speed_ = speed;
}

double ReplayEngine::speed_multiplier() const {
    switch (speed_) {
        case ReplaySpeed::RealTime: return 1.0;
        case ReplaySpeed::Speed0_1x: return 0.1;
        case ReplaySpeed::Speed1x: return 1.0;
        case ReplaySpeed::Speed10x: return 10.0;
        case ReplaySpeed::Speed100x: return 100.0;
        case ReplaySpeed::Maximum: return 0.0;
    }
    return 1.0;
}

void ReplayEngine::run_replay(MarketEventCallback callback) {
    Timestamp prev_ts{};
    for (const auto& event : events_) {
        if (!running_) break;

        if (prev_ts.count() > 0 && speed_multiplier() > 0) {
            auto gap = event.receive_timestamp - prev_ts;
            auto sleep_ns = static_cast<std::int64_t>(
                static_cast<double>(gap.count()) / speed_multiplier());
            if (sleep_ns > 0) {
                std::this_thread::sleep_for(std::chrono::nanoseconds(sleep_ns));
            }
        }

        callback(event);
        events_played_.fetch_add(1);
        prev_ts = event.receive_timestamp;
    }
    running_ = false;
}

void ReplayEngine::start(MarketEventCallback callback) {
    if (running_) return;
    running_ = true;
    events_played_ = 0;
    if (replay_thread_.joinable()) replay_thread_.join();
    replay_thread_ = std::thread([this, callback]() {
        run_replay(callback);
    });
}

void ReplayEngine::stop() {
    running_ = false;
    if (replay_thread_.joinable()) replay_thread_.join();
}

}  // namespace mr
