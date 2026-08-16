#include "mr/market_data/provider.hpp"
#include <thread>
#include <chrono>

namespace mr {

ReplayMarketDataProvider::ReplayMarketDataProvider(
    SourceId id, std::vector<MarketEvent> events)
    : source_id_(id), events_(std::move(events)) {}

void ReplayMarketDataProvider::start(MarketEventCallback callback) {
    callback_ = std::move(callback);
    running_ = true;
    for (const auto& event : events_) {
        if (!running_) break;
        callback_(event);
    }
}

void ReplayMarketDataProvider::stop() {
    running_ = false;
}

HealthStatus ReplayMarketDataProvider::health() const {
    return running_ ? HealthStatus::Healthy : HealthStatus::Disconnected;
}

SyntheticMarketDataProvider::SyntheticMarketDataProvider(
    SourceId id, InstrumentId instrument, double base_price, std::uint64_t event_count)
    : source_id_(id), instrument_(instrument), base_price_(base_price),
      event_count_(event_count) {}

void SyntheticMarketDataProvider::start(MarketEventCallback callback) {
    callback_ = std::move(callback);
    running_ = true;
    double price = base_price_;
  SequenceNumber seq = 1;
    for (std::uint64_t i = 0; i < event_count_ && running_; ++i) {
        MarketEvent event;
        event.instrument = instrument_;
        event.source = source_id_;
        event.receive_timestamp = now_utc_ns();
        event.exchange_timestamp = event.receive_timestamp;
        event.provider_timestamp = event.receive_timestamp;
        event.type = (i % 3 == 0) ? MarketEventType::Trade : MarketEventType::Quote;
        price += (i % 5 == 0) ? 0.0001 : -0.00005;
        event.bid = price - 0.00005;
        event.ask = price + 0.00005;
        event.last = price;
        event.bid_size = 100.0;
        event.ask_size = 100.0;
        if (event.type == MarketEventType::Trade) {
            event.trade_size = 1.0;
        }
        event.sequence = seq++;
        callback_(event);
    }
}

void SyntheticMarketDataProvider::stop() {
    running_ = false;
}

HealthStatus SyntheticMarketDataProvider::health() const {
    return running_ ? HealthStatus::Healthy : HealthStatus::Disconnected;
}

}  // namespace mr
