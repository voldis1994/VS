message(STATUS "Resolving dependencies...")

find_package(fmt REQUIRED)
find_package(spdlog REQUIRED)
find_package(yaml-cpp REQUIRED)
find_package(nlohmann_json REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(CURL REQUIRED)
find_package(ZLIB REQUIRED)

if(NOT TARGET fmt::fmt)
  add_library(fmt::fmt INTERFACE IMPORTED)
  set_target_properties(fmt::fmt PROPERTIES
    INTERFACE_INCLUDE_DIRECTORIES "${fmt_INCLUDE_DIRS}"
    INTERFACE_LINK_LIBRARIES "${fmt_LIBRARIES}")
endif()

if(NOT TARGET spdlog::spdlog)
  add_library(spdlog::spdlog INTERFACE IMPORTED)
  set_target_properties(spdlog::spdlog PROPERTIES
    INTERFACE_INCLUDE_DIRECTORIES "${spdlog_INCLUDE_DIRS}"
    INTERFACE_LINK_LIBRARIES "spdlog::spdlog")
  if(TARGET spdlog::spdlog_header_only)
    set_property(TARGET spdlog::spdlog PROPERTY INTERFACE_LINK_LIBRARIES spdlog::spdlog_header_only)
  endif()
endif()

if(NOT TARGET nlohmann_json::nlohmann_json)
  add_library(nlohmann_json::nlohmann_json INTERFACE IMPORTED)
  set_target_properties(nlohmann_json::nlohmann_json PROPERTIES
    INTERFACE_INCLUDE_DIRECTORIES "/usr/include")
endif()

if(MR_BUILD_TESTS)
  find_package(GTest)
  if(NOT GTest_FOUND)
    find_library(GTEST_LIB gtest)
    find_library(GTEST_MAIN_LIB gtest_main)
    find_path(GTEST_INCLUDE gtest/gtest.h)
    add_library(GTest::gtest UNKNOWN IMPORTED)
    add_library(GTest::gtest_main UNKNOWN IMPORTED)
    set_target_properties(GTest::gtest PROPERTIES
      IMPORTED_LOCATION "${GTEST_LIB}"
      INTERFACE_INCLUDE_DIRECTORIES "${GTEST_INCLUDE}")
    set_target_properties(GTest::gtest_main PROPERTIES
      IMPORTED_LOCATION "${GTEST_MAIN_LIB}"
      INTERFACE_LINK_LIBRARIES GTest::gtest)
  endif()
  enable_testing()
endif()

if(MR_BUILD_BENCHMARKS)
  find_package(benchmark CONFIG QUIET)
  if(NOT benchmark_FOUND)
    find_package(benchmark QUIET)
  endif()
  if(NOT benchmark_FOUND)
    find_library(BENCHMARK_LIB benchmark)
    find_path(BENCHMARK_INCLUDE benchmark/benchmark.h)
    if(BENCHMARK_LIB AND BENCHMARK_INCLUDE)
      add_library(benchmark::benchmark UNKNOWN IMPORTED)
      set_target_properties(benchmark::benchmark PROPERTIES
        IMPORTED_LOCATION "${BENCHMARK_LIB}"
        INTERFACE_INCLUDE_DIRECTORIES "${BENCHMARK_INCLUDE}")
      set(benchmark_FOUND TRUE)
    endif()
  endif()
  if(NOT benchmark_FOUND AND NOT TARGET benchmark::benchmark)
    message(WARNING "Google Benchmark not found; disabling MR_BUILD_BENCHMARKS (core app does not need it).")
    set(MR_BUILD_BENCHMARKS OFF CACHE BOOL "Build benchmarks" FORCE)
  endif()
endif()
