#include "mr/feature_engine/feature_engine.hpp"
#include <numeric>
#include <algorithm>

namespace mr {

std::vector<double> FeatureEngine::prices_in_window(std::uint64_t window_ms) const {
    std::vector<double> prices;
    if (samples_.empty()) return prices;
    auto newest_ts = samples_.newest().timestamp;
    for (std::size_t i = 0; i < samples_.size(); ++i) {
        auto& s = samples_.at(i);
        auto age_ms = static_cast<std::uint64_t>(
            (newest_ts - s.timestamp).count() / 1000000);
        if (age_ms <= window_ms) {
            prices.push_back(s.price);
        }
    }
    return prices;
}

void FeatureEngine::update_price_dynamics(double price, Timestamp ts) {
    (void)ts;
    if (prev_price_ > 0) {
        current_.price.return_value = price - prev_price_;
        current_.price.normalized_return = current_.price.return_value / prev_price_;
        double velocity = current_.price.return_value;
        current_.price.velocity = velocity;
        current_.price.acceleration = velocity - prev_velocity_;
        current_.price.acceleration_change = current_.price.acceleration;
        prev_velocity_ = velocity;

        if (current_.price.return_value > 0) {
            current_.price.directional_persistence =
                current_.price.directional_persistence * 0.9 + 1.0;
        } else if (current_.price.return_value < 0) {
            current_.price.directional_persistence =
                current_.price.directional_persistence * 0.9 - 1.0;
        } else {
            current_.price.directional_persistence *= 0.9;
        }
    }
    prev_price_ = price;
    current_.price.displacement = (session_high_ > session_low_)
        ? (price - session_low_) / (session_high_ - session_low_) : 0.5;

    auto prices_1s = prices_in_window(1000);
    if (prices_1s.size() >= 2) {
        current_.price.short_horizon_momentum =
            prices_1s.back() - prices_1s.front();
    }
}

void FeatureEngine::update_volatility() {
    auto prices = prices_in_window(5000);
    if (prices.size() < 3) return;

    std::vector<double> returns;
    for (std::size_t i = 1; i < prices.size(); ++i) {
        if (prices[i - 1] > 0) {
            returns.push_back((prices[i] - prices[i - 1]) / prices[i - 1]);
        }
    }
    if (returns.empty()) return;

    double mean = std::accumulate(returns.begin(), returns.end(), 0.0) / returns.size();
    double sq_sum = 0;
    for (double r : returns) sq_sum += (r - mean) * (r - mean);
    double vol = std::sqrt(sq_sum / returns.size());
    current_.volatility.volatility_acceleration = vol - prev_volatility_;
    prev_volatility_ = vol;
    current_.volatility.realized_volatility = vol;
    current_.volatility.expansion = vol > prev_volatility_ ? vol - prev_volatility_ : 0;
    current_.volatility.compression = vol < prev_volatility_ ? prev_volatility_ - vol : 0;
}

void FeatureEngine::update_microstructure(const NormalizedEvent& event) {
    if (event.bid && event.ask) {
        current_.microstructure.spread = *event.ask - *event.bid;
        double bid_sz = event.bid_size.value_or(1.0);
        double ask_sz = event.ask_size.value_or(1.0);
        current_.microstructure.microprice =
            (*event.bid * ask_sz + *event.ask * bid_sz) / (bid_sz + ask_sz);
        current_.microstructure.bid_ask_imbalance =
            (bid_sz - ask_sz) / (bid_sz + ask_sz);
    }
    if (event.type == MarketEventType::Trade) {
        trade_count_++;
        if (event.trade_size && event.last && event.bid && event.ask) {
            double mid = (*event.bid + *event.ask) / 2.0;
            if (*event.last >= mid) {
                current_.microstructure.aggressive_buy_pressure += *event.trade_size;
            } else {
                current_.microstructure.aggressive_sell_pressure += *event.trade_size;
            }
        }
    } else {
        quote_count_++;
    }
    auto total = trade_count_ + quote_count_;
    if (total > 0) {
        current_.microstructure.trade_intensity =
            static_cast<double>(trade_count_) / total;
        current_.microstructure.quote_intensity =
            static_cast<double>(quote_count_) / total;
    }
}

void FeatureEngine::update_structure(double price) {
    if (session_high_ == 0 || price > session_high_) session_high_ = price;
    if (session_low_ == 0 || price < session_low_) session_low_ = price;
    current_.structure.range_width = session_high_ - session_low_;
    current_.structure.range_boundary_distance =
        std::min(price - session_low_, session_high_ - price);
    current_.structure.compression = current_.volatility.compression;
    current_.structure.expansion = current_.volatility.expansion;
}

void FeatureEngine::update_multi_feed(double consensus, double divergence, double lead_lag) {
    current_.multi_feed.consensus = consensus;
    current_.multi_feed.divergence = divergence;
    current_.multi_feed.lead_lag = lead_lag;
    current_.multi_feed.disagreement = divergence;
}

void FeatureEngine::update(const NormalizedEvent& event, double consensus_mid,
                           double feed_divergence, double lead_lag_prob) {
    double price = consensus_mid;
    if (price <= 0) {
        if (event.last) price = *event.last;
        else if (event.bid && event.ask) price = (*event.bid + *event.ask) / 2.0;
    }
    if (price <= 0) return;

    WindowSample sample;
    sample.timestamp = event.normalized_timestamp;
    sample.price = price;
    sample.is_trade = event.type == MarketEventType::Trade;
    if (event.bid && event.ask) sample.spread = *event.ask - *event.bid;
    if (event.trade_size) sample.trade_size = *event.trade_size;
    samples_.push(sample);

    current_.timestamp = event.normalized_timestamp;
    update_price_dynamics(price, event.normalized_timestamp);
    update_volatility();
    update_microstructure(event);
    update_structure(price);
    update_multi_feed(consensus_mid, feed_divergence, lead_lag_prob);
}

FeatureSnapshot FeatureEngine::snapshot() const {
    return current_;
}

double FeatureEngine::rolling_return(LogWindow window) const {
    auto prices = prices_in_window(static_cast<std::uint64_t>(window));
    if (prices.size() < 2) return 0;
    return prices.back() - prices.front();
}

void FeatureEngine::reset() {
    samples_.clear();
    current_ = {};
    prev_price_ = 0;
    prev_velocity_ = 0;
    prev_volatility_ = 0;
    session_high_ = 0;
    session_low_ = 0;
    trade_count_ = 0;
    quote_count_ = 0;
}

}  // namespace mr
