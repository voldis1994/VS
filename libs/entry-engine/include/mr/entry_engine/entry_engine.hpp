#pragma once

#include "mr/evidence_engine/evidence_engine.hpp"
#include "mr/setup_engine/setup_engine.hpp"
#include <string>
#include <vector>

namespace mr {

struct IProbabilityModel {
    virtual ~IProbabilityModel() = default;
    virtual double probability_target_before_invalidation(
        const MarketState& state, Direction direction) const = 0;
    virtual std::string model_version() const = 0;
};

struct BaselineProbabilityModel : IProbabilityModel {
    double probability_target_before_invalidation(
        const MarketState& state, Direction direction) const override;
    std::string model_version() const override { return "baseline-v1"; }
};

enum class EntryDecision : std::uint8_t {
    NoTrade = 0,
    EntryReady = 1,
    Reject = 2
};

struct TradeIntent {
    TradeIntentId id{0};
    SetupId setup_id{0};
    InstrumentId instrument{kInvalidInstrument};
    Direction direction{Direction::Flat};
    Timestamp created_at{};
    Timestamp expires_at{};
    double reference_price{0};
    double acceptable_entry_min{0};
    double acceptable_entry_max{0};
    double expected_favorable_move{0};
    double expected_adverse_move{0};
    double initial_invalidation{0};
    double probability_target_before_invalidation{0};
    double expected_value_before_costs{0};
    double expected_costs{0};
    double expected_value_after_costs{0};
    EvidenceReportId evidence_report_id{0};
    SnapshotId market_state_snapshot_id{0};
    EntryDecision decision{EntryDecision::NoTrade};
    std::vector<std::string> reason_codes;
    std::string human_explanation;
    std::string model_version;
    std::string setup_type;
    std::string regime;
};

struct BrokerQuote {
    double bid{0};
    double ask{0};
    Timestamp timestamp{};
    bool valid{false};
};

class EntryEngine {
public:
    EntryEngine(IdGenerator& intent_ids, const IProbabilityModel& model);
    TradeIntent evaluate(const SetupCandidate& setup, const EvidenceReport& evidence,
                         const MarketState& state, const RegimeState& regime,
                         const BrokerQuote& quote, double spread_cost,
                         std::uint64_t intent_ttl_ms = 2000);
    void reject_stale(std::vector<TradeIntent>& intents, Timestamp now) const;

private:
    IdGenerator& intent_ids_;
    const IProbabilityModel& model_;
    double compute_ev(double prob_win, double expected_win,
                      double expected_loss, double costs) const;
    std::string build_explanation(const SetupCandidate& setup,
                                  const EvidenceReport& evidence,
                                  const RegimeState& regime,
                                  EntryDecision decision) const;
};

}  // namespace mr
