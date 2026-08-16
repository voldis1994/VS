# Strategy engine

Location: `SERVER/core/strategy/`.

**Regime ≠ order.** Strategies return eligibility/direction candidates only.

Categories: trendContinuation, trendPullback, rangeMeanReversion, breakoutContinuation, breakoutRetest, reversalConfirmation, noTrade.

No strategy may call the broker. Path: strategy → signal → risk → execution → broker gateway.
