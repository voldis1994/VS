add_executable(bench_pipeline bench_pipeline.cpp)
target_link_libraries(bench_pipeline PRIVATE
    mr::feature_engine mr::market_state mr::regime_engine
    benchmark::benchmark)
add_test(NAME bench_pipeline COMMAND bench_pipeline --benchmark_min_time=0.1)

add_executable(bench_hot_path bench_hot_path.cpp)
target_include_directories(bench_hot_path PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(bench_hot_path PRIVATE
    mr::clock mr::normalization mr::data_quality mr::feed_fusion
    mr::feature_engine mr::market_state mr::regime_engine mr::setup_engine
    mr::evidence_engine mr::entry_engine mr::position_engine mr::exit_engine)
add_test(NAME bench_hot_path COMMAND bench_hot_path)

add_executable(bench_load bench_load.cpp)
target_include_directories(bench_load PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(bench_load PRIVATE mr::market_core_pipeline)
add_test(NAME bench_load COMMAND bench_load)
