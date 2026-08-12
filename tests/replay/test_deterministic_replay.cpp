#include <gtest/gtest.h>
#include "mr/market_core/pipeline.hpp"
#include "mr/storage/raw_event_storage.hpp"
#include "mr/replay/replay_engine.hpp"
#include <filesystem>
#include <sstream>
#include <thread>
#include <chrono>

namespace {

std::string write_dataset(const std::string& path, int events) {
    mr::RawEventWriter writer(path);
    for (int i = 0; i < events; ++i) {
        mr::MarketEvent e;
        e.instrument = 1;
        e.source = 1 + (i % 3);
        e.receive_timestamp = mr::Timestamp(static_cast<long long>(i) * 1'000'000);
        e.exchange_timestamp = e.receive_timestamp;
        e.provider_timestamp = e.receive_timestamp;
        e.type = mr::MarketEventType::Quote;
        const double mid = 1.0850 + ((i % 40) - 20) * 0.00001;
        e.bid = mid - 0.00005;
        e.ask = mid + 0.00005;
        e.last = mid;
        e.bid_size = 100;
        e.ask_size = 100;
        e.sequence = static_cast<mr::SequenceNumber>(i + 1);
        writer.write(e);
    }
    writer.flush();
    return path;
}

struct DecisionFingerprint {
    std::vector<std::uint64_t> intent_ids;
    std::vector<int> decisions;
    std::vector<std::string> regimes;
};

DecisionFingerprint run_once(const std::string& path) {
    mr::ConfigRegistry config;
    mr::InstrumentConfig inst;
    inst.id = 1;
    inst.symbol = "EURUSD";
    inst.tick_size = 0.00001;
    config.add_instrument(inst);
    mr::FeedConfig feed;
    feed.id = 1;
    feed.name = "replay";
    feed.instruments = {1};
    config.add_feed(feed);

    mr::MarketCorePipeline pipeline;
    pipeline.configure(config);

    mr::ReplayEngine replay;
    EXPECT_TRUE(replay.load(path));
    replay.set_speed(mr::ReplaySpeed::Maximum);

    DecisionFingerprint fp;
    replay.start([&](const mr::MarketEvent& event) {
        pipeline.process_event(event);
    });
    while (replay.is_running()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    for (const auto& intent : pipeline.pending_intents()) {
        fp.intent_ids.push_back(intent.id);
        fp.decisions.push_back(static_cast<int>(intent.decision));
    }
    auto regime = pipeline.latest_regime(1);
    fp.regimes.push_back(mr::regime_name(regime.current));
    return fp;
}

}  // namespace

TEST(DeterministicReplay, TenIdenticalRuns) {
    const std::string path = "/tmp/mr_det_replay.mrev";
    write_dataset(path, 500);

    auto baseline = run_once(path);
    for (int i = 0; i < 9; ++i) {
        auto next = run_once(path);
        EXPECT_EQ(next.intent_ids, baseline.intent_ids) << "run " << i;
        EXPECT_EQ(next.decisions, baseline.decisions) << "run " << i;
        EXPECT_EQ(next.regimes, baseline.regimes) << "run " << i;
    }
    std::filesystem::remove(path);
}
