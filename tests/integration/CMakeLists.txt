add_executable(test_pipeline_integration test_pipeline_integration.cpp)
target_link_libraries(test_pipeline_integration PRIVATE
    mr::market_core_pipeline mr::market_data
    GTest::gtest GTest::gtest_main)
add_test(NAME test_pipeline_integration COMMAND test_pipeline_integration)
