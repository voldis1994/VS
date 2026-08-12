#include "mr/market_core/pipeline.hpp"
#include "mr/market_data/provider.hpp"
#include "mr/replay/replay_engine.hpp"
#include "mr/telemetry/telemetry_hub.hpp"
#include <spdlog/spdlog.h>
#include <iostream>
#include <csignal>
#include <atomic>
#include <thread>

static std::atomic<bool> g_running{true};

void signal_handler(int) {
    g_running = false;
}

mr::OperatingMode parse_mode(const std::string& mode) {
    if (mode == "REPLAY") return mr::OperatingMode::Replay;
    if (mode == "PAPER") return mr::OperatingMode::Paper;
    if (mode == "DEMO") return mr::OperatingMode::Demo;
    if (mode == "LIVE") return mr::OperatingMode::Live;
    return mr::OperatingMode::Paper;
}

int main(int argc, char* argv[]) {
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    spdlog::set_level(spdlog::level::info);
    spdlog::info("Market Core starting...");

    std::string mode_str = "PAPER";
    std::string replay_file;
    std::string config_dir = "config";
    std::string record_path = "data/raw/events.mrev";

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--mode" && i + 1 < argc) mode_str = argv[++i];
        else if (arg == "--replay" && i + 1 < argc) replay_file = argv[++i];
        else if (arg == "--config" && i + 1 < argc) config_dir = argv[++i];
        else if (arg == "--record" && i + 1 < argc) record_path = argv[++i];
    }

    auto mode = parse_mode(mode_str);
    if (mode == mr::OperatingMode::Live) {
        spdlog::warn("LIVE mode — operator risk accepted; no LIVE_TRADING_ENABLED gate");
    }

    mr::ConfigRegistry config;
    mr::InstrumentConfig eurusd;
    eurusd.id = 1;
    eurusd.symbol = "EURUSD";
    eurusd.display_name = "EUR/USD";
    eurusd.tick_size = 0.00001;
    config.add_instrument(eurusd);

    mr::FeedConfig feed1;
    feed1.id = 1;
    feed1.name = "synthetic-primary";
    feed1.provider = "synthetic";
    feed1.instruments = {1};
    feed1.stale_threshold_ms = 500;
    config.add_feed(feed1);

    mr::MarketCorePipeline pipeline;
    pipeline.configure(config);
    pipeline.enable_recording(mode != mr::OperatingMode::Replay);
    pipeline.set_recording_path(record_path);

    spdlog::info("Operating mode: {}", mode_str);

    if (mode == mr::OperatingMode::Replay) {
        if (replay_file.empty()) {
            spdlog::error("REPLAY mode requires --replay <file>");
            return 1;
        }
        mr::ReplayEngine replay;
        if (!replay.load(replay_file)) {
            spdlog::error("Failed to load replay file: {}", replay_file);
            return 1;
        }
        spdlog::info("Loaded replay file, starting playback...");
        replay.start([&](const mr::MarketEvent& event) {
            pipeline.process_event(event);
        });
        while (replay.is_running() && g_running) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        replay.stop();
    } else {
        mr::SyntheticMarketDataProvider provider(1, 1, 1.0850, 1000);
        provider.start([&](const mr::MarketEvent& event) {
            pipeline.process_event(event);
        });
    }

    auto intents = pipeline.pending_intents();
    spdlog::info("Processed events. Pending trade intents: {}", intents.size());
    for (const auto& intent : intents) {
        spdlog::info("TradeIntent {} decision={} EV={:.6f}",
            intent.id, static_cast<int>(intent.decision),
            intent.expected_value_after_costs);
    }

    spdlog::info("Market Core stopped.");
    return 0;
}
