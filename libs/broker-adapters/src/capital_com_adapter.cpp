#include "mr/broker_adapters/capital_com_adapter.hpp"
#include <sstream>

namespace mr {

CapitalComAdapter::CapitalComAdapter(const std::string& base_url) : base_url_(base_url) {}
CapitalComAdapter::~CapitalComAdapter() = default;

size_t CapitalComAdapter::write_callback(void* contents, size_t size, size_t nmemb, void* userp) {
    auto total = size * nmemb;
    static_cast<std::string*>(userp)->append(static_cast<char*>(contents), total);
    return total;
}

size_t CapitalComAdapter::header_callback(char* buffer, size_t size, size_t nitems, void* userdata) {
    auto* adapter = static_cast<CapitalComAdapter*>(userdata);
    std::string header(buffer, size * nitems);
    adapter->apply_auth_header(header);
    return size * nitems;
}

void CapitalComAdapter::apply_auth_header(const std::string& header) {
    if (header.rfind("CST:", 0) == 0) {
        cst_token_ = header.substr(5);
        while (!cst_token_.empty() &&
               (cst_token_.back() == '\r' || cst_token_.back() == '\n' || cst_token_.back() == ' ')) {
            cst_token_.pop_back();
        }
    }
    if (header.rfind("X-SECURITY-TOKEN:", 0) == 0) {
        security_token_ = header.substr(18);
        while (!security_token_.empty() &&
               (security_token_.back() == '\r' || security_token_.back() == '\n' ||
                security_token_.back() == ' ')) {
            security_token_.pop_back();
        }
    }
}

nlohmann::json CapitalComAdapter::http_request(
    const std::string& method, const std::string& path, const nlohmann::json& body) {
    CURL* curl = curl_easy_init();
    if (!curl) return {};

    std::string response;
    std::string url = base_url_ + path;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "X-CAP-API-KEY: configured-via-auth");

    if (!cst_token_.empty()) {
        headers = curl_slist_append(headers, ("CST: " + cst_token_).c_str());
        headers = curl_slist_append(headers, ("X-SECURITY-TOKEN: " + security_token_).c_str());
    }

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);

    std::string body_str;
    if (!body.empty()) {
        body_str = body.dump();
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body_str.c_str());
    }

    if (method == "POST") {
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
    } else if (method == "DELETE") {
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
    }

    CURLcode res = curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) return {};
    try {
        return nlohmann::json::parse(response);
    } catch (...) {
        return {};
    }
}

bool CapitalComAdapter::connect() {
    connected_ = true;
    return true;
}

void CapitalComAdapter::disconnect() {
    connected_ = false;
    cst_token_.clear();
    security_token_.clear();
}

HealthStatus CapitalComAdapter::health() const {
    if (!connected_) return HealthStatus::Disconnected;
    if (cst_token_.empty()) return HealthStatus::Degraded;
    return HealthStatus::Healthy;
}

std::vector<BrokerCapability> CapitalComAdapter::capabilities() const {
    return {
        BrokerCapability::MarketOrder,
        BrokerCapability::LimitOrder,
        BrokerCapability::StopLoss,
        BrokerCapability::TakeProfit,
        BrokerCapability::ModifyPosition
        // TrailingStop: unsupported via REST - documented
        // PartialClose: unsupported - documented
        // WebSocketQuotes: requires separate WS connection - documented
    };
}

bool CapitalComAdapter::supports(BrokerCapability cap) const {
    if (cap == BrokerCapability::TrailingStop ||
        cap == BrokerCapability::PartialClose ||
        cap == BrokerCapability::WebSocketQuotes ||
        cap == BrokerCapability::WebSocketTrades) {
        return false;
    }
    auto caps = capabilities();
    return std::find(caps.begin(), caps.end(), cap) != caps.end();
}

bool CapitalComAdapter::authenticate(
    const std::string& api_key, const std::string& password,
    const std::string& identifier) {
    nlohmann::json body;
    body["identifier"] = identifier;
    body["password"] = password;
    body["encryptedPassword"] = false;

    CURL* curl = curl_easy_init();
    if (!curl) return false;

    std::string response;
    std::string url = base_url_ + "/api/v1/session";
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, ("X-CAP-API-KEY: " + api_key).c_str());

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.dump().c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, this);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);

    CURLcode res = curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    connected_ = (res == CURLE_OK && !cst_token_.empty());
    return connected_;
}

std::optional<BrokerAccountInfo> CapitalComAdapter::account_info() {
    if (!connected_) return std::nullopt;
    auto json = http_request("GET", "/api/v1/accounts");
    if (json.empty() || !json.contains("accounts")) return std::nullopt;
    BrokerAccountInfo info;
    auto& acc = json["accounts"][0];
    info.account_id = acc.value("accountId", "");
    info.balance = acc.value("balance", 0.0);
    info.available = acc.value("available", 0.0);
    info.currency = acc.value("currency", "USD");
    return info;
}

void CapitalComAdapter::set_epic_mapping(InstrumentId id, const std::string& epic) {
    epic_map_[id] = epic;
}

std::optional<BrokerQuote> CapitalComAdapter::quote(InstrumentId instrument) {
    auto it = epic_map_.find(instrument);
    if (it == epic_map_.end()) return std::nullopt;
    auto json = http_request("GET", "/api/v1/markets/" + it->second);
    if (json.empty() || !json.contains("snapshot")) return std::nullopt;
    auto& snap = json["snapshot"];
    BrokerQuote q;
    q.bid = snap.value("bid", 0.0);
    q.ask = snap.value("offer", 0.0);
    q.timestamp = now_utc_ns();
    q.valid = q.bid > 0 && q.ask > 0;
    return q;
}

BrokerOrderResponse CapitalComAdapter::create_position(const BrokerOrderRequest& request) {
    BrokerOrderResponse resp;
    if (!connected_) {
        resp.error_message = "not connected";
        return resp;
    }
    auto it = epic_map_.find(request.instrument);
    if (it == epic_map_.end()) {
        resp.error_message = "unknown instrument epic";
        return resp;
    }

    nlohmann::json body;
    body["epic"] = it->second;
    body["direction"] = request.direction == Direction::Long ? "BUY" : "SELL";
    body["size"] = request.quantity;
    if (request.stop_loss > 0) body["stopLevel"] = request.stop_loss;
    if (request.take_profit > 0) body["profitLevel"] = request.take_profit;

    auto json = http_request("POST", "/api/v1/positions", body);
    if (json.empty() || !json.contains("dealReference")) {
        resp.error_message = "order rejected";
        return resp;
    }
    resp.success = true;
    resp.deal_id = json["dealReference"].get<std::string>();
    resp.fill_price = request.price;
    resp.filled_quantity = request.quantity;
    return resp;
}

BrokerOrderResponse CapitalComAdapter::close_position(const std::string& deal_id) {
    BrokerOrderResponse resp;
    auto json = http_request("DELETE", "/api/v1/positions/" + deal_id);
    resp.success = !json.empty();
    resp.deal_id = deal_id;
    if (!resp.success) resp.error_message = "close failed";
    return resp;
}

std::vector<BrokerPosition> CapitalComAdapter::positions() {
    std::vector<BrokerPosition> result;
    auto json = http_request("GET", "/api/v1/positions");
    if (json.empty() || !json.contains("positions")) return result;
    for (const auto& p : json["positions"]) {
        BrokerPosition pos;
        pos.deal_id = p.value("dealId", "");
        pos.entry_price = p.value("level", 0.0);
        pos.quantity = p.value("size", 0.0);
        std::string dir = p.value("direction", "");
        pos.direction = dir == "BUY" ? Direction::Long : Direction::Short;
        result.push_back(pos);
    }
    return result;
}

}  // namespace mr
