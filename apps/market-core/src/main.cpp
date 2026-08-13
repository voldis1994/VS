#include "mr/market_core/pipeline.hpp"
#include "mr/market_data/provider.hpp"
#include "mr/replay/replay_engine.hpp"
#include "mr/telemetry/telemetry_hub.hpp"
#include "mr/broker_adapters/capital_com_adapter.hpp"
#include "mr/common/config.hpp"
#include "mr/common/market_event.hpp"
#include "mr/common/types.hpp"
#include <spdlog/spdlog.h>
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <iostream>
#include <csignal>
#include <atomic>
#include <thread>
#include <chrono>
#include <unordered_map>
#include <cstdlib>

static std::atomic<bool> g_running{true};

void signal_handler(int) {
    g_running = false;
}

mr::OperatingMode parse_mode(const std::string& mode) {
    if (mode == "REPLAY") return mr::OperatingMode::Replay;
    if (mode == "PAPER") return mr::OperatingMode::Paper;
    if (mode == "DEMO") return mr::OperatingMode::Demo;
    if (mode == "LIVE") return mr::OperatingMode::Live;
    return mr::OperatingMode::Paper;
}

static size_t curl_write(void* contents, size_t size, size_t nmemb, void* userp) {
    auto* s = static_cast<std::string*>(userp);
    s->append(static_cast<char*>(contents), size * nmemb);
    return size * nmemb;
}

static bool http_json(const std::string& method, const std::string& url,
                      const std::string& token_header, const std::string& token,
                      const nlohmann::json& body, nlohmann::json* out) {
    CURL* curl = curl_easy_init();
    if (!curl) return false;
    std::string response;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    std::string auth = token_header + ": " + token;
    headers = curl_slist_append(headers, auth.c_str());
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
    std::string payload;
    if (method == "POST") {
        payload = body.dump();
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload.c_str());
    } else {
        curl_easy_setopt(curl, CURLOPT_HTTPGET, 1L);
    }
    CURLcode rc = curl_easy_perform(curl);
    long code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    if (rc != CURLE_OK || code < 200 || code >= 300) {
        spdlog::warn("HTTP {} {} failed curl={} http={}", method, url, static_cast<int>(rc), code);
        return false;
    }
    if (out) {
        try {
            *out = nlohmann::json::parse(response.empty() ? "{}" : response);
        } catch (...) {
            return false;
        }
    }
    return true;
}

static std::string env_or(const char* key, const std::string& fallback = {}) {
    const char* v = std::getenv(key);
    return v && *v ? std::string(v) : fallback;
}

/** LIVE bridge: Capital quotes → EntryEngine → POST /api/pipeline/intents */
static int run_live_bridge(mr::MarketCorePipeline& pipeline) {
    const std::string api = env_or("CONTROL_API_URL", "http://127.0.0.1:3000");
    const std::string token = env_or("PIPELINE_TOKEN", env_or("PIPELINE_SERVICE_TOKEN"));
    if (token.empty() || token == "CHANGE_ME_PIPELINE_TOKEN" || token == "CHANGE_ME_ADMIN_TOKEN") {
        spdlog::error("Set PIPELINE_TOKEN or PIPELINE_SERVICE_TOKEN for LIVE bridge");
        return 1;
    }

    const std::string capital_env = env_or("CAPITAL_ENVIRONMENT", "demo");
    const std::string base =
        capital_env == "live" || capital_env == "LIVE"
            ? "https://api-capital.backend-capital.com"
            : "https://demo-api-capital.backend-capital.com";
    const std::string api_key = env_or("CAPITAL_API_KEY");
    const std::string password = env_or("CAPITAL_API_PASSWORD");
    const std::string identifier = env_or("CAPITAL_IDENTIFIER");
    if (api_key.empty() || password.empty() || identifier.empty()) {
        spdlog::error("CAPITAL_API_KEY / CAPITAL_API_PASSWORD / CAPITAL_IDENTIFIER required");
        return 1;
    }

    mr::CapitalComAdapter capital(base);
    if (!capital.connect() || !capital.authenticate(api_key, password, identifier)) {
        spdlog::error("Capital.com authenticate failed");
        return 1;
    }

    std::unordered_map<std::string, mr::InstrumentId> epic_to_id;
    std::unordered_map<mr::InstrumentId, std::string> id_to_epic;
    mr::InstrumentId next_id = 1;
    mr::SequenceNumber seq = 1;
    mr::ConfigRegistry config;
    pipeline.configure(config);

    spdlog::info("LIVE bridge started → {}", api);

    while (g_running) {
        nlohmann::json sub_json;
        if (!http_json("GET", api + "/api/pipeline/subscribed-epics", "x-pipeline-token", token,
                       {}, &sub_json)) {
            http_json("POST", api + "/api/pipeline/heartbeat", "x-pipeline-token", token,
                      nlohmann::json{{"error", "subscribed-epics fetch failed"}, {"epics", nlohmann::json::array()}},
                      nullptr);
            std::this_thread::sleep_for(std::chrono::seconds(3));
            continue;
        }

        std::vector<std::string> epics;
        if (sub_json.contains("epics") && sub_json["epics"].is_array()) {
            for (const auto& row : sub_json["epics"]) {
                std::string epic = row.value("epic", "");
                if (!epic.empty()) epics.push_back(epic);
            }
        }

        http_json("POST", api + "/api/pipeline/heartbeat", "x-pipeline-token", token,
                  nlohmann::json{{"epics", epics}}, nullptr);

        for (const auto& epic : epics) {
            if (!epic_to_id.count(epic)) {
                mr::InstrumentId id = next_id++;
                epic_to_id[epic] = id;
                id_to_epic[id] = epic;
                capital.set_epic_mapping(id, epic);
                mr::InstrumentConfig ic;
                ic.id = id;
                ic.symbol = epic;
                ic.display_name = epic;
                config.add_instrument(ic);
                pipeline.configure(config);
                spdlog::info("Tracking subscribed epic {} as instrument {}", epic, id);
            }
            auto id = epic_to_id[epic];
            auto q = capital.quote(id);
            if (!q || !q->valid) continue;

            mr::MarketEvent ev;
            ev.instrument = id;
            ev.source = 1;
            ev.bid = q->bid;
            ev.ask = q->ask;
            ev.last = (q->bid + q->ask) / 2.0;
            ev.type = mr::MarketEventType::Quote;
            ev.sequence = seq++;
            ev.exchange_timestamp = q->timestamp;
            ev.provider_timestamp = q->timestamp;
            ev.receive_timestamp = mr::now_utc_ns();
            pipeline.process_event(ev);
        }

        auto intents = pipeline.drain_pending_intents();
        for (const auto& intent : intents) {
            if (intent.decision != mr::EntryDecision::EntryReady) continue;
            auto it = id_to_epic.find(intent.instrument);
            if (it == id_to_epic.end()) continue;
            const std::string& epic = it->second;
            const char* dir = intent.direction == mr::Direction::Short ? "SELL" : "BUY";
            nlohmann::json body;
            body["epic"] = epic;
            body["direction"] = dir;
            body["decision"] = "ENTRY_READY";
            body["instrument_id"] = static_cast<int>(intent.instrument);
            body["setup_id"] = static_cast<int>(intent.setup_id);
            body["reference_price"] = intent.reference_price;
            body["explanation"] = intent.human_explanation;
            body["intent_id"] = static_cast<int>(intent.id);
            body["idempotency_key"] = "mc-" + std::to_string(intent.id) + "-" + epic;
            body["reason_codes"] = intent.reason_codes;
            body["setup_type"] = intent.setup_type;
            body["regime"] = intent.regime.empty()
                ? mr::regime_name(pipeline.latest_regime(intent.instrument).current)
                : intent.regime;
            nlohmann::json resp;
            if (http_json("POST", api + "/api/pipeline/intents", "x-pipeline-token", token, body,
                          &resp)) {
                spdlog::info("Published EntryReady {} {} {}", intent.id, dir, epic);
            } else {
                spdlog::error("Failed to publish intent {} for {}", intent.id, epic);
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }

    capital.disconnect();
    return 0;
}

int main(int argc, char* argv[]) {
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    spdlog::set_level(spdlog::level::info);
    spdlog::info("Market Core starting...");
    curl_global_init(CURL_GLOBAL_DEFAULT);

    std::string mode_str = "PAPER";
    std::string replay_file;
    std::string config_dir = "config";
    std::string record_path = "data/raw/events.mrev";
    bool bridge = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--mode" && i + 1 < argc) mode_str = argv[++i];
        else if (arg == "--replay" && i + 1 < argc) replay_file = argv[++i];
        else if (arg == "--config" && i + 1 < argc) config_dir = argv[++i];
        else if (arg == "--record" && i + 1 < argc) record_path = argv[++i];
        else if (arg == "--bridge") bridge = true;
    }

    auto mode = parse_mode(mode_str);
    if (mode == mr::OperatingMode::Live) {
        spdlog::warn("LIVE mode — operator risk accepted");
    }

    mr::MarketCorePipeline pipeline;

    // Client Panel production path: Capital quotes → EntryEngine → control-api fanout
    if (bridge || (mode == mr::OperatingMode::Live && env_or("MARKET_CORE_BRIDGE", "0") == "1")) {
        int rc = run_live_bridge(pipeline);
        curl_global_cleanup();
        return rc;
    }

    mr::ConfigRegistry config;
    mr::InstrumentConfig eurusd;
    eurusd.id = 1;
    eurusd.symbol = "EURUSD";
    eurusd.display_name = "EUR/USD";
    eurusd.tick_size = 0.00001;
    config.add_instrument(eurusd);

    mr::FeedConfig feed1;
    feed1.id = 1;
    feed1.name = "synthetic-primary";
    feed1.provider = "synthetic";
    feed1.instruments = {1};
    feed1.stale_threshold_ms = 500;
    config.add_feed(feed1);

    pipeline.configure(config);
    pipeline.enable_recording(mode != mr::OperatingMode::Replay);
    pipeline.set_recording_path(record_path);

    spdlog::info("Operating mode: {}", mode_str);

    if (mode == mr::OperatingMode::Replay) {
        if (replay_file.empty()) {
            spdlog::error("REPLAY mode requires --replay <file>");
            curl_global_cleanup();
            return 1;
        }
        mr::ReplayEngine replay;
        if (!replay.load(replay_file)) {
            spdlog::error("Failed to load replay file: {}", replay_file);
            curl_global_cleanup();
            return 1;
        }
        spdlog::info("Loaded replay file, starting playback...");
        replay.start([&](const mr::MarketEvent& event) {
            pipeline.process_event(event);
        });
        while (replay.is_running() && g_running) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        replay.stop();
    } else {
        mr::SyntheticMarketDataProvider provider(1, 1, 1.0850, 1000);
        provider.start([&](const mr::MarketEvent& event) {
            pipeline.process_event(event);
        });
    }

    auto intents = pipeline.pending_intents();
    spdlog::info("Processed events. Pending trade intents: {}", intents.size());
    for (const auto& intent : intents) {
        spdlog::info("TradeIntent {} decision={} EV={:.6f}",
            intent.id, static_cast<int>(intent.decision),
            intent.expected_value_after_costs);
    }

    spdlog::info("Market Core stopped.");
    curl_global_cleanup();
    return 0;
}
