#include <gtest/gtest.h>
#include "mr/execution_router/execution_router.hpp"
#include "mr/broker_adapters/broker_adapter.hpp"

TEST(ExecutionTest, DuplicateIntentBlocked) {
    mr::IdGenerator ids;
    mr::ExecutionRouter router(ids);
    mr::TradeIntent intent;
    intent.id = 42;
    intent.instrument = 1;
    intent.decision = mr::EntryDecision::EntryReady;

    mr::AccountConfig account;
    account.account_id = 1;
    account.instrument = 1;
    account.enabled = true;
    account.trading_enabled = true;

    mr::ExecutionResult result;
    result.intent_id = 42;
    result.account_id = 1;
    result.success = true;
    router.record_execution(result);

    EXPECT_TRUE(router.is_duplicate(intent, 1));
    auto requests = router.route(intent, {account});
    EXPECT_TRUE(requests.empty());
}

TEST(ExecutionTest, PaperBrokerFill) {
    mr::PaperBrokerAdapter broker;
    broker.connect();
    mr::BrokerQuote quote{1.0849, 1.0851, mr::now_utc_ns(), true};
    broker.set_quote(1, quote);

    mr::BrokerOrderRequest req;
    req.instrument = 1;
    req.direction = mr::Direction::Long;
    req.quantity = 0.1;
    auto resp = broker.create_position(req);
    EXPECT_TRUE(resp.success);
    EXPECT_GT(resp.fill_price, 0);
    EXPECT_EQ(broker.positions().size(), 1u);
}

TEST(ExecutionTest, RejectWhenNotConnected) {
    mr::PaperBrokerAdapter broker;
    mr::BrokerOrderRequest req;
    req.instrument = 1;
    req.direction = mr::Direction::Long;
    req.quantity = 0.1;
    auto resp = broker.create_position(req);
    EXPECT_FALSE(resp.success);
}

TEST(ExecutionTest, ClosePosition) {
    mr::PaperBrokerAdapter broker;
    broker.connect();
    mr::BrokerQuote quote{1.0849, 1.0851, mr::now_utc_ns(), true};
    broker.set_quote(1, quote);
    mr::BrokerOrderRequest req;
    req.instrument = 1;
    req.direction = mr::Direction::Long;
    req.quantity = 0.1;
    auto open = broker.create_position(req);
    ASSERT_TRUE(open.success);
    auto close = broker.close_position(open.deal_id);
    EXPECT_TRUE(close.success);
    EXPECT_TRUE(broker.positions().empty());
}
