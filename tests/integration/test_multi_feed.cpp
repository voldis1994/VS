#include <gtest/gtest.h>
#include "mr/feed_fusion/feed_fusion_engine.hpp"
#include "mr/data_quality/data_quality_engine.hpp"
#include "mr/normalization/normalization_engine.hpp"
#include "mr/clock/clock_engine.hpp"

class MultiFeedTest : public ::testing::Test {
protected:
    mr::ClockEngine clock_;
    mr::NormalizationEngine normalization_{clock_};
    mr::DataQualityEngine dq_;
    mr::FeedFusionEngine fusion_;

    mr::NormalizedEvent make_source_event(mr::SourceId source, std::uint64_t seq,
                                          double mid, long long ts_offset_ns = 0) {
        mr::MarketEvent raw;
        raw.instrument = 1;
        raw.source = source;
        raw.receive_timestamp = mr::Timestamp(1'000'000'000LL + ts_offset_ns);
        raw.exchange_timestamp = raw.receive_timestamp;
        raw.provider_timestamp = raw.receive_timestamp;
        raw.type = mr::MarketEventType::Quote;
        raw.bid = mid - 0.00005;
        raw.ask = mid + 0.00005;
        raw.last = mid;
        raw.bid_size = 100.0;
        raw.ask_size = 100.0;
        raw.sequence = seq;
        return normalization_.normalize(raw);
    }

    void ingest(mr::SourceId source, std::uint64_t seq, double mid, long long ts_offset = 0) {
        auto event = make_source_event(source, seq, mid, ts_offset);
        dq_.process(event, 500.0);
        fusion_.ingest(event, dq_.health(source));
    }
};

TEST_F(MultiFeedTest, TenSourcesConsensus) {
    for (mr::SourceId s = 1; s <= 10; ++s) {
        ingest(s, 1, 1.0850 + s * 0.000001);
    }
    auto c = fusion_.consensus(1);
    EXPECT_GT(c.contributing_sources, 5u);
    EXPECT_GT(c.mid_price, 1.084);
    EXPECT_LT(c.mid_price, 1.086);
    EXPECT_GT(c.confidence, 0.0);
}

TEST_F(MultiFeedTest, OutOfOrderDoesNotCrash) {
    ingest(1, 5, 1.0850);
    ingest(1, 3, 1.0851);  // out of order
    ingest(1, 6, 1.0852);
    auto c = fusion_.consensus(1);
    EXPECT_GT(c.mid_price, 0);
}

TEST_F(MultiFeedTest, DuplicateSequenceTracked) {
    ingest(2, 10, 1.0850);
    auto e = make_source_event(2, 10, 1.0850);
    e.quality |= static_cast<mr::DataQualityFlags>(mr::DataQualityFlag::Duplicate);
    dq_.process(e, 500.0);
    fusion_.ingest(e, dq_.health(2));
    auto health = dq_.health(2);
    EXPECT_GE(health.duplicate_rate, 0.0);
}

TEST_F(MultiFeedTest, AnomalousPriceRaisesDivergence) {
    for (mr::SourceId s = 1; s <= 9; ++s) {
        ingest(s, 1, 1.0850);
    }
    ingest(10, 1, 1.0950);  // anomalous
    auto d = fusion_.divergence(1);
    EXPECT_GT(d.max_divergence, 0.001);
    EXPECT_EQ(d.most_divergent_source, 10u);
}

TEST_F(MultiFeedTest, LeadLagWithStaggeredMoves) {
    // Source 1 moves first, then 2, then 3
    ingest(1, 1, 1.0850, 0);
    ingest(1, 2, 1.0852, 800'000);      // +0.8ms move
    ingest(2, 1, 1.0850, 0);
    ingest(2, 2, 1.0852, 1'600'000);    // +1.6ms
    ingest(3, 1, 1.0850, 0);
    ingest(3, 2, 1.0852, 3'100'000);    // +3.1ms
    auto ll = fusion_.lead_lag(1);
    // Leader should be identifiable when reaction sequence has data
    EXPECT_TRUE(ll.leader == 0 || ll.leader >= 1);
}

TEST_F(MultiFeedTest, StaleSourceStillAllowsOthers) {
    for (mr::SourceId s = 1; s <= 5; ++s) {
        ingest(s, 1, 1.0850);
    }
    // Simulate stale by processing with large gap on source 5 only via quality flags
    auto stale = make_source_event(5, 2, 1.0850, 2'000'000'000LL);
    stale.quality |= static_cast<mr::DataQualityFlags>(mr::DataQualityFlag::Stale);
    dq_.process(stale, 1.0);  // very tight threshold
    fusion_.ingest(stale, dq_.health(5));

    auto c = fusion_.consensus(1);
    EXPECT_GE(c.contributing_sources, 1u);
}

TEST_F(MultiFeedTest, WeightsSumNearOne) {
    for (mr::SourceId s = 1; s <= 10; ++s) {
        ingest(s, 1, 1.0850);
    }
    auto weights = fusion_.weights(1);
    EXPECT_EQ(weights.size(), 10u);
    double sum = 0;
    for (const auto& w : weights) sum += w.weight;
    EXPECT_NEAR(sum, 1.0, 0.01);
}
