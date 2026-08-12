#include "mr/storage/raw_event_storage.hpp"

namespace mr {

RawEventRecord to_record(const MarketEvent& event) {
    RawEventRecord r;
    r.instrument = event.instrument;
    r.source = event.source;
    r.exchange_ts = event.exchange_timestamp.count();
    r.provider_ts = event.provider_timestamp.count();
    r.receive_ts = event.receive_timestamp.count();
    r.type = static_cast<std::uint8_t>(event.type);
    r.has_bid = event.bid.has_value() ? 1 : 0;
    r.has_ask = event.ask.has_value() ? 1 : 0;
    r.has_last = event.last.has_value() ? 1 : 0;
    r.bid = event.bid.value_or(0);
    r.ask = event.ask.value_or(0);
    r.last = event.last.value_or(0);
    r.bid_size = event.bid_size.value_or(0);
    r.ask_size = event.ask_size.value_or(0);
    r.trade_size = event.trade_size.value_or(0);
    r.sequence = event.sequence;
    r.quality = event.quality;
    return r;
}

MarketEvent from_record(const RawEventRecord& r) {
    MarketEvent e;
    e.instrument = r.instrument;
    e.source = r.source;
    e.exchange_timestamp = Timestamp(r.exchange_ts);
    e.provider_timestamp = Timestamp(r.provider_ts);
    e.receive_timestamp = Timestamp(r.receive_ts);
    e.type = static_cast<MarketEventType>(r.type);
    if (r.has_bid) e.bid = r.bid;
    if (r.has_ask) e.ask = r.ask;
    if (r.has_last) e.last = r.last;
    if (r.bid_size > 0) e.bid_size = r.bid_size;
    if (r.ask_size > 0) e.ask_size = r.ask_size;
    if (r.trade_size > 0) e.trade_size = r.trade_size;
    e.sequence = r.sequence;
    e.quality = r.quality;
    return e;
}

RawEventWriter::RawEventWriter(const std::string& path)
    : file_(path, std::ios::binary | std::ios::app) {}

void RawEventWriter::write(const MarketEvent& event) {
    auto record = to_record(event);
    std::lock_guard lock(mutex_);
    file_.write(reinterpret_cast<const char*>(&record), sizeof(record));
    count_++;
}

void RawEventWriter::flush() {
    std::lock_guard lock(mutex_);
    file_.flush();
}

RawEventReader::RawEventReader(const std::string& path)
    : file_(path, std::ios::binary) {}

bool RawEventReader::read_next(MarketEvent& event) {
    RawEventRecord record;
    file_.read(reinterpret_cast<char*>(&record), sizeof(record));
    if (!file_) return false;
    if (record.magic != 0x4D524556) return false;
    event = from_record(record);
    return true;
}

bool RawEventReader::eof() const {
    return file_.eof();
}

}  // namespace mr
