#include <gtest/gtest.h>
#include "mr/replay/replay_engine.hpp"
#include "mr/storage/raw_event_storage.hpp"
#include <filesystem>
#include <thread>
#include <chrono>

TEST(ReplayEngine, DeterministicPlayback) {
    std::string path = "/tmp/test_replay.mrev";
    {
        mr::RawEventWriter writer(path);
        for (int i = 0; i < 10; ++i) {
            mr::MarketEvent e;
            e.instrument = 1;
            e.source = 1;
            e.receive_timestamp = mr::Timestamp(static_cast<long long>(i) * 1'000'000);
            e.exchange_timestamp = e.receive_timestamp;
            e.bid = 1.0850 + i * 0.00001;
            e.ask = *e.bid + 0.0001;
            e.type = mr::MarketEventType::Quote;
            e.sequence = i + 1;
            writer.write(e);
        }
        writer.flush();
    }

    mr::ReplayEngine replay;
    ASSERT_TRUE(replay.load(path));
    replay.set_speed(mr::ReplaySpeed::Maximum);

    std::vector<double> prices;
    replay.start([&](const mr::MarketEvent& e) {
        if (e.bid) prices.push_back(*e.bid);
    });

    while (replay.is_running()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    EXPECT_EQ(prices.size(), 10u);
    EXPECT_DOUBLE_EQ(prices[0], 1.0850);
    EXPECT_DOUBLE_EQ(prices[9], 1.0850 + 9 * 0.00001);
    std::filesystem::remove(path);
}
