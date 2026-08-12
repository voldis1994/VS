#include "mr/broker_adapters/broker_adapter.hpp"

namespace mr {

bool PaperBrokerAdapter::connect() {
    connected_ = true;
    account_.account_id = "paper-001";
    account_.balance = 100000.0;
    account_.available = 100000.0;
    account_.currency = "USD";
    return true;
}

void PaperBrokerAdapter::disconnect() {
    connected_ = false;
}

HealthStatus PaperBrokerAdapter::health() const {
    return connected_ ? HealthStatus::Healthy : HealthStatus::Disconnected;
}

std::vector<BrokerCapability> PaperBrokerAdapter::capabilities() const {
    return {
        BrokerCapability::MarketOrder,
        BrokerCapability::StopLoss,
        BrokerCapability::TakeProfit,
        BrokerCapability::ModifyPosition
    };
}

bool PaperBrokerAdapter::supports(BrokerCapability cap) const {
    auto caps = capabilities();
    return std::find(caps.begin(), caps.end(), cap) != caps.end();
}

bool PaperBrokerAdapter::authenticate(const std::string& /*api_key*/,
                                     const std::string& /*password*/,
                                     const std::string& /*identifier*/) {
    return connect();
}

std::optional<BrokerAccountInfo> PaperBrokerAdapter::account_info() {
    if (!connected_) return std::nullopt;
    return account_;
}

std::optional<BrokerQuote> PaperBrokerAdapter::quote(InstrumentId instrument) {
    auto it = quotes_.find(instrument);
    if (it == quotes_.end()) return std::nullopt;
    return it->second;
}

void PaperBrokerAdapter::set_quote(InstrumentId instrument, const BrokerQuote& quote) {
    quotes_[instrument] = quote;
}

BrokerOrderResponse PaperBrokerAdapter::create_position(const BrokerOrderRequest& request) {
    BrokerOrderResponse resp;
    if (!connected_) {
        resp.error_message = "not connected";
        return resp;
    }
    auto qit = quotes_.find(request.instrument);
    double fill = request.price;
    if (qit != quotes_.end()) {
        fill = request.direction == Direction::Long ? qit->second.ask : qit->second.bid;
    }
    resp.success = true;
    resp.deal_id = "paper-deal-" + std::to_string(deal_counter_++);
    resp.fill_price = fill;
    resp.filled_quantity = request.quantity;

    BrokerPosition pos;
    pos.deal_id = resp.deal_id;
    pos.instrument = request.instrument;
    pos.direction = request.direction;
    pos.quantity = request.quantity;
    pos.entry_price = fill;
    pos.stop_loss = request.stop_loss;
    pos.take_profit = request.take_profit;
    open_positions_.push_back(pos);
    return resp;
}

BrokerOrderResponse PaperBrokerAdapter::close_position(const std::string& deal_id) {
    BrokerOrderResponse resp;
    auto it = std::find_if(open_positions_.begin(), open_positions_.end(),
        [&](const auto& p) { return p.deal_id == deal_id; });
    if (it == open_positions_.end()) {
        resp.error_message = "position not found";
        return resp;
    }
    resp.success = true;
    resp.deal_id = deal_id;
    open_positions_.erase(it);
    return resp;
}

std::vector<BrokerPosition> PaperBrokerAdapter::positions() {
    return open_positions_;
}

}  // namespace mr
