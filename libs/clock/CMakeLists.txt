add_library(mr_clock src/clock_engine.cpp)
add_library(mr::clock ALIAS mr_clock)

target_include_directories(mr_clock
    PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)
target_link_libraries(mr_clock PUBLIC mr::common)
target_compile_features(mr_clock PUBLIC cxx_std_20)
