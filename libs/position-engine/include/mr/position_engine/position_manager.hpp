#pragma once

#include "mr/entry_engine/entry_engine.hpp"
#include "mr/evidence_engine/evidence_engine.hpp"

namespace mr {

enum class ExitReason : std::uint8_t {
    None = 0,
    ThesisFailure = 1,
    HardInvalidation = 2,
    PeakProtection = 3,
    Target = 4,
    TimeDecay = 5,
    ReversalEvidence = 6,
    EmergencyStop = 7
};

enum class PositionAction : std::uint8_t {
    Hold = 0,
    ExitNow = 1,
    Trail = 2,
    TakeProfit = 3
};

struct PositionState {
    PositionId id{0};
    TradeIntentId intent_id{0};
    SetupId setup_id{0};
    InstrumentId instrument{kInvalidInstrument};
    ClientId client_id{0};
    AccountId account_id{0};
    Direction direction{Direction::Flat};
    double entry_price{0};
    double quantity{0};
    double current_price{0};
    Timestamp opened_at{};
    double mfe{0};
    double mae{0};
    double peak_favorable_price{0};
    double peak_retention{0};
    double remaining_rr{0};
    double current_pnl{0};
    double stop_loss{0};
    double take_profit{0};
    bool trailing_active{false};
    std::uint64_t horizon_ns{10'000'000'000};
};

struct PositionDecision {
    PositionAction action{PositionAction::Hold};
    ExitReason reason{ExitReason::None};
    double ev_exit{0};
    double ev_hold{0};
    double ev_trail{0};
    double ev_take_profit{0};
    double continuation_probability{0};
    double reversal_probability{0};
    std::vector<std::string> reason_codes;
};

class PositionManager {
public:
    PositionState open_position(const TradeIntent& intent, double fill_price,
                                double quantity, ClientId client, AccountId account);
    PositionDecision evaluate(PositionState& position, const MarketState& state,
                              const RegimeState& regime, const EvidenceReport& evidence,
                              const BrokerQuote& quote);
    void update_excursions(PositionState& position, double price);

private:
    IdGenerator position_ids_;
    double compute_remaining_rr(const PositionState& pos) const;
    double compute_pnl(const PositionState& pos, double price) const;
};

}  // namespace mr
