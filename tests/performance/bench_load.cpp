#include "bench_stats.hpp"

#include "mr/market_core/pipeline.hpp"
#include "mr/common/market_event.hpp"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>
#include <vector>
#include <deque>
#include <mutex>

namespace {

struct LoadResult {
    double target_eps{0};
    double achieved_eps{0};
    double duration_sec{0};
    std::uint64_t produced{0};
    std::uint64_t processed{0};
    std::uint64_t backlog_peak{0};
    double p50_us{0};
    double p95_us{0};
    double p99_us{0};
    double max_us{0};
    bool backlog_grew{false};
};

mr::MarketEvent make_tick(std::uint64_t i) {
    mr::MarketEvent e;
    e.instrument = 1;
    e.source = 1 + static_cast<mr::SourceId>(i % 10);
    e.receive_timestamp = mr::Timestamp(static_cast<long long>(i) * 10'000);
    e.exchange_timestamp = e.receive_timestamp;
    e.provider_timestamp = e.receive_timestamp;
    e.type = (i % 5 == 0) ? mr::MarketEventType::Trade : mr::MarketEventType::Quote;
    const double mid = 1.0850 + (static_cast<double>(i % 200) - 100.0) * 0.00001;
    e.bid = mid - 0.00005;
    e.ask = mid + 0.00005;
    e.last = mid;
    e.bid_size = 100.0;
    e.ask_size = 100.0;
    if (e.type == mr::MarketEventType::Trade) e.trade_size = 1.0;
    e.sequence = i + 1;
    return e;
}

LoadResult run_load(double target_eps, double duration_sec) {
    mr::ConfigRegistry config;
    mr::InstrumentConfig inst;
    inst.id = 1;
    inst.symbol = "EURUSD";
    inst.tick_size = 0.00001;
    config.add_instrument(inst);
    mr::FeedConfig feed;
    feed.id = 1;
    feed.name = "load";
    feed.instruments = {1};
    config.add_feed(feed);

    mr::MarketCorePipeline pipeline;
    pipeline.configure(config);

    // Fixed event count — never burst beyond planned load.
    const std::uint64_t planned = static_cast<std::uint64_t>(target_eps * duration_sec);
    std::deque<mr::MarketEvent> queue;
    std::mutex queue_mutex;
    std::atomic<bool> producing{true};
    std::atomic<std::uint64_t> processed{0};
    std::atomic<std::uint64_t> backlog_peak{0};
    std::vector<double> latencies_ns;
    latencies_ns.reserve(static_cast<std::size_t>(planned) + 16);

    std::thread consumer([&]() {
        for (;;) {
            mr::MarketEvent event;
            bool has = false;
            {
                std::lock_guard lock(queue_mutex);
                if (!queue.empty()) {
                    event = queue.front();
                    queue.pop_front();
                    has = true;
                } else if (!producing.load(std::memory_order_acquire)) {
                    break;
                }
            }
            if (!has) {
                std::this_thread::yield();
                continue;
            }
            const auto start = std::chrono::steady_clock::now();
            pipeline.process_event(event);
            const auto end = std::chrono::steady_clock::now();
            latencies_ns.push_back(static_cast<double>(
                std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count()));
            processed.fetch_add(1, std::memory_order_relaxed);
        }
    });

    const auto start_wall = std::chrono::steady_clock::now();
    const auto interval = std::chrono::duration<double>(1.0 / target_eps);
    auto next_tick = start_wall;

    for (std::uint64_t i = 0; i < planned; ++i) {
        auto event = make_tick(i);
        {
            std::lock_guard lock(queue_mutex);
            queue.push_back(event);
            const auto depth = queue.size();
            const auto prev = backlog_peak.load(std::memory_order_relaxed);
            if (depth > prev) backlog_peak.store(depth, std::memory_order_relaxed);
        }

        next_tick += std::chrono::duration_cast<std::chrono::steady_clock::duration>(interval);
        const auto now = std::chrono::steady_clock::now();
        if (next_tick > now) {
            std::this_thread::sleep_until(next_tick);
        } else {
            // Behind schedule: do NOT catch up with a burst. Resync clock.
            next_tick = now;
        }
    }

    producing.store(false, std::memory_order_release);
    consumer.join();

    const auto end_wall = std::chrono::steady_clock::now();
    const double actual_duration = std::chrono::duration<double>(end_wall - start_wall).count();

    LoadResult result;
    result.target_eps = target_eps;
    result.duration_sec = actual_duration;
    result.produced = planned;
    result.processed = processed.load();
    result.backlog_peak = backlog_peak.load();
    result.achieved_eps = actual_duration > 0
        ? static_cast<double>(result.processed) / actual_duration
        : 0;
    result.backlog_grew = result.backlog_peak > static_cast<std::uint64_t>(target_eps * 0.05);

    auto stats = mr::bench::compute_stage_stats("load", latencies_ns);
    result.p50_us = stats.p50_us();
    result.p95_us = stats.p95_us();
    result.p99_us = stats.p99_us();
    result.max_us = stats.max_us();
    return result;
}

}  // namespace

int main() {
    std::cout << "=== Scalp load stress test (no event dropping, no catch-up burst) ===\n";
    const std::vector<double> targets = {1000, 10000, 50000, 100000};
    const char* env_dur = std::getenv("MR_LOAD_DURATION_SEC");
    const double duration = env_dur ? std::atof(env_dur) : 1.0;

    std::cout << "Duration per target: " << duration << "s\n\n";
    double first_backlog_target = 0;

    for (double target : targets) {
        auto r = run_load(target, duration);
        std::cout << std::fixed;
        std::cout << "Target=" << static_cast<int>(r.target_eps) << " eps"
                  << " achieved=" << static_cast<int>(r.achieved_eps)
                  << " produced=" << r.produced
                  << " processed=" << r.processed
                  << " peak_queue=" << r.backlog_peak
                  << " backlog_grew=" << (r.backlog_grew ? "YES" : "no")
                  << " p50=" << r.p50_us << "us"
                  << " p95=" << r.p95_us << "us"
                  << " p99=" << r.p99_us << "us"
                  << " max=" << r.max_us << "us"
                  << "\n";
        if (r.backlog_grew && first_backlog_target == 0) {
            first_backlog_target = r.target_eps;
        }
        if (r.processed != r.produced) {
            std::cerr << "ERROR: processed != produced (dropped/lost events)\n";
            return 1;
        }
    }

    if (first_backlog_target > 0) {
        std::cout << "\nQueue/backlog growth starts around: "
                  << static_cast<int>(first_backlog_target) << " events/sec\n";
    } else {
        std::cout << "\nNo significant queue growth observed in tested targets.\n";
    }
    std::cout << "Dropped events: 0 (policy: never drop; produced==processed enforced)\n";
    return 0;
}
