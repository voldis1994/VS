add_executable(test_execution test_execution.cpp)
target_link_libraries(test_execution PRIVATE
    mr::execution_router mr::broker_adapters GTest::gtest GTest::gtest_main)
add_test(NAME test_execution COMMAND test_execution)
