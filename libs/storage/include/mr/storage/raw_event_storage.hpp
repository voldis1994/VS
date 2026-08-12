#pragma once

#include "mr/common/market_event.hpp"
#include <fstream>
#include <string>
#include <vector>
#include <mutex>

namespace mr {

#pragma pack(push, 1)
struct RawEventRecord {
    std::uint32_t magic{0x4D524556};  // MREV
    std::uint32_t version{1};
    InstrumentId instrument{0};
    SourceId source{0};
    std::int64_t exchange_ts{0};
    std::int64_t provider_ts{0};
    std::int64_t receive_ts{0};
    std::uint8_t type{0};
    std::uint8_t has_bid{0};
    std::uint8_t has_ask{0};
    std::uint8_t has_last{0};
    double bid{0};
    double ask{0};
    double last{0};
    double bid_size{0};
    double ask_size{0};
    double trade_size{0};
    std::uint64_t sequence{0};
    std::uint32_t quality{0};
};
#pragma pack(pop)

class RawEventWriter {
public:
    explicit RawEventWriter(const std::string& path);
    void write(const MarketEvent& event);
    void flush();
    [[nodiscard]] std::uint64_t count() const { return count_; }

private:
    std::ofstream file_;
    std::mutex mutex_;
    std::uint64_t count_{0};
};

class RawEventReader {
public:
    explicit RawEventReader(const std::string& path);
    [[nodiscard]] bool read_next(MarketEvent& event);
    [[nodiscard]] bool eof() const;

private:
    std::ifstream file_;
};

RawEventRecord to_record(const MarketEvent& event);
MarketEvent from_record(const RawEventRecord& record);

}  // namespace mr
