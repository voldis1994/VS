#include <gtest/gtest.h>
#include "mr/entry_engine/entry_engine.hpp"
#include "mr/evidence_engine/evidence_engine.hpp"
#include "mr/setup_engine/setup_engine.hpp"

class EntryQualityTest : public ::testing::Test {
protected:
    mr::IdGenerator setup_ids_;
    mr::IdGenerator report_ids_;
    mr::IdGenerator intent_ids_;
    mr::BaselineProbabilityModel model_;
    mr::SetupEngine setup_engine_{setup_ids_};
    mr::EvidenceEngine evidence_engine_{report_ids_};
    mr::EntryEngine entry_engine_{intent_ids_, model_};

    mr::SetupCandidate make_confirmed_setup() {
        mr::SetupCandidate setup;
        setup.id = 1;
        setup.instrument = 1;
        setup.direction = mr::Direction::Long;
        setup.lifecycle = mr::SetupLifecycle::Confirmed;
        setup.setup_type = "CONTINUATION";
        setup.regime = mr::Regime::PullbackUptrend;
        setup.confidence = 0.8;
        return setup;
    }

    mr::MarketState make_state(bool stale = false) {
        mr::MarketState state;
        state.instrument = 1;
        state.timestamp = mr::now_utc_ns();
        state.snapshot_id = 1;
        state.data_quality.stale = stale;
        state.data_quality.overall_score = stale ? 0.3 : 0.9;
        state.direction.confidence = 0.7;
        state.flow.net_flow = 1.0;
        state.multi_feed.consensus_confidence = 0.8;
        state.liquidity.spread = 0.0001;
        state.features.price.velocity = 0.0001;
        return state;
    }

    mr::EvidenceReport make_valid_evidence() {
        mr::EvidenceReport report;
        report.id = 1;
        report.is_valid = true;
        report.evidence_strength = 2.0;
        report.feed_quality = 0.9;
        mr::EvidenceEvent ev;
        ev.type = mr::EvidenceType::BuyResponse;
        ev.direction = mr::Direction::Long;
        ev.strength = 1.0;
        report.supporting.push_back(ev);
        report.supporting.push_back(ev);
        return report;
    }
};

TEST_F(EntryQualityTest, NoEntryWithoutEvidence) {
    auto setup = make_confirmed_setup();
    auto state = make_state();
    mr::EvidenceReport invalid_evidence;
    invalid_evidence.is_valid = false;
    mr::RegimeState regime;
    mr::BrokerQuote quote{1.0849, 1.0851, mr::now_utc_ns(), true};
    auto intent = entry_engine_.evaluate(setup, invalid_evidence, state, regime, quote, 0.0001);
    EXPECT_NE(intent.decision, mr::EntryDecision::EntryReady);
}

TEST_F(EntryQualityTest, NoEntryWithoutConfirmedSetup) {
    auto setup = make_confirmed_setup();
    setup.lifecycle = mr::SetupLifecycle::Building;
    auto state = make_state();
    auto evidence = make_valid_evidence();
    mr::RegimeState regime;
    mr::BrokerQuote quote{1.0849, 1.0851, mr::now_utc_ns(), true};
    auto intent = entry_engine_.evaluate(setup, evidence, state, regime, quote, 0.0001);
    EXPECT_EQ(intent.decision, mr::EntryDecision::NoTrade);
}

TEST_F(EntryQualityTest, StaleDataBlocksEntry) {
    auto setup = make_confirmed_setup();
    auto state = make_state(true);
    auto evidence = make_valid_evidence();
    mr::RegimeState regime;
    mr::BrokerQuote quote{1.0849, 1.0851, mr::now_utc_ns(), true};
    auto intent = entry_engine_.evaluate(setup, evidence, state, regime, quote, 0.0001);
    EXPECT_EQ(intent.decision, mr::EntryDecision::Reject);
}

TEST_F(EntryQualityTest, ExpiredIntentRejected) {
    std::vector<mr::TradeIntent> intents;
    mr::TradeIntent intent;
    intent.decision = mr::EntryDecision::EntryReady;
    intent.expires_at = mr::Timestamp(1000);
    intents.push_back(intent);
    entry_engine_.reject_stale(intents, mr::Timestamp(2000));
    EXPECT_EQ(intents[0].decision, mr::EntryDecision::Reject);
}

TEST_F(EntryQualityTest, SpreadCanNullifyEdge) {
    auto setup = make_confirmed_setup();
    auto state = make_state();
    auto evidence = make_valid_evidence();
    mr::RegimeState regime;
    mr::BrokerQuote quote{1.0849, 1.0851, mr::now_utc_ns(), true};
    auto intent = entry_engine_.evaluate(setup, evidence, state, regime, quote, 10.0);
    EXPECT_NE(intent.expected_value_after_costs, intent.expected_value_before_costs);
}

TEST_F(EntryQualityTest, EntryHasExplanation) {
    auto setup = make_confirmed_setup();
    auto state = make_state();
    auto evidence = make_valid_evidence();
    mr::RegimeState regime;
    mr::BrokerQuote quote{1.0849, 1.0851, mr::now_utc_ns(), true};
    auto intent = entry_engine_.evaluate(setup, evidence, state, regime, quote, 0.0001);
    EXPECT_FALSE(intent.human_explanation.empty());
    EXPECT_FALSE(intent.reason_codes.empty());
}
