#include <gtest/gtest.h>
#include "mr/common/config.hpp"

TEST(ConfigRegistry, ValidatesInstruments) {
    mr::ConfigRegistry config;
    mr::InstrumentConfig inst;
    inst.id = 1;
    inst.symbol = "EURUSD";
    inst.tick_size = 0.00001;
    config.add_instrument(inst);
    EXPECT_NO_THROW(config.validate());
}

TEST(ConfigRegistry, RejectsEmptyInstruments) {
    mr::ConfigRegistry config;
    EXPECT_THROW(config.validate(), mr::ConfigValidationError);
}

TEST(ConfigRegistry, LookupBySymbol) {
    mr::ConfigRegistry config;
    mr::InstrumentConfig inst;
    inst.id = 1;
    inst.symbol = "EURUSD";
    inst.tick_size = 0.00001;
    config.add_instrument(inst);
    EXPECT_EQ(config.instrument_by_symbol("EURUSD"), 1u);
}
