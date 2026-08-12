add_executable(test_common test_common.cpp)
target_link_libraries(test_common PRIVATE mr::common GTest::gtest GTest::gtest_main)
add_test(NAME test_common COMMAND test_common)

add_executable(test_ring_buffer test_ring_buffer.cpp)
target_link_libraries(test_ring_buffer PRIVATE mr::common GTest::gtest GTest::gtest_main)
add_test(NAME test_ring_buffer COMMAND test_ring_buffer)

add_executable(test_clock test_clock.cpp)
target_link_libraries(test_clock PRIVATE mr::clock GTest::gtest GTest::gtest_main)
add_test(NAME test_clock COMMAND test_clock)

add_executable(test_entry_quality test_entry_quality.cpp)
target_link_libraries(test_entry_quality PRIVATE
    mr::entry_engine mr::evidence_engine mr::setup_engine
    GTest::gtest GTest::gtest_main)
add_test(NAME test_entry_quality COMMAND test_entry_quality)

add_executable(test_exit_quality test_exit_quality.cpp)
target_link_libraries(test_exit_quality PRIVATE
    mr::exit_engine mr::position_engine
    GTest::gtest GTest::gtest_main)
add_test(NAME test_exit_quality COMMAND test_exit_quality)

add_executable(test_entry_hot_path test_entry_hot_path.cpp)
target_link_libraries(test_entry_hot_path PRIVATE
    mr::entry_engine mr::evidence_engine mr::setup_engine
    mr::market_state mr::regime_engine mr::feature_engine mr::data_quality
    GTest::gtest GTest::gtest_main)
add_test(NAME test_entry_hot_path COMMAND test_entry_hot_path)

add_executable(test_exit_hot_path test_exit_hot_path.cpp)
target_link_libraries(test_exit_hot_path PRIVATE
    mr::exit_engine mr::position_engine
    GTest::gtest GTest::gtest_main)
add_test(NAME test_exit_hot_path COMMAND test_exit_hot_path)
