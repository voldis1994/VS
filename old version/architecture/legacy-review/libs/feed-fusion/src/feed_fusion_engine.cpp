#include "mr/feed_fusion/feed_fusion_engine.hpp"
#include <cmath>
#include <numeric>

namespace mr {

double FeedFusionEngine::compute_mid(const NormalizedEvent& event) const {
    if (event.bid && event.ask) {
        return (*event.bid + *event.ask) / 2.0;
    }
    if (event.last) return *event.last;
    return 0.0;
}

void FeedFusionEngine::update_lead_lag(
    InstrumentId instrument, const NormalizedEvent& event, double price_change) {
    auto& state = instruments_[instrument];
    if (std::abs(price_change) > 1e-10) {
        ReactionEvent re;
        re.source = event.source;
        re.timestamp = event.normalized_timestamp;
        re.price_change = price_change;
        state.reaction_sequence.push(re);
    }
}

void FeedFusionEngine::ingest(const NormalizedEvent& event, const SourceHealth& health) {
    auto& inst = instruments_[event.instrument];
    double mid = compute_mid(event);
    double prev_mid = inst.last_mid;
    double price_change = (prev_mid > 0) ? mid - prev_mid : 0.0;

    auto& src = inst.sources[event.source];
    src.last_event = event;
    src.health = health;
    src.last_update = event.normalized_timestamp;
    src.weight = health.reliability * (health.predictive_usefulness + 0.5);

    if (mid > 0) {
        update_lead_lag(event.instrument, event, price_change);
        inst.last_mid = mid;
    }
}

FeedConsensus FeedFusionEngine::consensus(InstrumentId instrument) const {
    FeedConsensus c;
    auto it = instruments_.find(instrument);
    if (it == instruments_.end()) return c;

    double weighted_sum = 0;
    double weight_sum = 0;
    double spread_sum = 0;
    std::uint32_t count = 0;

    for (const auto& [src_id, state] : it->second.sources) {
        if (state.weight <= 0) continue;
        double mid = compute_mid(state.last_event);
        if (mid <= 0) continue;
        weighted_sum += mid * state.weight;
        weight_sum += state.weight;
        if (state.last_event.bid && state.last_event.ask) {
            spread_sum += (*state.last_event.ask - *state.last_event.bid);
        }
        count++;
    }

    if (weight_sum > 0) {
        c.mid_price = weighted_sum / weight_sum;
        c.spread = count > 0 ? spread_sum / count : 0;
        c.confidence = std::min(1.0, weight_sum / static_cast<double>(count));
        c.contributing_sources = count;
    }
    return c;
}

FeedDivergence FeedFusionEngine::divergence(InstrumentId instrument) const {
    FeedDivergence d;
    auto it = instruments_.find(instrument);
    if (it == instruments_.end()) return d;

    auto c = consensus(instrument);
    if (c.mid_price <= 0) return d;

    std::vector<double> divergences;
    SourceId worst_source = kInvalidSource;
    double worst_div = 0;

    for (const auto& [src_id, state] : it->second.sources) {
        double mid = compute_mid(state.last_event);
        if (mid <= 0) continue;
        double div = std::abs(mid - c.mid_price);
        divergences.push_back(div);
        if (div > worst_div) {
            worst_div = div;
            worst_source = src_id;
        }
    }

    if (!divergences.empty()) {
        d.max_divergence = *std::max_element(divergences.begin(), divergences.end());
        d.mean_divergence = std::accumulate(divergences.begin(), divergences.end(), 0.0)
            / divergences.size();
        d.most_divergent_source = worst_source;
    }
    return d;
}

LeadLagState FeedFusionEngine::lead_lag(InstrumentId instrument) const {
    LeadLagState ll;
    auto it = instruments_.find(instrument);
    if (it == instruments_.end() || it->second.reaction_sequence.size() < 2) return ll;

    const auto& seq = it->second.reaction_sequence;
    std::unordered_map<SourceId, std::uint64_t> lead_count;
    std::uint64_t total = 0;

    for (std::size_t i = 1; i < seq.size(); ++i) {
        if (std::abs(seq.at(i).price_change) > 1e-10) {
            lead_count[seq.at(i).source]++;
            total++;
        }
    }

    SourceId best_leader = kInvalidSource;
    std::uint64_t best_count = 0;
    for (const auto& [src, count] : lead_count) {
        if (count > best_count) {
            best_count = count;
            best_leader = src;
        }
    }

    ll.leader = best_leader;
    ll.lead_probability = total > 0 ? static_cast<double>(best_count) / total : 0;
    ll.directional_agreement = ll.lead_probability;
    return ll;
}

std::vector<SourceWeight> FeedFusionEngine::weights(InstrumentId instrument) const {
    std::vector<SourceWeight> result;
    auto it = instruments_.find(instrument);
    if (it == instruments_.end()) return result;

    double total = 0;
    for (const auto& [src_id, state] : it->second.sources) {
        total += state.weight;
    }

    for (const auto& [src_id, state] : it->second.sources) {
        SourceWeight w;
        w.source = src_id;
        w.weight = total > 0 ? state.weight / total : 0;
        result.push_back(w);
    }
    return result;
}

NormalizedEvent FeedFusionEngine::fused_event(InstrumentId instrument) const {
    NormalizedEvent fused;
    fused.instrument = instrument;
    auto c = consensus(instrument);
    if (c.mid_price > 0) {
        fused.bid = c.mid_price - c.spread / 2.0;
        fused.ask = c.mid_price + c.spread / 2.0;
        fused.last = c.mid_price;
    }
    fused.receive_timestamp = now_utc_ns();
    fused.normalized_timestamp = fused.receive_timestamp;
    fused.type = MarketEventType::Quote;
    return fused;
}

}  // namespace mr
