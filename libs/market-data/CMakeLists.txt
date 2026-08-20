add_library(mr_market_data src/provider.cpp)
add_library(mr::market_data ALIAS mr_market_data)

target_include_directories(mr_market_data
    PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)
target_link_libraries(mr_market_data PUBLIC mr::common)
target_compile_features(mr_market_data PUBLIC cxx_std_20)
