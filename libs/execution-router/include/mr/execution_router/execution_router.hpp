#pragma once

#include "mr/entry_engine/entry_engine.hpp"
#include "mr/position_engine/position_manager.hpp"
#include <vector>
#include <unordered_set>

namespace mr {

struct AccountConfig {
    ClientId client_id{0};
    AccountId account_id{0};
    InstrumentId instrument{kInvalidInstrument};
    double lot_size{0.01};
    bool enabled{true};
    bool trading_enabled{true};
};

struct ExecutionRequest {
    TradeIntent intent;
    AccountConfig account;
};

struct ExecutionResult {
    ExecutionId id{0};
    TradeIntentId intent_id{0};
    ClientId client_id{0};
    AccountId account_id{0};
    bool success{false};
    double fill_price{0};
    double quantity{0};
    std::string error_message;
    Timestamp executed_at{};
};

class ExecutionRouter {
public:
    explicit ExecutionRouter(IdGenerator& execution_ids);
    std::vector<ExecutionRequest> route(const TradeIntent& intent,
                                         const std::vector<AccountConfig>& accounts);
    bool is_duplicate(const TradeIntent& intent, AccountId account) const;
    void record_execution(const ExecutionResult& result);

private:
    IdGenerator& execution_ids_;
    std::unordered_set<std::uint64_t> executed_intents_;
};

}  // namespace mr
