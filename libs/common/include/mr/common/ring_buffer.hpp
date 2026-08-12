#pragma once

#include "mr/common/types.hpp"
#include <array>
#include <algorithm>
#include <cmath>
#include <numeric>
#include <stdexcept>
#include <vector>

namespace mr {

template <typename T, std::size_t Capacity>
class RingBuffer {
public:
    void push(const T& value) {
        buffer_[head_] = value;
        head_ = (head_ + 1) % Capacity;
        if (size_ < Capacity) {
            ++size_;
        }
    }

    void push(T&& value) {
        buffer_[head_] = std::move(value);
        head_ = (head_ + 1) % Capacity;
        if (size_ < Capacity) {
            ++size_;
        }
    }

    [[nodiscard]] std::size_t size() const { return size_; }
    [[nodiscard]] bool empty() const { return size_ == 0; }
    [[nodiscard]] bool full() const { return size_ == Capacity; }
    [[nodiscard]] std::size_t capacity() const { return Capacity; }

    [[nodiscard]] const T& newest() const {
        if (size_ == 0) {
            throw std::runtime_error("ring buffer empty");
        }
        auto idx = head_ == 0 ? Capacity - 1 : head_ - 1;
        return buffer_[idx];
    }

    [[nodiscard]] const T& at(std::size_t age) const {
        if (age >= size_) {
            throw std::out_of_range("ring buffer age out of range");
        }
        auto idx = (head_ + Capacity - 1 - age) % Capacity;
        return buffer_[idx];
    }

    void clear() {
        head_ = 0;
        size_ = 0;
    }

private:
    std::array<T, Capacity> buffer_{};
    std::size_t head_{0};
    std::size_t size_{0};
};

struct LatencyStats {
    double p50_ns{0};
    double p90_ns{0};
    double p95_ns{0};
    double p99_ns{0};
    double max_ns{0};
    double mean_ns{0};
    std::uint64_t count{0};
};

inline LatencyStats compute_latency_stats(const std::vector<double>& samples) {
    LatencyStats stats;
    if (samples.empty()) return stats;
    auto sorted = samples;
    std::sort(sorted.begin(), sorted.end());
    stats.count = sorted.size();
    stats.mean_ns = std::accumulate(sorted.begin(), sorted.end(), 0.0) / static_cast<double>(sorted.size());
    stats.max_ns = sorted.back();
    auto pct = [&](double p) {
        auto idx = static_cast<std::size_t>(p * (sorted.size() - 1));
        return sorted[idx];
    };
    stats.p50_ns = pct(0.50);
    stats.p90_ns = pct(0.90);
    stats.p95_ns = pct(0.95);
    stats.p99_ns = pct(0.99);
    return stats;
}

}  // namespace mr
