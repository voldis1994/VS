add_library(mr_market_core_pipeline src/pipeline.cpp)
add_library(mr::market_core_pipeline ALIAS mr_market_core_pipeline)
target_include_directories(mr_market_core_pipeline
    PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)
target_link_libraries(mr_market_core_pipeline PUBLIC
    mr::common mr::clock mr::normalization mr::data_quality mr::feed_fusion
    mr::feature_engine mr::market_state mr::regime_engine mr::setup_engine
    mr::evidence_engine mr::entry_engine mr::telemetry mr::storage
)

add_executable(market-core src/main.cpp)
target_include_directories(market-core PRIVATE include)
target_link_libraries(market-core PRIVATE
    mr::market_core_pipeline mr::market_data mr::replay spdlog::spdlog
)
