#include "bench_stats.hpp"

#include "mr/clock/clock_engine.hpp"
#include "mr/normalization/normalization_engine.hpp"
#include "mr/data_quality/data_quality_engine.hpp"
#include "mr/feed_fusion/feed_fusion_engine.hpp"
#include "mr/feature_engine/feature_engine.hpp"
#include "mr/market_state/market_state_engine.hpp"
#include "mr/regime_engine/regime_engine.hpp"
#include "mr/setup_engine/setup_engine.hpp"
#include "mr/evidence_engine/evidence_engine.hpp"
#include "mr/entry_engine/entry_engine.hpp"
#include "mr/position_engine/position_manager.hpp"
#include "mr/exit_engine/exit_engine.hpp"

#include <iostream>
#include <vector>

namespace {

mr::NormalizedEvent make_event(std::uint64_t i) {
    mr::NormalizedEvent e;
    e.instrument = 1;
    e.source = 1;
    e.normalized_timestamp = mr::Timestamp(static_cast<long long>(i) * 100'000);
    e.receive_timestamp = e.normalized_timestamp;
    e.exchange_timestamp = e.normalized_timestamp;
    e.provider_timestamp = e.normalized_timestamp;
    e.type = mr::MarketEventType::Quote;
    const double mid = 1.0850 + (static_cast<double>(i % 100) - 50.0) * 0.00001;
    e.bid = mid - 0.00005;
    e.ask = mid + 0.00005;
    e.last = mid;
    e.bid_size = 100.0;
    e.ask_size = 100.0;
    e.sequence = i + 1;
    return e;
}

}  // namespace

int main() {
    constexpr std::size_t kWarmup = 1000;
    constexpr std::size_t kSamples = 20000;

    mr::ClockEngine clock;
    mr::NormalizationEngine normalization(clock);
    mr::DataQualityEngine dq;
    mr::FeedFusionEngine fusion;
    mr::FeatureEngine features;
    mr::IdGenerator snapshot_ids;
    mr::IdGenerator setup_ids;
    mr::IdGenerator report_ids;
    mr::IdGenerator intent_ids;
    mr::MarketStateEngine market_state(snapshot_ids);
    mr::RegimeEngine regime;
    mr::SetupEngine setup(setup_ids);
    mr::EvidenceEngine evidence(report_ids);
    mr::BaselineProbabilityModel model;
    mr::EntryEngine entry(intent_ids, model);
    mr::PositionManager positions;
    mr::ExitEngine exit_engine;

    std::vector<double> norm_ns;
    std::vector<double> feature_ns;
    std::vector<double> state_ns;
    std::vector<double> regime_ns;
    std::vector<double> setup_ns;
    std::vector<double> evidence_ns;
    std::vector<double> entry_ns;
    std::vector<double> position_ns;
    std::vector<double> exit_ns;
    std::vector<double> full_ns;
    norm_ns.reserve(kSamples);
    feature_ns.reserve(kSamples);
    state_ns.reserve(kSamples);
    regime_ns.reserve(kSamples);
    setup_ns.reserve(kSamples);
    evidence_ns.reserve(kSamples);
    entry_ns.reserve(kSamples);
    position_ns.reserve(kSamples);
    exit_ns.reserve(kSamples);
    full_ns.reserve(kSamples);

    mr::TradeIntent seed_intent;
    seed_intent.id = 1;
    seed_intent.instrument = 1;
    seed_intent.direction = mr::Direction::Long;
    seed_intent.initial_invalidation = 1.0840;
    seed_intent.expected_favorable_move = 0.0005;
    seed_intent.created_at = mr::Timestamp(0);
    auto position = positions.open_position(seed_intent, 1.0850, 0.1, 1, 1);

    std::cout << "=== Hot-path stage benchmark ===\n";
    std::cout << "Warmup=" << kWarmup << " samples=" << kSamples << "\n\n";

    for (std::size_t i = 0; i < kWarmup + kSamples; ++i) {
        const auto raw = make_event(i);
        mr::bench::ScopedTimer full_timer;
        full_timer.start();

        mr::bench::ScopedTimer t;
        t.start();
        auto normalized = normalization.normalize(raw);
        const double n_ns = t.elapsed_ns();

        dq.process(normalized, 500.0);
        auto health = dq.health(normalized.source);
        fusion.ingest(normalized, health);
        auto consensus = fusion.consensus(1);
        auto divergence = fusion.divergence(1);
        auto lead_lag = fusion.lead_lag(1);

        t.start();
        features.update(normalized, consensus.mid_price, divergence.mean_divergence,
                        lead_lag.lead_probability);
        auto feat = features.snapshot();
        const double f_ns = t.elapsed_ns();

        t.start();
        auto state = market_state.update(1, feat, consensus, divergence, lead_lag, dq);
        const double s_ns = t.elapsed_ns();

        t.start();
        auto rs = regime.update(1, state);
        const double r_ns = t.elapsed_ns();

        t.start();
        auto setups = setup.update(1, state, rs);
        const double su_ns = t.elapsed_ns();

        t.start();
        mr::EvidenceReport report;
        if (!setups.empty()) {
            evidence.observe(setups.front().id, state, rs, setups.front());
            report = evidence.evaluate(setups.front().id, setups.front(), state);
        } else {
            auto active = setup.active_setups(1);
            if (!active.empty()) {
                evidence.observe(active.front().id, state, rs, active.front());
                report = evidence.evaluate(active.front().id, active.front(), state);
            }
        }
        const double e_ns = t.elapsed_ns();

        t.start();
        mr::BrokerQuote quote;
        quote.bid = consensus.mid_price - consensus.spread / 2.0;
        quote.ask = consensus.mid_price + consensus.spread / 2.0;
        quote.timestamp = state.timestamp;
        quote.valid = consensus.mid_price > 0;
        if (!setups.empty() && report.is_valid) {
            (void)entry.evaluate(setups.front(), report, state, rs, quote, consensus.spread);
        }
        const double en_ns = t.elapsed_ns();

        t.start();
        if (normalized.last) {
            positions.update_excursions(position, *normalized.last);
        }
        const double p_ns = t.elapsed_ns();

        t.start();
        (void)exit_engine.decide(position, state, rs, report, 0.6, 0.4);
        const double x_ns = t.elapsed_ns();

        const double full = full_timer.elapsed_ns();

        if (i >= kWarmup) {
            norm_ns.push_back(n_ns);
            feature_ns.push_back(f_ns);
            state_ns.push_back(s_ns);
            regime_ns.push_back(r_ns);
            setup_ns.push_back(su_ns);
            evidence_ns.push_back(e_ns);
            entry_ns.push_back(en_ns);
            position_ns.push_back(p_ns);
            exit_ns.push_back(x_ns);
            full_ns.push_back(full);
        }
    }

    const auto stages = std::vector<mr::bench::StageStats>{
        mr::bench::compute_stage_stats("Normalization", norm_ns),
        mr::bench::compute_stage_stats("Feature Engine", feature_ns),
        mr::bench::compute_stage_stats("Market State", state_ns),
        mr::bench::compute_stage_stats("Regime", regime_ns),
        mr::bench::compute_stage_stats("Setup", setup_ns),
        mr::bench::compute_stage_stats("Evidence", evidence_ns),
        mr::bench::compute_stage_stats("Entry Decision", entry_ns),
        mr::bench::compute_stage_stats("Position Update", position_ns),
        mr::bench::compute_stage_stats("Exit Decision", exit_ns),
        mr::bench::compute_stage_stats("Full Pipeline", full_ns),
    };

    for (const auto& s : stages) {
        mr::bench::print_stage_stats(s);
    }

    std::cout << "\n### Markdown table (microseconds)\n";
    std::cout << "| Pipeline stage | p50 (us) | p95 (us) | p99 (us) | max (us) |\n";
    std::cout << "|---|---:|---:|---:|---:|\n";
    for (const auto& s : stages) {
        mr::bench::print_markdown_row(s);
    }

    const auto& full = stages.back();
    std::cout << "\nMax sustainable events/sec (mean full pipeline): "
              << static_cast<std::uint64_t>(full.events_per_sec) << "\n";
    return 0;
}
