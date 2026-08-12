#include <gtest/gtest.h>
#include "mr/clock/clock_engine.hpp"

TEST(ClockEngine, RecordsLatency) {
    mr::ClockEngine clock;
    clock.record_latency("test", 100.0);
    clock.record_latency("test", 200.0);
    clock.record_latency("test", 300.0);
    auto stats = clock.stats("test");
    EXPECT_EQ(stats.count, 3u);
    EXPECT_GT(stats.mean_ns, 0);
}

TEST(ClockEngine, PipelineTimestamps) {
    mr::ClockEngine clock;
    mr::PipelineTimestamps ts;
    ts.receive_timestamp = mr::Timestamp(0);
    ts.processing_start = mr::Timestamp(1000);
    ts.processing_end = mr::Timestamp(5000);
    ts.decision_timestamp = mr::Timestamp(8000);
    clock.record_pipeline(ts);
    auto stats = clock.stats("processing_duration");
    EXPECT_EQ(stats.count, 1u);
    EXPECT_DOUBLE_EQ(stats.mean_ns, 4000.0);
}
