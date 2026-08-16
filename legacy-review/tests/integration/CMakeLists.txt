add_executable(test_pipeline_integration test_pipeline_integration.cpp)
target_link_libraries(test_pipeline_integration PRIVATE
    mr::market_core_pipeline mr::market_data
    GTest::gtest GTest::gtest_main)
add_test(NAME test_pipeline_integration COMMAND test_pipeline_integration)

add_executable(test_multi_feed test_multi_feed.cpp)
target_link_libraries(test_multi_feed PRIVATE
    mr::feed_fusion mr::data_quality mr::normalization mr::clock
    GTest::gtest GTest::gtest_main)
add_test(NAME test_multi_feed COMMAND test_multi_feed)
