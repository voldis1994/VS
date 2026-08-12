#include "mr/evidence_engine/evidence_engine.hpp"

namespace mr {

EvidenceEngine::EvidenceEngine(IdGenerator& report_ids) : report_ids_(report_ids) {}

void EvidenceEngine::detect_evidence(
    SetupId setup_id, const MarketState& state, const SetupCandidate& setup) {
    auto& seq = sequences_[setup_id];
    seq.setup_id = setup_id;

    EvidenceEvent ev;
    ev.timestamp = state.timestamp;

    if (setup.direction == Direction::Long) {
        if (state.features.price.acceleration > 0 && state.features.price.velocity < 0) {
            ev.type = EvidenceType::SellingDeceleration;
            ev.strength = std::abs(state.features.price.acceleration);
            ev.direction = Direction::Long;
            seq.events.push_back(ev);
        }
        if (state.flow.net_flow > 0) {
            ev.type = EvidenceType::BuyResponse;
            ev.strength = state.flow.net_flow;
            ev.direction = Direction::Long;
            seq.events.push_back(ev);
        }
        if (state.features.price.velocity > 0 && state.structure.range_position > 0.5) {
            ev.type = EvidenceType::Acceptance;
            ev.strength = state.features.price.velocity;
            ev.direction = Direction::Long;
            seq.events.push_back(ev);
        }
    } else if (setup.direction == Direction::Short) {
        if (state.features.price.acceleration < 0 && state.features.price.velocity > 0) {
            ev.type = EvidenceType::BuyingDeceleration;
            ev.strength = std::abs(state.features.price.acceleration);
            ev.direction = Direction::Short;
            seq.events.push_back(ev);
        }
        if (state.flow.net_flow < 0) {
            ev.type = EvidenceType::SellResponse;
            ev.strength = std::abs(state.flow.net_flow);
            ev.direction = Direction::Short;
            seq.events.push_back(ev);
        }
    }

    if (state.multi_feed.consensus_confidence > 0.7) {
        ev.type = EvidenceType::MultiFeedConfirmation;
        ev.strength = state.multi_feed.consensus_confidence;
        ev.direction = setup.direction;
        seq.events.push_back(ev);
    }

    if (state.data_quality.stale) {
        ev.type = EvidenceType::StaleFeed;
        ev.strength = 1.0;
        seq.events.push_back(ev);
    }

    if (seq.events.size() > 50) {
        seq.events.pop_front();
    }

    seq.sequence_quality = static_cast<double>(seq.events.size()) / 10.0;
    if (seq.sequence_quality > 1.0) seq.sequence_quality = 1.0;
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
    report.is_valid = report.evidence_strength > 0.5 &&
                      report.supporting.size() >= 2 &&
                      report.feed_quality > 0.5 &&
                      !state.data_quality.stale;

    if (state.data_quality.stale) {
        report.invalidation_reasons.push_back("STALE_DATA");
    }
    if (report.supporting.size() < 2) {
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
