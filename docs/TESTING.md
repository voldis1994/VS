# Testing

## Quick run (Windows)

```bat
scripts\test.bat
```

Configures/builds `windows-debug` and runs `ctest --output-on-failure` in `build\windows-debug`.

Benchmarks:

```bat
scripts\benchmark.bat
```

## C++ suites

CMake target tree under `tests/`:

| Suite | Location | Focus |
|-------|----------|-------|
| Unit | `tests/unit` | Clock latency stats, config validation, ring buffer, entry quality gates, exit MFE/MAE and reasons |
| Integration | `tests/integration` | Full `MarketCorePipeline` on synthetic events → state + regime |
| Execution | `tests/execution` | Duplicate intent blocking, paper broker fills |
| Replay | `tests/replay` | `.mrev` write/read deterministic playback |
| Security | `tests/security` | `.env.example` placeholders, `.gitignore` covers `.env` |
| Performance | `tests/performance` | Hot-path / load benches always; `bench_pipeline` needs optional vcpkg feature `benchmarks` |
| Regression | `tests/regression` | Reserved suite wiring |

Linux/CI style:

```bash
cmake --preset linux-debug
cmake --build build/linux-debug
cd build/linux-debug && ctest --output-on-failure
```

## Control API (Node)

```bash
cd apps/control-api
npm test
```

Vitest covers AES-GCM encrypt/decrypt and `maskSecret` (`src/security/encryption.test.ts`).

## What good looks like

- Entry tests: confirmed setup + valid evidence + good quote → `EntryReady` when EV/probability clear thresholds; stale data → `Reject`.  
- Exit tests: MFE/MAE tracking; peak retention / hard invalidation paths.  
- Replay: N recorded quotes → N callbacks in order.  
- Execution: successful fill recorded → subsequent `route` empty for that intent×account.  

Fix failures before enabling DEMO/LIVE. Prefer green unit + integration + security before performance tuning.
