#pragma once

#include "mr/setup_engine/setup_engine.hpp"
#include "mr/market_state/market_state_engine.hpp"
#include <deque>

namespace mr {

enum class EvidenceType : std::uint8_t {
  SellingDeceleration = 0,
    BuyingDeceleration = 1,
    Absorption = 2,
    BuyResponse = 3,
    SellResponse = 4,
    Acceptance = 5,
    Rejection = 6,
    ContinuationPressure = 7,
    ReversalPressure = 8,
    MultiFeedConfirmation = 9,
    ReferenceStabilization = 10,
    SpreadWidening = 12,
    StaleFeed = 13
};

inline const char* evidence_type_name(EvidenceType t) {
    switch (t) {
        case EvidenceType::SellingDeceleration: return "SELLING_DECELERATION";
        case EvidenceType::BuyingDeceleration: return "BUYING_DECELERATION";
        case EvidenceType::Absorption: return "ABSORPTION";
        case EvidenceType::BuyResponse: return "BUY_RESPONSE";
        case EvidenceType::SellResponse: return "SELL_RESPONSE";
        case EvidenceType::Acceptance: return "ACCEPTANCE";
        case EvidenceType::Rejection: return "REJECTION";
        case EvidenceType::ContinuationPressure: return "CONTINUATION_PRESSURE";
        case EvidenceType::ReversalPressure: return "REVERSAL_PRESSURE";
        case EvidenceType::MultiFeedConfirmation: return "MULTI_FEED_CONFIRMATION";
        case EvidenceType::ReferenceStabilization: return "REFERENCE_STABILIZATION";
        case EvidenceType::SpreadWidening: return "SPREAD_WIDENING";
        case EvidenceType::StaleFeed: return "STALE_FEED";
    }
    return "UNKNOWN";
}

struct EvidenceEvent {
    EvidenceType type;
    Timestamp timestamp{};
    double strength{0};
    Direction direction{Direction::Flat};
};

struct EvidenceSequence {
    SetupId setup_id{0};
    std::deque<EvidenceEvent> events;
    double sequence_quality{0};
};

struct EvidenceReport {
    EvidenceReportId id{0};
    SetupId setup_id{0};
    std::vector<EvidenceEvent> supporting;
    std::vector<EvidenceEvent> contradicting;
    double evidence_strength{0};
    double evidence_age_ms{0};
    double sequence_quality{0};
    double feed_quality{0};
    SnapshotId market_state_snapshot_id{0};
    Regime regime{Regime::Unknown};
    std::vector<std::string> invalidation_reasons;
    bool is_valid{false};
};

class EvidenceEngine {
public:
    explicit EvidenceEngine(IdGenerator& report_ids);
    void observe(SetupId setup_id, const MarketState& state,
                 const RegimeState& regime, const SetupCandidate& setup);
    [[nodiscard]] EvidenceReport evaluate(SetupId setup_id, const SetupCandidate& setup,
                                          const MarketState& state);
    [[nodiscard]] EvidenceSequence sequence(SetupId setup_id) const;

private:
    IdGenerator& report_ids_;
    std::unordered_map<SetupId, EvidenceSequence> sequences_;
    void detect_evidence(SetupId setup_id, const MarketState& state,
                         const SetupCandidate& setup);
};

}  // namespace mr
