#include "mr/position_engine/position_manager.hpp"

namespace mr {

PositionState PositionManager::open_position(
    const TradeIntent& intent, double fill_price, double quantity,
    ClientId client, AccountId account) {
    PositionState pos;
    pos.id = position_ids_.generate();
    pos.intent_id = intent.id;
    pos.setup_id = intent.setup_id;
    pos.instrument = intent.instrument;
    pos.client_id = client;
    pos.account_id = account;
    pos.direction = intent.direction;
    pos.entry_price = fill_price;
    pos.quantity = quantity;
    pos.current_price = fill_price;
    pos.opened_at = intent.created_at;
    pos.peak_favorable_price = fill_price;
    pos.stop_loss = intent.initial_invalidation;
    pos.take_profit = fill_price +
        (intent.direction == Direction::Long ? intent.expected_favorable_move
                                             : -intent.expected_favorable_move);
    return pos;
}

double PositionManager::compute_pnl(const PositionState& pos, double price) const {
    if (pos.direction == Direction::Long) {
        return (price - pos.entry_price) * pos.quantity;
    }
    return (pos.entry_price - price) * pos.quantity;
}

double PositionManager::compute_remaining_rr(const PositionState& pos) const {
    double remaining_favorable = std::abs(pos.take_profit - pos.current_price);
    double remaining_adverse = std::abs(pos.current_price - pos.stop_loss);
    if (remaining_adverse < 1e-10) return 0;
    return remaining_favorable / remaining_adverse;
}

void PositionManager::update_excursions(PositionState& position, double price) {
    position.current_price = price;
    position.current_pnl = compute_pnl(position, price);

    if (position.direction == Direction::Long) {
        double favorable = price - position.entry_price;
        double adverse = position.entry_price - price;
        if (favorable > position.mfe) {
            position.mfe = favorable;
            position.peak_favorable_price = price;
        }
        if (adverse > position.mae) position.mae = adverse;
    } else {
        double favorable = position.entry_price - price;
        double adverse = price - position.entry_price;
        if (favorable > position.mfe) {
            position.mfe = favorable;
            position.peak_favorable_price = price;
        }
        if (adverse > position.mae) position.mae = adverse;
    }

    if (position.mfe > 0) {
        double current_favorable = position.direction == Direction::Long
            ? price - position.entry_price
            : position.entry_price - price;
        position.peak_retention = current_favorable / position.mfe;
    }
    position.remaining_rr = compute_remaining_rr(position);
}

PositionDecision PositionManager::evaluate(
    PositionState& position, const MarketState& state,
    const RegimeState& regime, const EvidenceReport& evidence,
    const BrokerQuote& /*quote*/) {
    update_excursions(position, state.features.price.displacement > 0
        ? position.current_price : position.current_price);

    if (state.features.price.velocity != 0) {
        double mid = position.current_price + state.features.price.return_value;
        update_excursions(position, mid);
    }

    PositionDecision decision;
    auto elapsed = state.timestamp.count() - position.opened_at.count();
    double remaining_horizon = static_cast<double>(position.horizon_ns - elapsed) / 1e9;

    decision.continuation_probability = regime.confidence;
    decision.reversal_probability = 1.0 - regime.confidence;

    decision.ev_hold = position.current_pnl;
    decision.ev_exit = position.current_pnl;
    decision.ev_trail = position.mfe * 0.8;
    decision.ev_take_profit = position.current_pnl;

  if (position.direction == Direction::Long && state.features.price.velocity < -0.0001 &&
        regime.current == Regime::TrendDown) {
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::ThesisFailure;
        decision.reason_codes.push_back("THESIS_FAILURE");
        return decision;
    }
    if (position.direction == Direction::Short && state.features.price.velocity > 0.0001 &&
        regime.current == Regime::TrendUp) {
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::ThesisFailure;
        decision.reason_codes.push_back("THESIS_FAILURE");
        return decision;
    }

    if (position.direction == Direction::Long && position.current_price <= position.stop_loss) {
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::HardInvalidation;
        decision.reason_codes.push_back("HARD_INVALIDATION");
        return decision;
    }
    if (position.direction == Direction::Short && position.current_price >= position.stop_loss) {
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::HardInvalidation;
        decision.reason_codes.push_back("HARD_INVALIDATION");
        return decision;
    }

    if (position.peak_retention < 0.5 && position.mfe > 0) {
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::PeakProtection;
        decision.reason_codes.push_back("PEAK_PROTECTION");
        return decision;
    }

    if (position.direction == Direction::Long && position.current_price >= position.take_profit) {
        decision.action = PositionAction::TakeProfit;
        decision.reason = ExitReason::Target;
        decision.reason_codes.push_back("TARGET");
        return decision;
    }
    if (position.direction == Direction::Short && position.current_price <= position.take_profit) {
        decision.action = PositionAction::TakeProfit;
        decision.reason = ExitReason::Target;
        decision.reason_codes.push_back("TARGET");
        return decision;
    }

    if (remaining_horizon < 1.0 && std::abs(position.current_pnl) < position.mfe * 0.1) {
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::TimeDecay;
        decision.reason_codes.push_back("TIME_DECAY");
        return decision;
    }

    if (!evidence.contradicting.empty() && evidence.evidence_strength < 0) {
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::ReversalEvidence;
        decision.reason_codes.push_back("REVERSAL_EVIDENCE");
        return decision;
    }

    if (position.remaining_rr < 0.5 && position.mfe > 0) {
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::Target;
        decision.reason_codes.push_back("REMAINING_RR_LOW");
        return decision;
    }

    decision.action = PositionAction::Hold;
    return decision;
}

}  // namespace mr
