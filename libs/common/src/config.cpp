#include "mr/common/config.hpp"
#include <algorithm>

namespace mr {

void ConfigRegistry::add_instrument(InstrumentConfig cfg) {
    if (cfg.id == kInvalidInstrument) {
        throw ConfigValidationError("instrument id must be non-zero");
    }
    instruments_.push_back(std::move(cfg));
    symbol_index_[instruments_.back().symbol] = instruments_.back().id;
}

void ConfigRegistry::add_feed(FeedConfig cfg) {
    if (cfg.id == kInvalidSource) {
        throw ConfigValidationError("feed id must be non-zero");
    }
    feeds_.push_back(std::move(cfg));
}

const InstrumentConfig& ConfigRegistry::instrument(InstrumentId id) const {
    auto it = std::find_if(instruments_.begin(), instruments_.end(),
        [id](const auto& i) { return i.id == id; });
    if (it == instruments_.end()) {
        throw ConfigValidationError("unknown instrument id");
    }
    return *it;
}

const FeedConfig& ConfigRegistry::feed(SourceId id) const {
    auto it = std::find_if(feeds_.begin(), feeds_.end(),
        [id](const auto& f) { return f.id == id; });
    if (it == feeds_.end()) {
        throw ConfigValidationError("unknown feed id");
    }
    return *it;
}

InstrumentId ConfigRegistry::instrument_by_symbol(const std::string& symbol) const {
    auto it = symbol_index_.find(symbol);
    if (it == symbol_index_.end()) {
        throw ConfigValidationError("unknown instrument symbol: " + symbol);
    }
    return it->second;
}

void ConfigRegistry::validate() const {
    if (instruments_.empty()) {
        throw ConfigValidationError("no instruments configured");
    }
    for (const auto& inst : instruments_) {
        if (inst.symbol.empty()) {
            throw ConfigValidationError("instrument symbol required");
        }
        if (inst.tick_size <= 0.0) {
            throw ConfigValidationError("instrument tick_size must be positive");
        }
    }
    for (const auto& feed : feeds_) {
        if (feed.name.empty()) {
            throw ConfigValidationError("feed name required");
        }
        for (auto inst_id : feed.instruments) {
            (void)instrument(inst_id);
        }
    }
}

}  // namespace mr
