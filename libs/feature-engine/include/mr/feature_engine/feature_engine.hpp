#pragma once

#include "mr/common/types.hpp"
#include "mr/common/ring_buffer.hpp"
#include "mr/common/market_event.hpp"
#include <array>
#include <cmath>

namespace mr {

enum class LogWindow : std::uint32_t {
    Ms10 = 10,
    Ms25 = 25,
    Ms50 = 50,
    Ms100 = 100,
    Ms250 = 250,
    Ms500 = 500,
    S1 = 1000,
    S2 = 2000,
    S5 = 5000,
    S10 = 10000,
    S30 = 30000,
    S60 = 60000
};

struct PriceDynamicsFeatures {
    double return_value{0};
    double normalized_return{0};
    double velocity{0};
    double acceleration{0};
    double acceleration_change{0};
    double directional_persistence{0};
    double displacement{0};
    double mfe_excursion{0};
    double mae_excursion{0};
    double short_horizon_momentum{0};
    double mean_reversion_pressure{0};
};

struct VolatilityFeatures {
    double realized_volatility{0};
    double volatility_acceleration{0};
    double compression{0};
    double expansion{0};
    double volatility_regime{0};
    double volatility_transition{0};
};

struct MicrostructureFeatures {
    double spread{0};
    double spread_velocity{0};
    double microprice{0};
    double bid_ask_imbalance{0};
    double order_flow_imbalance{0};
    double aggressive_buy_pressure{0};
    double aggressive_sell_pressure{0};
    double trade_intensity{0};
    double quote_intensity{0};
    double absorption_proxy{0};
    double exhaustion_proxy{0};
    double liquidity_withdrawal{0};
    double liquidity_replenishment{0};
};

struct StructureFeatures {
    double swing_state{0};
    double range_width{0};
    double range_boundary_distance{0};
    double breakout_strength{0};
    double failed_breakout{0};
    double acceptance{0};
    double rejection{0};
    double pullback_depth{0};
    double continuation_pressure{0};
    double compression{0};
    double expansion{0};
    double reversal_candidate{0};
};

struct MultiFeedFeatures {
    double consensus{0};
    double disagreement{0};
    double divergence{0};
    double lead_lag{0};
    double reaction_sequence_quality{0};
    double reference_market_pressure{0};
    double broker_reference_discrepancy{0};
};

struct FeatureSnapshot {
    PriceDynamicsFeatures price;
    VolatilityFeatures volatility;
    MicrostructureFeatures microstructure;
    StructureFeatures structure;
    MultiFeedFeatures multi_feed;
    Timestamp timestamp{};
};

struct WindowSample {
    Timestamp timestamp{};
    double price{0};
    double spread{0};
    double trade_size{0};
    bool is_trade{false};
};

class FeatureEngine {
public:
    static constexpr std::size_t kMaxWindowSamples = 4096;

    void update(const NormalizedEvent& event, double consensus_mid,
                double feed_divergence, double lead_lag_prob);
    [[nodiscard]] FeatureSnapshot snapshot() const;
    [[nodiscard]] double rolling_return(LogWindow window) const;
    void reset();

private:
    RingBuffer<WindowSample, kMaxWindowSamples> samples_;
    FeatureSnapshot current_;
    double prev_price_{0};
    double prev_velocity_{0};
    double prev_volatility_{0};
    double session_high_{0};
    double session_low_{0};
    std::uint64_t trade_count_{0};
    std::uint64_t quote_count_{0};

    void update_price_dynamics(double price, Timestamp ts);
    void update_volatility();
    void update_microstructure(const NormalizedEvent& event);
    void update_structure(double price);
    void update_multi_feed(double consensus, double divergence, double lead_lag);
    [[nodiscard]] std::vector<double> prices_in_window(std::uint64_t window_ms) const;
};

}  // namespace mr
