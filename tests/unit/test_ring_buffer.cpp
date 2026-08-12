#include <gtest/gtest.h>
#include "mr/common/ring_buffer.hpp"

TEST(RingBuffer, PushAndRetrieve) {
    mr::RingBuffer<int, 4> buf;
    buf.push(1);
    buf.push(2);
    buf.push(3);
    EXPECT_EQ(buf.size(), 3u);
    EXPECT_EQ(buf.newest(), 3);
    EXPECT_EQ(buf.at(0), 3);
    EXPECT_EQ(buf.at(2), 1);
}

TEST(RingBuffer, OverwritesWhenFull) {
    mr::RingBuffer<int, 3> buf;
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    EXPECT_EQ(buf.size(), 3u);
    EXPECT_EQ(buf.newest(), 4);
    EXPECT_EQ(buf.at(2), 2);
}
