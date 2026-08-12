#pragma once

#include "mr/market_data/provider.hpp"
#include "mr/storage/raw_event_storage.hpp"
#include <atomic>
#include <chrono>
#include <thread>

namespace mr {

enum class ReplaySpeed : std::uint8_t {
    RealTime = 0,
    Speed0_1x = 1,
    Speed1x = 2,
    Speed10x = 3,
    Speed100x = 4,
    Maximum = 5
};

class ReplayEngine {
public:
    ReplayEngine();
    ~ReplayEngine();
    ReplayEngine(const ReplayEngine&) = delete;
    ReplayEngine& operator=(const ReplayEngine&) = delete;
    bool load(const std::string& path);
    void set_speed(ReplaySpeed speed);
    void start(MarketEventCallback callback);
    void stop();
    [[nodiscard]] bool is_running() const { return running_; }
    [[nodiscard]] std::uint64_t events_played() const { return events_played_; }

private:
    std::vector<MarketEvent> events_;
    ReplaySpeed speed_{ReplaySpeed::Speed1x};
    std::atomic<bool> running_{false};
    std::atomic<std::uint64_t> events_played_{0};
    std::thread replay_thread_;

    double speed_multiplier() const;
    void run_replay(MarketEventCallback callback);
};

}  // namespace mr
