#pragma once

#include "mr/broker_adapters/broker_adapter.hpp"
#include <curl/curl.h>
#include <nlohmann/json.hpp>

namespace mr {

// Capital.com REST API adapter
// Official API: https://open-api.capital.com/
// Unsupported capabilities are explicitly documented.
class CapitalComAdapter : public IBrokerAdapter {
public:
    explicit CapitalComAdapter(const std::string& base_url);
    ~CapitalComAdapter() override;

    bool connect() override;
    void disconnect() override;
    bool is_connected() const override { return connected_; }
    HealthStatus health() const override;
    std::vector<BrokerCapability> capabilities() const override;
    bool supports(BrokerCapability cap) const override;
    bool authenticate(const std::string& api_key, const std::string& password,
                      const std::string& identifier) override;
    std::optional<BrokerAccountInfo> account_info() override;
    std::optional<BrokerQuote> quote(InstrumentId instrument) override;
    BrokerOrderResponse create_position(const BrokerOrderRequest& request) override;
    BrokerOrderResponse close_position(const std::string& deal_id) override;
    std::vector<BrokerPosition> positions() override;

    void set_epic_mapping(InstrumentId id, const std::string& epic);

private:
    std::string base_url_;
    std::string cst_token_;
    std::string security_token_;
    bool connected_{false};
    std::unordered_map<InstrumentId, std::string> epic_map_;

    static size_t write_callback(void* contents, size_t size, size_t nmemb, void* userp);
    static size_t header_callback(char* buffer, size_t size, size_t nitems, void* userdata);
    void apply_auth_header(const std::string& header);
    nlohmann::json http_request(const std::string& method, const std::string& path,
                                 const nlohmann::json& body = {});
};

}  // namespace mr
