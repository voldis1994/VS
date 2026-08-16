# Entry Engine

`EntryEngine` (`libs/entry-engine`) converts a confirmed setup + valid evidence + market/regime context into an explainable `TradeIntent`. Policy knobs: `config/entry-policy.yaml`.

## Inputs

- `SetupCandidate` — must be `SetupLifecycle::Confirmed`  
- `EvidenceReport` — must be `is_valid`  
- `MarketState`, `RegimeState`  
- `BrokerQuote` — executable bid/ask  
- `spread_cost` — included in EV after costs  
- `intent_ttl_ms` — default **2000** ms  

## Decisions

| `EntryDecision` | Meaning |
|-----------------|--------|
| `NoTrade` | Soft decline (insufficient edge, unconfirmed setup, invalid evidence) |
| `EntryReady` | Positive EV intent ready for router |
| `Reject` | Hard reject (stale data, missing quote, expired TTL) |

## Gate sequence

1. Invalid evidence → `NoTrade` / `NO_VALID_EVIDENCE`  
2. Setup not confirmed → `NoTrade` / `SETUP_NOT_CONFIRMED`  
3. Stale data quality → `Reject` / `STALE_DATA`  
4. Invalid quote → `Reject` / `NO_EXECUTABLE_QUOTE`  
5. Compute prices, probability, EV  
6. If `EV_after_costs > 0` **and** `probability > 0.55` → `EntryReady` / `POSITIVE_EV`  
   else → `NoTrade` / `INSUFFICIENT_EDGE`  

`reject_stale()` marks expired `EntryReady` intents as `Reject` / `EXPIRED`.

## Expected value

```
EV = P(win) * expected_favorable_move
   - (1 - P(win)) * expected_adverse_move
   - costs
```

- Mid reference: `(bid + ask) / 2`  
- Acceptable entry band: `[bid, ask]`  
- Favorable move default: `3 × spread`  
- Adverse move default: `2 × spread`  
- Initial invalidation: reference ± adverse (by direction)  
- `expected_value_before_costs` / `expected_value_after_costs` both stored on the intent  

## Probability model

`IProbabilityModel` abstraction; default `BaselineProbabilityModel` (`baseline-v1`):

- Base 0.5  
- +0.2 × direction confidence  
- +0.15 × multi-feed consensus  
- +0.1 if flow aligns with trade direction  
- −0.3 if data stale  
- Clamped to `[0, 1]`  

## TradeIntent payload

Includes ids (intent, setup, evidence report, market snapshot), direction, TTL window, reference/entry band, expected moves, invalidation, probability, EV before/after costs, `reason_codes`, `human_explanation`, `model_version`.

## Explainability

`build_explanation()` emits a structured text block:

```
REGIME:
<regime name>
SETUP:
<setup_type>
SUPPORTING EVIDENCE:
- <evidence type names>
CONTRADICTING:
- ...
DECISION:
ENTRY_READY | NO_TRADE
```

Reason codes are machine-readable companions for audit (`trade_intents.reason_codes` in Postgres).
