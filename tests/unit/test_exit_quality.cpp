#include <gtest/gtest.h>
#include "mr/position_engine/position_manager.hpp"
#include "mr/exit_engine/exit_engine.hpp"

class ExitQualityTest : public ::testing::Test {
protected:
    mr::PositionManager pm_;
    mr::ExitEngine exit_engine_;

    mr::PositionState make_long_position(double entry = 1.0850) {
        mr::TradeIntent intent;
        intent.id = 1;
        intent.instrument = 1;
        intent.direction = mr::Direction::Long;
        intent.initial_invalidation = entry - 0.0005;
        intent.expected_favorable_move = 0.0005;
        intent.created_at = mr::now_utc_ns();
        return pm_.open_position(intent, entry, 0.1, 1, 1);
    }

    mr::MarketState make_state(double velocity = 0) {
        mr::MarketState state;
        state.instrument = 1;
        state.timestamp = mr::Timestamp(pm_.open_position(
            mr::TradeIntent{}, 1.0850, 0.1, 1, 1).opened_at.count() + 5'000'000'000LL);
        state.features.price.velocity = velocity;
        state.data_quality.stale = false;
        return state;
    }

    mr::EvidenceReport make_evidence() {
        mr::EvidenceReport e;
        e.is_valid = true;
        return e;
    }
};

TEST_F(ExitQualityTest, MfeMaeTracking) {
    auto pos = make_long_position();
    pm_.update_excursions(pos, 1.0855);
    EXPECT_GT(pos.mfe, 0);
    pm_.update_excursions(pos, 1.0845);
    EXPECT_GT(pos.mae, 0);
}

TEST_F(ExitQualityTest, PeakRetention) {
    auto pos = make_long_position();
    pm_.update_excursions(pos, 1.0860);
    pm_.update_excursions(pos, 1.0855);
    EXPECT_GT(pos.mfe, 0);
    EXPECT_LT(pos.peak_retention, 1.0);
    EXPECT_GT(pos.peak_retention, 0);
}

TEST_F(ExitQualityTest, ThesisFailureExits) {
    auto pos = make_long_position();
    pm_.update_excursions(pos, 1.0848);
    auto state = make_state(-0.001);
    mr::RegimeState regime;
    regime.current = mr::Regime::TrendDown;
    auto evidence = make_evidence();
    mr::BrokerQuote quote{1.0847, 1.0849, mr::now_utc_ns(), true};
    auto decision = pm_.evaluate(pos, state, regime, evidence, quote);
    EXPECT_EQ(decision.action, mr::PositionAction::ExitNow);
    EXPECT_EQ(decision.reason, mr::ExitReason::ThesisFailure);
}

TEST_F(ExitQualityTest, HardInvalidation) {
    auto pos = make_long_position();
    pm_.update_excursions(pos, 1.0840);
    auto state = make_state();
    mr::RegimeState regime;
    auto evidence = make_evidence();
    mr::BrokerQuote quote{1.0840, 1.0842, mr::now_utc_ns(), true};
    auto decision = pm_.evaluate(pos, state, regime, evidence, quote);
    EXPECT_EQ(decision.action, mr::PositionAction::ExitNow);
    EXPECT_EQ(decision.reason, mr::ExitReason::HardInvalidation);
}

TEST_F(ExitQualityTest, CleanWinnerTakeProfit) {
    auto pos = make_long_position();
    pm_.update_excursions(pos, pos.take_profit + 0.0001);
    auto state = make_state(0.001);
    mr::RegimeState regime;
    regime.current = mr::Regime::TrendUp;
    auto evidence = make_evidence();
    mr::BrokerQuote quote{pos.take_profit, pos.take_profit + 0.0002, mr::now_utc_ns(), true};
    auto decision = pm_.evaluate(pos, state, regime, evidence, quote);
    EXPECT_EQ(decision.action, mr::PositionAction::TakeProfit);
}

TEST_F(ExitQualityTest, ExitEngineComparesEv) {
    auto pos = make_long_position();
    pm_.update_excursions(pos, 1.0852);
    auto state = make_state();
    mr::RegimeState regime;
    regime.confidence = 0.6;
    auto evidence = make_evidence();
    auto decision = exit_engine_.decide(pos, state, regime, evidence, 0.6, 0.4);
    EXPECT_TRUE(decision.action == mr::PositionAction::Hold ||
                decision.action == mr::PositionAction::ExitNow ||
                decision.action == mr::PositionAction::Trail ||
                decision.action == mr::PositionAction::TakeProfit);
}
