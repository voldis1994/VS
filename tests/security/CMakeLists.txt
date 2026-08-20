add_executable(test_security test_security.cpp)
target_link_libraries(test_security PRIVATE GTest::gtest GTest::gtest_main)
add_test(NAME test_security COMMAND test_security WORKING_DIRECTORY ${CMAKE_SOURCE_DIR})
