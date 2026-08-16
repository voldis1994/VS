#pragma once

#include "mr/regime_engine/regime_engine.hpp"
#include "mr/market_state/market_state_engine.hpp"

namespace mr {

enum class SetupLifecycle : std::uint8_t {
    Discovered = 0,
    Building = 1,
    Confirmed = 2,
    Invalidated = 3,
    Expired = 4,
    Triggered = 5
};

struct SetupCandidate {
    SetupId id{0};
    InstrumentId instrument{kInvalidInstrument};
    Direction direction{Direction::Flat};
    Regime regime{Regime::Unknown};
    SetupLifecycle lifecycle{SetupLifecycle::Discovered};
    Timestamp created_at{};
    Timestamp expiry{};
    SnapshotId supporting_snapshot_id{0};
    SnapshotId contradicting_snapshot_id{0};
    std::string setup_type;
    double confidence{0};
};

class SetupEngine {
public:
    explicit SetupEngine(IdGenerator& setup_ids);
    std::vector<SetupCandidate> update(InstrumentId instrument,
                                       const MarketState& state,
                                       const RegimeState& regime);
    [[nodiscard]] std::vector<SetupCandidate> active_setups(InstrumentId instrument) const;
    void invalidate(SetupId id, const std::string& reason);

private:
    IdGenerator& setup_ids_;
    std::unordered_map<InstrumentId, std::vector<SetupCandidate>> setups_;
    std::uint64_t horizon_ns_{10'000'000'000};

    bool detect_continuation_setup(const MarketState& state, const RegimeState& regime,
                                   SetupCandidate& setup) const;
    bool detect_pullback_setup(const MarketState& state, const RegimeState& regime,
                               SetupCandidate& setup) const;
    void expire_stale(Timestamp now);
};

}  // namespace mr
