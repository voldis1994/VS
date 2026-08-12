add_library(mr_common
    src/config.cpp
)
add_library(mr::common ALIAS mr_common)

target_include_directories(mr_common
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
)

target_link_libraries(mr_common
    PUBLIC
        fmt::fmt
)

target_compile_features(mr_common PUBLIC cxx_std_20)
