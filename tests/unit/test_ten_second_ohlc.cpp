#include <gtest/gtest.h>
#include "mr/feature_engine/feature_engine.hpp"
#include "mr/common/market_event.hpp"

using namespace mr;

static NormalizedEvent make_quote(double mid, Timestamp ts) {
    NormalizedEvent e;
    e.type = MarketEventType::Quote;
    e.normalized_timestamp = ts;
    e.bid = mid - 0.05;
    e.ask = mid + 0.05;
    e.last = mid;
    return e;
}

TEST(TenSecondOhlc, BuildsAndClosesBars) {
    FeatureEngine fe;
    // Bucket 0: t=0..9.9s
    for (int i = 0; i < 5; ++i) {
        auto ts = Timestamp(static_cast<long long>(i) * 1'000'000'000LL);
        fe.update(make_quote(100.0 + i * 0.1, ts), 100.0 + i * 0.1, 0, 0);
    }
    auto snap = fe.snapshot();
    EXPECT_TRUE(snap.ohlc_10s.has_forming);
    EXPECT_FALSE(snap.ohlc_10s.has_closed);
    EXPECT_DOUBLE_EQ(snap.ohlc_10s.forming.open, 100.0);
    EXPECT_GT(snap.ohlc_10s.forming.close, 100.0);

    // Cross into next 10s bucket → previous closes
    auto ts2 = Timestamp(10'000'000'000LL);
    fe.update(make_quote(101.0, ts2), 101.0, 0, 0);
    snap = fe.snapshot();
    EXPECT_TRUE(snap.ohlc_10s.has_closed);
    EXPECT_TRUE(snap.ohlc_10s.last_closed.closed);
    EXPECT_DOUBLE_EQ(snap.ohlc_10s.last_closed.open, 100.0);
    EXPECT_GT(snap.ohlc_10s.last_closed.close, 100.0);
    EXPECT_DOUBLE_EQ(snap.ohlc_10s.forming.open, 101.0);
}

TEST(TenSecondOhlc, BodyPctPositiveOnUpBar) {
    FeatureEngine fe;
    fe.update(make_quote(2000.0, Timestamp(0)), 2000.0, 0, 0);
    fe.update(make_quote(2002.0, Timestamp(2'000'000'000LL)), 2002.0, 0, 0);
    fe.update(make_quote(2001.0, Timestamp(10'000'000'000LL)), 2001.0, 0, 0);
    auto snap = fe.snapshot();
    ASSERT_TRUE(snap.ohlc_10s.has_closed);
    EXPECT_GT(snap.ohlc_10s.last_closed.body_pct(), 0.0);
}
