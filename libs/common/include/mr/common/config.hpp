#pragma once

#include "mr/common/types.hpp"
#include <string>
#include <vector>
#include <unordered_map>
#include <stdexcept>

namespace mr {

struct InstrumentConfig {
    InstrumentId id{kInvalidInstrument};
    std::string symbol;
    std::string display_name;
    double tick_size{0.00001};
    double lot_step{0.01};
    double min_lot{0.01};
    double max_lot{100.0};
    bool enabled{true};
};

struct FeedConfig {
    SourceId id{kInvalidSource};
    std::string name;
    std::string provider;
    std::string connection_type;
    std::vector<InstrumentId> instruments;
    double stale_threshold_ms{500.0};
    double max_spread_ticks{50.0};
    bool enabled{true};
};

struct ConfigValidationError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

class ConfigRegistry {
public:
    void add_instrument(InstrumentConfig cfg);
    void add_feed(FeedConfig cfg);
    const InstrumentConfig& instrument(InstrumentId id) const;
    const FeedConfig& feed(SourceId id) const;
    const std::vector<InstrumentConfig>& instruments() const { return instruments_; }
    const std::vector<FeedConfig>& feeds() const { return feeds_; }
    InstrumentId instrument_by_symbol(const std::string& symbol) const;
    void validate() const;

private:
    std::vector<InstrumentConfig> instruments_;
    std::vector<FeedConfig> feeds_;
    std::unordered_map<std::string, InstrumentId> symbol_index_;
};

}  // namespace mr
