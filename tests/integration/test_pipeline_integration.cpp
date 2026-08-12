#include <gtest/gtest.h>
#include "mr/market_core/pipeline.hpp"
#include "mr/market_data/provider.hpp"

TEST(PipelineIntegration, ProcessesSyntheticEvents) {
    mr::ConfigRegistry config;
    mr::InstrumentConfig inst;
    inst.id = 1;
    inst.symbol = "EURUSD";
    inst.tick_size = 0.00001;
    config.add_instrument(inst);
    mr::FeedConfig feed;
    feed.id = 1;
    feed.name = "test";
    feed.instruments = {1};
    config.add_feed(feed);

    mr::MarketCorePipeline pipeline;
    pipeline.configure(config);

    mr::SyntheticMarketDataProvider provider(1, 1, 1.0850, 100);
    provider.start([&](const mr::MarketEvent& event) {
        pipeline.process_event(event);
    });

    auto state = pipeline.latest_state(1);
    EXPECT_EQ(state.instrument, 1u);
    auto regime = pipeline.latest_regime(1);
    EXPECT_NE(regime.current, mr::Regime::Unknown);
}
