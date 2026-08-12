#pragma once

#include "mr/common/market_event.hpp"
#include "mr/common/types.hpp"
#include <functional>
#include <memory>
#include <vector>

namespace mr {

using MarketEventCallback = std::function<void(const MarketEvent&)>;

class IMarketDataProvider {
public:
    virtual ~IMarketDataProvider() = default;
    virtual SourceId source_id() const = 0;
    virtual void start(MarketEventCallback callback) = 0;
    virtual void stop() = 0;
    [[nodiscard]] virtual bool is_connected() const = 0;
    [[nodiscard]] virtual HealthStatus health() const = 0;
};

class ReplayMarketDataProvider : public IMarketDataProvider {
public:
    explicit ReplayMarketDataProvider(SourceId id, std::vector<MarketEvent> events);
    SourceId source_id() const override { return source_id_; }
    void start(MarketEventCallback callback) override;
    void stop() override;
    bool is_connected() const override { return running_; }
    HealthStatus health() const override;

private:
    SourceId source_id_;
    std::vector<MarketEvent> events_;
    MarketEventCallback callback_;
    bool running_{false};
};

class SyntheticMarketDataProvider : public IMarketDataProvider {
public:
    SyntheticMarketDataProvider(SourceId id, InstrumentId instrument,
                                double base_price, std::uint64_t event_count);
    SourceId source_id() const override { return source_id_; }
    void start(MarketEventCallback callback) override;
    void stop() override;
    bool is_connected() const override { return running_; }
    HealthStatus health() const override;

private:
    SourceId source_id_;
    InstrumentId instrument_;
    double base_price_;
    std::uint64_t event_count_;
    MarketEventCallback callback_;
    bool running_{false};
};

}  // namespace mr
