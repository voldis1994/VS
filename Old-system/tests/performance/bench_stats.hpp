#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <string>
#include <vector>
#include <iostream>
#include <iomanip>

namespace mr::bench {

struct StageStats {
    std::string name;
    double mean_ns{0};
    double p50_ns{0};
    double p90_ns{0};
    double p95_ns{0};
    double p99_ns{0};
    double max_ns{0};
    double min_ns{0};
    std::uint64_t count{0};
    double events_per_sec{0};

    [[nodiscard]] double mean_us() const { return mean_ns / 1000.0; }
    [[nodiscard]] double p50_us() const { return p50_ns / 1000.0; }
    [[nodiscard]] double p90_us() const { return p90_ns / 1000.0; }
    [[nodiscard]] double p95_us() const { return p95_ns / 1000.0; }
    [[nodiscard]] double p99_us() const { return p99_ns / 1000.0; }
    [[nodiscard]] double max_us() const { return max_ns / 1000.0; }
    [[nodiscard]] double mean_ms() const { return mean_ns / 1e6; }
    [[nodiscard]] double p50_ms() const { return p50_ns / 1e6; }
    [[nodiscard]] double p99_ms() const { return p99_ns / 1e6; }
    [[nodiscard]] double max_ms() const { return max_ns / 1e6; }
};

inline StageStats compute_stage_stats(const std::string& name, std::vector<double> samples) {
    StageStats s;
    s.name = name;
    s.count = samples.size();
    if (samples.empty()) return s;
    std::sort(samples.begin(), samples.end());
    s.min_ns = samples.front();
    s.max_ns = samples.back();
    s.mean_ns = std::accumulate(samples.begin(), samples.end(), 0.0) / samples.size();
    auto pct = [&](double p) {
        const auto idx = static_cast<std::size_t>(p * (samples.size() - 1));
        return samples[idx];
    };
    s.p50_ns = pct(0.50);
    s.p90_ns = pct(0.90);
    s.p95_ns = pct(0.95);
    s.p99_ns = pct(0.99);
    if (s.mean_ns > 0) {
        s.events_per_sec = 1e9 / s.mean_ns;
    }
    return s;
}

inline void print_stage_stats(const StageStats& s) {
    std::cout << std::fixed << std::setprecision(3);
    std::cout << s.name << "\n"
              << "  count=" << s.count
              << " mean=" << s.mean_us() << " us (" << s.mean_ms() << " ms)"
              << " p50=" << s.p50_us() << " us"
              << " p90=" << s.p90_us() << " us"
              << " p95=" << s.p95_us() << " us"
              << " p99=" << s.p99_us() << " us"
              << " max=" << s.max_us() << " us (" << s.max_ms() << " ms)"
              << " events/sec=" << std::setprecision(0) << s.events_per_sec
              << "\n";
}

inline void print_markdown_row(const StageStats& s) {
    std::cout << std::fixed << std::setprecision(3);
    std::cout << "| " << s.name
              << " | " << s.p50_us()
              << " | " << s.p95_us()
              << " | " << s.p99_us()
              << " | " << s.max_us()
              << " |\n";
}

class ScopedTimer {
public:
    void start() { start_ = std::chrono::steady_clock::now(); }
    [[nodiscard]] double elapsed_ns() const {
        const auto end = std::chrono::steady_clock::now();
        return static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(end - start_).count());
    }

private:
    std::chrono::steady_clock::time_point start_{};
};

}  // namespace mr::bench
