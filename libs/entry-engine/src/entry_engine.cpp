#include "mr/entry_engine/entry_engine.hpp"
#include <sstream>
#include <cmath>

namespace mr {

double BaselineProbabilityModel::probability_target_before_invalidation(
    const MarketState& state, Direction direction) const {
    double base = 0.5;
    base += state.direction.confidence * 0.2;
    base += state.multi_feed.consensus_confidence * 0.15;
    if (direction == Direction::Long && state.flow.net_flow > 0) base += 0.1;
    if (direction == Direction::Short && state.flow.net_flow < 0) base += 0.1;
    // Early in range (not chasing) → boost; late extreme → cut
    if (direction == Direction::Long && state.structure.range_position < 0.55) base += 0.08;
    if (direction == Direction::Short && state.structure.range_position > 0.45) base += 0.08;
    if (direction == Direction::Long && state.structure.range_position > 0.88) base -= 0.25;
    if (direction == Direction::Short && state.structure.range_position < 0.12) base -= 0.25;
    if (state.data_quality.stale) base -= 0.3;
    return std::clamp(base, 0.0, 1.0);
}

EntryEngine::EntryEngine(IdGenerator& intent_ids, const IProbabilityModel& model)
    : intent_ids_(intent_ids), model_(model) {}

double EntryEngine::compute_ev(double prob_win, double expected_win,
                                double expected_loss, double costs) const {
    return prob_win * expected_win - (1.0 - prob_win) * expected_loss - costs;
}

std::string EntryEngine::build_explanation(
    const SetupCandidate& setup, const EvidenceReport& evidence,
    const RegimeState& regime, EntryDecision decision) const {
    std::ostringstream oss;
    oss << "REGIME:\n" << regime_name(regime.current) << "\n";
    oss << "SETUP:\n" << setup.setup_type << "\n";
    oss << "SUPPORTING EVIDENCE:\n";
    for (const auto& ev : evidence.supporting) {
        oss << "- " << evidence_type_name(ev.type) << "\n";
    }
    if (!evidence.contradicting.empty()) {
        oss << "CONTRADICTING:\n";
        for (const auto& ev : evidence.contradicting) {
            oss << "- " << evidence_type_name(ev.type) << "\n";
        }
    }
    oss << "DECISION:\n";
    oss << (decision == EntryDecision::EntryReady ? "ENTRY_READY" : "NO_TRADE");
    return oss.str();
}

TradeIntent EntryEngine::evaluate(
    const SetupCandidate& setup, const EvidenceReport& evidence,
    const MarketState& state, const RegimeState& regime,
    const BrokerQuote& quote, double spread_cost, std::uint64_t intent_ttl_ms) {
    TradeIntent intent;
    intent.id = intent_ids_.generate();
    intent.setup_id = setup.id;
    intent.instrument = setup.instrument;
    intent.direction = setup.direction;
    intent.created_at = state.timestamp;
    intent.expires_at = Timestamp(intent.created_at.count() +
        static_cast<long long>(intent_ttl_ms) * 1'000'000);
    intent.evidence_report_id = evidence.id;
    intent.market_state_snapshot_id = state.snapshot_id;
    intent.model_version = model_.model_version();

    if (!evidence.is_valid) {
        intent.decision = EntryDecision::NoTrade;
        intent.reason_codes.push_back("NO_VALID_EVIDENCE");
        intent.human_explanation = build_explanation(setup, evidence, regime, intent.decision);
        return intent;
    }

    // Trade on setup sight: Building allowed when confidence is real; Confirmed always ok.
    // Do NOT wait for every confirmation if setup is already actionable.
    const bool setup_ok =
        setup.lifecycle == SetupLifecycle::Confirmed ||
        (setup.lifecycle == SetupLifecycle::Building && setup.confidence >= 0.5);
    if (!setup_ok) {
        intent.decision = EntryDecision::NoTrade;
        intent.reason_codes.push_back("SETUP_NOT_ACTIONABLE");
        intent.human_explanation = build_explanation(setup, evidence, regime, intent.decision);
        return intent;
    }

    if (state.data_quality.stale) {
        intent.decision = EntryDecision::Reject;
        intent.reason_codes.push_back("STALE_DATA");
        intent.human_explanation = build_explanation(setup, evidence, regime, intent.decision);
        return intent;
    }

    if (!quote.valid) {
        intent.decision = EntryDecision::Reject;
        intent.reason_codes.push_back("NO_EXECUTABLE_QUOTE");
        return intent;
    }

    // End-of-move filter — do not chase extremes on ~10s scalp
    const double rp = state.structure.range_position;
    const double vel = state.features.price.velocity;
    if (setup.direction == Direction::Long && rp > 0.88 && vel > 0) {
        intent.decision = EntryDecision::NoTrade;
        intent.reason_codes.push_back("LATE_MOVE_LONG");
        intent.human_explanation = build_explanation(setup, evidence, regime, intent.decision);
        return intent;
    }
    if (setup.direction == Direction::Short && rp < 0.12 && vel < 0) {
        intent.decision = EntryDecision::NoTrade;
        intent.reason_codes.push_back("LATE_MOVE_SHORT");
        intent.human_explanation = build_explanation(setup, evidence, regime, intent.decision);
        return intent;
    }

    intent.reference_price = (quote.bid + quote.ask) / 2.0;
    intent.acceptable_entry_min = quote.bid;
    intent.acceptable_entry_max = quote.ask;
    // Asymmetric R:R for quality setups (need clearer edge than noise)
    intent.expected_favorable_move = state.liquidity.spread * 5.0;
    intent.expected_adverse_move = state.liquidity.spread * 2.0;
    intent.initial_invalidation = intent.reference_price -
        (setup.direction == Direction::Long ? intent.expected_adverse_move
                                            : -intent.expected_adverse_move);

    intent.probability_target_before_invalidation =
        model_.probability_target_before_invalidation(state, setup.direction);

    intent.expected_costs = spread_cost;
    intent.expected_value_before_costs = compute_ev(
        intent.probability_target_before_invalidation,
        intent.expected_favorable_move,
        intent.expected_adverse_move,
        0);
    intent.expected_value_after_costs = compute_ev(
        intent.probability_target_before_invalidation,
        intent.expected_favorable_move,
        intent.expected_adverse_move,
        intent.expected_costs);

    // High-precision gate (~aim for selective real setups; model scale ~0.5–0.95)
    constexpr double kMinProb = 0.72;
    if (intent.expected_value_after_costs > 0 &&
        intent.probability_target_before_invalidation >= kMinProb) {
        intent.decision = EntryDecision::EntryReady;
        intent.reason_codes.push_back("POSITIVE_EV_HIGH_PRECISION");
        if (setup.lifecycle == SetupLifecycle::Building) {
            intent.reason_codes.push_back("SETUP_SIGHT_ENTRY");
        }
    } else {
        intent.decision = EntryDecision::NoTrade;
        intent.reason_codes.push_back("INSUFFICIENT_EDGE");
    }

    intent.human_explanation = build_explanation(setup, evidence, regime, intent.decision);
    return intent;
}

void EntryEngine::reject_stale(std::vector<TradeIntent>& intents, Timestamp now) const {
    for (auto& intent : intents) {
        if (intent.decision == EntryDecision::EntryReady && now > intent.expires_at) {
            intent.decision = EntryDecision::Reject;
            intent.reason_codes.push_back("EXPIRED");
        }
    }
}

}  // namespace mr
