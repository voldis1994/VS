add_library(mr_broker_adapters
    src/paper_broker_adapter.cpp
    src/capital_com_adapter.cpp
)
add_library(mr::broker_adapters ALIAS mr_broker_adapters)
target_include_directories(mr_broker_adapters PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)
target_link_libraries(mr_broker_adapters PUBLIC mr::common mr::entry_engine CURL::libcurl nlohmann_json::nlohmann_json OpenSSL::SSL)
target_compile_features(mr_broker_adapters PUBLIC cxx_std_20)
