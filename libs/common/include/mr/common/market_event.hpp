#pragma once

#include "mr/common/types.hpp"
#include <cstdint>

namespace mr {

enum class MarketEventType : std::uint8_t {
    Unknown = 0,
    Quote = 1,
    Trade = 2,
    BookUpdate = 3,
    Heartbeat = 4,
    SessionStatus = 5
};

enum class DataQualityFlag : std::uint32_t {
    None = 0,
    Stale = 1 << 0,
    OutOfOrder = 1 << 1,
    Duplicate = 1 << 2,
    SequenceGap = 1 << 3,
    Crossed = 1 << 4,
    WideSpread = 1 << 5,
    MissingField = 1 << 6,
    Divergent = 1 << 7
};

using DataQualityFlags = std::uint32_t;

inline DataQualityFlags operator|(DataQualityFlag a, DataQualityFlag b) {
    return static_cast<DataQualityFlags>(a) | static_cast<DataQualityFlags>(b);
}

inline bool has_flag(DataQualityFlags flags, DataQualityFlag flag) {
    return (flags & static_cast<DataQualityFlags>(flag)) != 0;
}

struct MarketEvent {
    InstrumentId instrument{kInvalidInstrument};
    SourceId source{kInvalidSource};
    Timestamp exchange_timestamp{};
    Timestamp provider_timestamp{};
    Timestamp receive_timestamp{};
    std::optional<double> bid;
    std::optional<double> ask;
    std::optional<double> last;
    std::optional<double> bid_size;
    std::optional<double> ask_size;
    std::optional<double> trade_size;
    MarketEventType type{MarketEventType::Unknown};
    SequenceNumber sequence{0};
    DataQualityFlags quality{0};
};

struct NormalizedEvent : MarketEvent {
    Timestamp normalized_timestamp{};
    Timestamp processing_start{};
    Timestamp processing_end{};
};

}  // namespace mr
