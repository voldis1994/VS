add_executable(execution-service src/main.cpp)
target_link_libraries(execution-service PRIVATE
    mr::execution_router
    mr::broker_adapters
    mr::position_engine
    mr::exit_engine
    spdlog::spdlog
)
