#include "mr/execution_router/execution_router.hpp"

namespace mr {

ExecutionRouter::ExecutionRouter(IdGenerator& execution_ids)
    : execution_ids_(execution_ids) {}

std::vector<ExecutionRequest> ExecutionRouter::route(
    const TradeIntent& intent, const std::vector<AccountConfig>& accounts) {
    std::vector<ExecutionRequest> requests;
    if (intent.decision != EntryDecision::EntryReady) return requests;

    for (const auto& account : accounts) {
        if (!account.enabled || !account.trading_enabled) continue;
        if (account.instrument != intent.instrument) continue;
        if (is_duplicate(intent, account.account_id)) continue;

        ExecutionRequest req;
        req.intent = intent;
        req.account = account;
        requests.push_back(req);
    }
    return requests;
}

bool ExecutionRouter::is_duplicate(const TradeIntent& intent, AccountId account) const {
    std::uint64_t key = (static_cast<std::uint64_t>(intent.id) << 32) | account;
    return executed_intents_.count(key) > 0;
}

void ExecutionRouter::record_execution(const ExecutionResult& result) {
    if (result.success) {
        std::uint64_t key = (static_cast<std::uint64_t>(result.intent_id) << 32) |
                            result.account_id;
        executed_intents_.insert(key);
    }
}

}  // namespace mr
