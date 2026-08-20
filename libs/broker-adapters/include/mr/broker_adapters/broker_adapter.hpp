#pragma once

#include "mr/entry_engine/entry_engine.hpp"
#include "mr/common/types.hpp"
#include <string>
#include <vector>
#include <optional>

namespace mr {

enum class BrokerCapability : std::uint8_t {
    MarketOrder = 0,
    LimitOrder = 1,
    StopLoss = 2,
    TakeProfit = 3,
    TrailingStop = 4,
    PartialClose = 5,
    ModifyPosition = 6,
    WebSocketQuotes = 7,
    WebSocketTrades = 8
};

struct BrokerOrderRequest {
    InstrumentId instrument{kInvalidInstrument};
    Direction direction{Direction::Flat};
    double quantity{0};
    double price{0};
    double stop_loss{0};
    double take_profit{0};
    bool is_market{true};
};

struct BrokerOrderResponse {
    bool success{false};
    std::string order_id;
    std::string deal_id;
    double fill_price{0};
    double filled_quantity{0};
    std::string error_code;
    std::string error_message;
};

struct BrokerPosition {
    std::string deal_id;
    InstrumentId instrument{kInvalidInstrument};
    Direction direction{Direction::Flat};
    double quantity{0};
    double entry_price{0};
    double stop_loss{0};
    double take_profit{0};
    double unrealized_pnl{0};
};

struct BrokerAccountInfo {
    std::string account_id;
    double balance{0};
    double available{0};
    std::string currency;
};

class IBrokerAdapter {
public:
    virtual ~IBrokerAdapter() = default;
    virtual bool connect() = 0;
    virtual void disconnect() = 0;
    [[nodiscard]] virtual bool is_connected() const = 0;
    [[nodiscard]] virtual HealthStatus health() const = 0;
    [[nodiscard]] virtual std::vector<BrokerCapability> capabilities() const = 0;
    [[nodiscard]] virtual bool supports(BrokerCapability cap) const = 0;
    virtual bool authenticate(const std::string& api_key,
                              const std::string& password,
                              const std::string& identifier) = 0;
    [[nodiscard]] virtual std::optional<BrokerAccountInfo> account_info() = 0;
    [[nodiscard]] virtual std::optional<BrokerQuote> quote(InstrumentId instrument) = 0;
    virtual BrokerOrderResponse create_position(const BrokerOrderRequest& request) = 0;
    virtual BrokerOrderResponse close_position(const std::string& deal_id) = 0;
    [[nodiscard]] virtual std::vector<BrokerPosition> positions() = 0;
};

class PaperBrokerAdapter : public IBrokerAdapter {
public:
    bool connect() override;
    void disconnect() override;
    bool is_connected() const override { return connected_; }
    HealthStatus health() const override;
    std::vector<BrokerCapability> capabilities() const override;
    bool supports(BrokerCapability cap) const override;
    bool authenticate(const std::string& api_key, const std::string& password,
                      const std::string& identifier) override;
    std::optional<BrokerAccountInfo> account_info() override;
    std::optional<BrokerQuote> quote(InstrumentId instrument) override;
    BrokerOrderResponse create_position(const BrokerOrderRequest& request) override;
    BrokerOrderResponse close_position(const std::string& deal_id) override;
    std::vector<BrokerPosition> positions() override;
    void set_quote(InstrumentId instrument, const BrokerQuote& quote);

private:
    bool connected_{false};
    std::unordered_map<InstrumentId, BrokerQuote> quotes_;
    std::vector<BrokerPosition> open_positions_;
    BrokerAccountInfo account_;
    std::uint64_t deal_counter_{1};
};

}  // namespace mr
