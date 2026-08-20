#include "mr/execution_router/execution_router.hpp"
#include "mr/broker_adapters/broker_adapter.hpp"
#include "mr/position_engine/position_manager.hpp"
#include "mr/exit_engine/exit_engine.hpp"
#include <spdlog/spdlog.h>
#include <iostream>
#include <csignal>
#include <atomic>
#include <thread>
#include <unordered_map>

static std::atomic<bool> g_running{true};

void signal_handler(int) {
    g_running = false;
}

int main(int argc, char* argv[]) {
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    spdlog::set_level(spdlog::level::info);
    spdlog::info("Execution Service starting...");

    std::string mode_str = "PAPER";
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--mode" && i + 1 < argc) {
            mode_str = argv[++i];
        }
    }

    mr::IdGenerator execution_ids;
    mr::ExecutionRouter router(execution_ids);
    mr::PositionManager position_manager;
    mr::ExitEngine exit_engine;

    std::unordered_map<mr::AccountId, std::unique_ptr<mr::IBrokerAdapter>> brokers;

    auto paper = std::make_unique<mr::PaperBrokerAdapter>();
    paper->connect();
    mr::BrokerQuote quote;
    quote.bid = 1.08495;
    quote.ask = 1.08505;
    quote.timestamp = mr::now_utc_ns();
    quote.valid = true;
    paper->set_quote(1, quote);
    brokers[1] = std::move(paper);

    mr::AccountConfig account;
    account.client_id = 1;
    account.account_id = 1;
    account.instrument = 1;
    account.lot_size = 0.1;
    account.enabled = true;
    account.trading_enabled = true;

    mr::TradeIntent intent;
    intent.id = 1;
    intent.instrument = 1;
    intent.direction = mr::Direction::Long;
    intent.decision = mr::EntryDecision::EntryReady;
    intent.reference_price = 1.0850;
    intent.acceptable_entry_min = 1.08495;
    intent.acceptable_entry_max = 1.08505;
    intent.expected_favorable_move = 0.0003;
    intent.expected_adverse_move = 0.0002;
    intent.initial_invalidation = 1.0848;
    intent.created_at = mr::now_utc_ns();
    intent.expires_at = mr::Timestamp(intent.created_at.count() + 2'000'000'000LL);

    auto requests = router.route(intent, {account});
    spdlog::info("Routed {} execution requests", requests.size());

    for (const auto& req : requests) {
        auto& broker = brokers[req.account.account_id];
        if (!broker || !broker->is_connected()) {
            spdlog::error("Broker not connected for account {}", req.account.account_id);
            continue;
        }

        mr::BrokerOrderRequest order;
        order.instrument = req.intent.instrument;
        order.direction = req.intent.direction;
        order.quantity = req.account.lot_size;
        order.stop_loss = req.intent.initial_invalidation;
        order.take_profit = req.intent.reference_price + req.intent.expected_favorable_move;
        order.is_market = true;

        auto resp = broker->create_position(order);
        mr::ExecutionResult result;
        result.id = execution_ids.generate();
        result.intent_id = req.intent.id;
        result.client_id = req.account.client_id;
        result.account_id = req.account.account_id;
        result.success = resp.success;
        result.fill_price = resp.fill_price;
        result.quantity = resp.filled_quantity;
        result.executed_at = mr::now_utc_ns();
        result.error_message = resp.error_message;

        router.record_execution(result);

        if (result.success) {
            spdlog::info("Executed intent {} at {:.5f} qty={}",
                result.intent_id, result.fill_price, result.quantity);

            auto position = position_manager.open_position(
                req.intent, result.fill_price, result.quantity,
                req.account.client_id, req.account.account_id);

            mr::MarketState state;
            state.instrument = 1;
            state.timestamp = mr::now_utc_ns();
            state.features.price.return_value = 0.0001;

            mr::RegimeState regime;
            regime.current = mr::Regime::TrendUp;
            regime.confidence = 0.7;

            mr::EvidenceReport evidence;
            evidence.is_valid = true;

            auto decision = position_manager.evaluate(position, state, regime, evidence, quote);
            auto exit_decision = exit_engine.decide(position, state, regime, evidence,
                decision.continuation_probability, decision.reversal_probability);

            spdlog::info("Position {} action={} reason={}",
                position.id, static_cast<int>(exit_decision.action),
                static_cast<int>(exit_decision.reason));
        } else {
            spdlog::error("Execution failed: {}", result.error_message);
        }
    }

    spdlog::info("Execution Service stopped.");
    return 0;
}
