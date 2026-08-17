#include <gtest/gtest.h>
#include "mr/entry_engine/entry_engine.hpp"
#include "mr/evidence_engine/evidence_engine.hpp"
#include "mr/setup_engine/setup_engine.hpp"
#include "mr/market_state/market_state_engine.hpp"
#include "mr/regime_engine/regime_engine.hpp"
#include "mr/feature_engine/feature_engine.hpp"
#include "mr/data_quality/data_quality_engine.hpp"
#include <chrono>
#include <vector>
#include <algorithm>
#include <numeric>
#include <iostream>
#include <iomanip>

TEST(EntryHotPath, RequiresSetupAndEvidence) {
    mr::IdGenerator setup_ids, report_ids, intent_ids, snap_ids;
    mr::BaselineProbabilityModel model;
    mr::SetupEngine setup(setup_ids);
    mr::EntryEngine entry(intent_ids, model);
    mr::MarketStateEngine mse(snap_ids);
    mr::RegimeEngine re;
    mr::FeatureEngine fe;
    mr::DataQualityEngine dq;
    mr::FeedConsensus consensus;
    consensus.mid_price = 1.0850;
    consensus.spread = 0.0001;
    consensus.confidence = 0.9;
    consensus.contributing_sources = 2;

    mr::NormalizedEvent event;
    event.instrument = 1;
    event.normalized_timestamp = mr::now_utc_ns();
    event.bid = 1.08495;
    event.ask = 1.08505;
    event.type = mr::MarketEventType::Quote;

    for (int i = 0; i < 50; ++i) {
        event.normalized_timestamp = mr::Timestamp(event.normalized_timestamp.count() + 1'000'000);
        fe.update(event, consensus.mid_price, 0, 0.5);
    }

    auto features = fe.snapshot();
    auto state = mse.update(1, features, consensus, {}, {}, dq);
    auto regime = re.update(1, state);
    auto setups = setup.update(1, state, regime);

    if (!setups.empty()) {
        mr::EvidenceReport empty;
        empty.is_valid = false;
        mr::BrokerQuote q{1.08495, 1.08505, state.timestamp, true};
        auto intent = entry.evaluate(setups.front(), empty, state, regime, q, 0.0001);
        EXPECT_NE(intent.decision, mr::EntryDecision::EntryReady);
    }
}

TEST(EntryHotPath, MeasuresReceiveToIntent) {
    mr::IdGenerator intent_ids;
    mr::BaselineProbabilityModel model;
    mr::EntryEngine entry(intent_ids, model);

    mr::SetupCandidate setup;
    setup.id = 1;
    setup.instrument = 1;
    setup.direction = mr::Direction::Long;
    setup.lifecycle = mr::SetupLifecycle::Confirmed;
    setup.setup_type = "CONTINUATION";
    setup.regime = mr::Regime::PullbackUptrend;
    setup.confidence = 0.8;

    mr::MarketState state;
    state.instrument = 1;
    state.timestamp = mr::now_utc_ns();
    state.snapshot_id = 1;
    state.data_quality.overall_score = 0.9;
    state.direction.confidence = 0.8;
    state.flow.net_flow = 1.0;
    state.multi_feed.consensus_confidence = 0.9;
    state.liquidity.spread = 0.0001;

    mr::EvidenceReport report;
    report.id = 1;
    report.is_valid = true;
    report.evidence_strength = 2.0;
    report.feed_quality = 0.9;
    mr::EvidenceEvent ev;
    ev.type = mr::EvidenceType::BuyResponse;
    ev.direction = mr::Direction::Long;
    ev.strength = 1.0;
    report.supporting = {ev, ev};

    mr::RegimeState regime;
    regime.current = mr::Regime::PullbackUptrend;
    regime.confidence = 0.8;
    mr::BrokerQuote quote{1.08495, 1.08505, state.timestamp, true};

    std::vector<double> samples;
    for (int i = 0; i < 5000; ++i) {
        const auto start = std::chrono::steady_clock::now();
        auto intent = entry.evaluate(setup, report, state, regime, quote, 0.0001);
        const auto end = std::chrono::steady_clock::now();
        samples.push_back(static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count()));
        EXPECT_FALSE(intent.human_explanation.empty());
        if (intent.decision == mr::EntryDecision::EntryReady) {
            EXPECT_TRUE(report.is_valid);
            EXPECT_EQ(setup.lifecycle, mr::SetupLifecycle::Confirmed);
        }
    }
    std::sort(samples.begin(), samples.end());
    const double mean = std::accumulate(samples.begin(), samples.end(), 0.0) / samples.size();
    auto pct = [&](double p) {
        return samples[static_cast<std::size_t>(p * (samples.size() - 1))];
    };
    std::cout << std::fixed << std::setprecision(3);
    std::cout << "EntryHotPath mean=" << mean / 1000.0 << "us"
              << " p50=" << pct(0.5) / 1000.0 << "us"
              << " p95=" << pct(0.95) / 1000.0 << "us"
              << " p99=" << pct(0.99) / 1000.0 << "us"
              << " max=" << samples.back() / 1000.0 << "us\n";
}
