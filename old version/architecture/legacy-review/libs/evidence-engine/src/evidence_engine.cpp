#include "mr/evidence_engine/evidence_engine.hpp"
#include <algorithm>

namespace mr {

EvidenceEngine::EvidenceEngine(IdGenerator& report_ids) : report_ids_(report_ids) {}

void EvidenceEngine::detect_evidence(
    SetupId setup_id, const MarketState& state, const SetupCandidate& setup) {
    auto& seq = sequences_[setup_id];
    seq.setup_id = setup_id;

    auto push_unique = [&](EvidenceType type, double strength, Direction direction) {
        if (!seq.events.empty() && seq.events.back().type == type &&
            seq.events.back().direction == direction) {
            // Refresh strength of the latest matching event instead of appending duplicates.
            seq.events.back().strength = std::max(seq.events.back().strength, strength);
            seq.events.back().timestamp = state.timestamp;
            return;
        }
        EvidenceEvent ev;
        ev.type = type;
        ev.timestamp = state.timestamp;
        ev.strength = strength;
        ev.direction = direction;
        seq.events.push_back(ev);
    };

    if (setup.direction == Direction::Long) {
        if (state.features.price.acceleration > 0 && state.features.price.velocity < 0) {
            push_unique(EvidenceType::SellingDeceleration,
                        std::abs(state.features.price.acceleration), Direction::Long);
        }
        if (state.flow.net_flow > 0) {
            push_unique(EvidenceType::BuyResponse, state.flow.net_flow, Direction::Long);
        }
        if (state.features.price.velocity > 0 && state.structure.range_position > 0.5) {
            push_unique(EvidenceType::Acceptance, state.features.price.velocity, Direction::Long);
        }
    } else if (setup.direction == Direction::Short) {
        if (state.features.price.acceleration < 0 && state.features.price.velocity > 0) {
            push_unique(EvidenceType::BuyingDeceleration,
                        std::abs(state.features.price.acceleration), Direction::Short);
        }
        if (state.flow.net_flow < 0) {
            push_unique(EvidenceType::SellResponse, std::abs(state.flow.net_flow), Direction::Short);
        }
    }

    if (state.multi_feed.consensus_confidence > 0.7) {
        push_unique(EvidenceType::MultiFeedConfirmation,
                    state.multi_feed.consensus_confidence, setup.direction);
    }

    if (state.data_quality.stale) {
        push_unique(EvidenceType::StaleFeed, 1.0, Direction::Flat);
    }

    while (seq.events.size() > 50) {
        seq.events.pop_front();
    }

    seq.sequence_quality = std::min(1.0, static_cast<double>(seq.events.size()) / 10.0);
}

void EvidenceEngine::observe(SetupId setup_id, const MarketState& state,
                              const RegimeState& /*regime*/, const SetupCandidate& setup) {
    detect_evidence(setup_id, state, setup);
}

EvidenceReport EvidenceEngine::evaluate(
    SetupId setup_id, const SetupCandidate& setup, const MarketState& state) {
    EvidenceReport report;
    report.id = report_ids_.generate();
    report.setup_id = setup_id;
    report.market_state_snapshot_id = state.snapshot_id;
    report.regime = setup.regime;
    report.feed_quality = state.data_quality.overall_score;

    auto it = sequences_.find(setup_id);
    if (it == sequences_.end()) {
        report.invalidation_reasons.push_back("NO_EVIDENCE_SEQUENCE");
        return report;
    }

    const auto& seq = it->second;
    report.sequence_quality = seq.sequence_quality;
    report.evidence_age_ms = seq.events.empty() ? 0 :
        static_cast<double>((state.timestamp - seq.events.front().timestamp).count()) / 1e6;

    double support_sum = 0;
    double contradict_sum = 0;

    for (const auto& ev : seq.events) {
        if (ev.type == EvidenceType::StaleFeed || ev.type == EvidenceType::SpreadWidening) {
            report.contradicting.push_back(ev);
            contradict_sum += ev.strength;
        } else if (ev.direction == setup.direction) {
            report.supporting.push_back(ev);
            support_sum += ev.strength;
        } else if (ev.direction != Direction::Flat) {
            report.contradicting.push_back(ev);
            contradict_sum += ev.strength;
        }
    }

    report.evidence_strength = support_sum - contradict_sum;
    // Real setup: strong single confirmation OR classic multi-evidence
    const bool strong_one =
        report.supporting.size() >= 1 && report.evidence_strength > 0.75;
    const bool multi =
        report.supporting.size() >= 2 && report.evidence_strength > 0.5;
    report.is_valid = (strong_one || multi) &&
                      report.feed_quality > 0.5 &&
                      !state.data_quality.stale;

    if (state.data_quality.stale) {
        report.invalidation_reasons.push_back("STALE_DATA");
    }
    if (!strong_one && report.supporting.size() < 2) {
        report.invalidation_reasons.push_back("INSUFFICIENT_EVIDENCE");
    }
    if (contradict_sum > support_sum) {
        report.invalidation_reasons.push_back("CONTRADICTORY_EVIDENCE");
    }

    return report;
}

EvidenceSequence EvidenceEngine::sequence(SetupId setup_id) const {
    auto it = sequences_.find(setup_id);
    if (it == sequences_.end()) return {};
    return it->second;
}

}  // namespace mr
