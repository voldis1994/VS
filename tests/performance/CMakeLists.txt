add_executable(bench_pipeline bench_pipeline.cpp)
target_link_libraries(bench_pipeline PRIVATE
    mr::feature_engine mr::market_state mr::regime_engine
    benchmark::benchmark)
add_test(NAME bench_pipeline COMMAND bench_pipeline --benchmark_min_time=0.1)
