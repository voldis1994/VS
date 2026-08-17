#include "mr/exit_engine/exit_engine.hpp"

namespace mr {

PositionDecision ExitEngine::decide(
    const PositionState& position, const MarketState& state,
    const RegimeState& regime, const EvidenceReport& evidence,
    double continuation_prob, double reversal_prob) {
    PositionDecision decision;
    decision.continuation_probability = continuation_prob;
    decision.reversal_probability = reversal_prob;

    double favorable_remaining = std::abs(position.take_profit - position.current_price);
    double adverse_remaining = std::abs(position.current_price - position.stop_loss);

    decision.ev_exit = position.current_pnl;
    decision.ev_hold = position.current_pnl +
        continuation_prob * favorable_remaining -
        reversal_prob * adverse_remaining;
    decision.ev_trail = position.mfe * position.peak_retention;
    decision.ev_take_profit = position.current_pnl;

    double best_ev = decision.ev_hold;
    decision.action = PositionAction::Hold;

    if (decision.ev_exit > best_ev) {
        best_ev = decision.ev_exit;
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::Target;
    }
    if (decision.ev_trail > best_ev && position.mfe > 0) {
        best_ev = decision.ev_trail;
        decision.action = PositionAction::Trail;
    }
    if (decision.ev_take_profit > best_ev) {
        decision.action = PositionAction::TakeProfit;
        decision.reason = ExitReason::Target;
    }

    if (state.data_quality.stale) {
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::EmergencyStop;
        decision.reason_codes.push_back("STALE_FEED");
    }

    if (!evidence.contradicting.empty() && reversal_prob > 0.7) {
        decision.action = PositionAction::ExitNow;
        decision.reason = ExitReason::ReversalEvidence;
    }

    return decision;
}

}  // namespace mr
