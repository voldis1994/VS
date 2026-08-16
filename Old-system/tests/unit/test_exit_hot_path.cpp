#include <gtest/gtest.h>
#include "mr/position_engine/position_manager.hpp"
#include "mr/exit_engine/exit_engine.hpp"
#include <chrono>
#include <vector>
#include <algorithm>
#include <numeric>
#include <iostream>
#include <iomanip>

TEST(ExitHotPath, MeasuresPositionToDecision) {
    mr::PositionManager pm;
    mr::ExitEngine exit_engine;

    mr::TradeIntent intent;
    intent.id = 1;
    intent.instrument = 1;
    intent.direction = mr::Direction::Long;
    intent.initial_invalidation = 1.0845;
    intent.expected_favorable_move = 0.0005;
    intent.created_at = mr::Timestamp(0);
    auto pos = pm.open_position(intent, 1.0850, 0.1, 1, 1);

    mr::MarketState state;
    state.instrument = 1;
    state.timestamp = mr::Timestamp(5'000'000'000LL);
    state.features.price.velocity = 0.00005;
    state.data_quality.stale = false;

    mr::RegimeState regime;
    regime.current = mr::Regime::TrendUp;
    regime.confidence = 0.7;

    mr::EvidenceReport evidence;
    evidence.is_valid = true;

    std::vector<double> samples;
    samples.reserve(5000);
    for (int i = 0; i < 5000; ++i) {
        const double price = 1.0850 + (i % 50) * 0.00001;
        const auto start = std::chrono::steady_clock::now();
        pm.update_excursions(pos, price);
        auto decision = exit_engine.decide(pos, state, regime, evidence, 0.7, 0.3);
        const auto end = std::chrono::steady_clock::now();
        samples.push_back(static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count()));
        EXPECT_TRUE(decision.action == mr::PositionAction::Hold ||
                    decision.action == mr::PositionAction::ExitNow ||
                    decision.action == mr::PositionAction::Trail ||
                    decision.action == mr::PositionAction::TakeProfit);
    }

    std::sort(samples.begin(), samples.end());
    const double mean = std::accumulate(samples.begin(), samples.end(), 0.0) / samples.size();
    auto pct = [&](double p) {
        return samples[static_cast<std::size_t>(p * (samples.size() - 1))];
    };
    std::cout << std::fixed << std::setprecision(3);
    std::cout << "ExitHotPath mean=" << mean / 1000.0 << "us"
              << " p50=" << pct(0.5) / 1000.0 << "us"
              << " p95=" << pct(0.95) / 1000.0 << "us"
              << " p99=" << pct(0.99) / 1000.0 << "us"
              << " max=" << samples.back() / 1000.0 << "us\n";
}

TEST(ExitHotPath, ScenarioCleanWinner) {
    mr::PositionManager pm;
    auto pos = pm.open_position(
        [] {
            mr::TradeIntent i;
            i.direction = mr::Direction::Long;
            i.initial_invalidation = 1.0840;
            i.expected_favorable_move = 0.0005;
            i.created_at = mr::Timestamp(0);
            return i;
        }(),
        1.0850, 0.1, 1, 1);
    pm.update_excursions(pos, pos.take_profit + 0.0001);
    mr::MarketState state;
    state.timestamp = mr::Timestamp(2'000'000'000LL);
    mr::RegimeState regime;
    regime.current = mr::Regime::TrendUp;
    mr::EvidenceReport evidence;
    mr::BrokerQuote quote{pos.take_profit, pos.take_profit + 0.0001, state.timestamp, true};
    auto d = pm.evaluate(pos, state, regime, evidence, quote);
    EXPECT_EQ(d.action, mr::PositionAction::TakeProfit);
}

TEST(ExitHotPath, ScenarioImmediateFailure) {
    mr::PositionManager pm;
    auto pos = pm.open_position(
        [] {
            mr::TradeIntent i;
            i.direction = mr::Direction::Long;
            i.initial_invalidation = 1.0845;
            i.expected_favorable_move = 0.0005;
            i.created_at = mr::Timestamp(0);
            return i;
        }(),
        1.0850, 0.1, 1, 1);
    pm.update_excursions(pos, 1.0840);
    mr::MarketState state;
    state.timestamp = mr::Timestamp(500'000'000LL);
    mr::RegimeState regime;
    mr::EvidenceReport evidence;
    mr::BrokerQuote quote{1.0840, 1.0841, state.timestamp, true};
    auto d = pm.evaluate(pos, state, regime, evidence, quote);
    EXPECT_EQ(d.action, mr::PositionAction::ExitNow);
    EXPECT_EQ(d.reason, mr::ExitReason::HardInvalidation);
}
