# Windows MSVC Release Performance — REQUIRED TARGET

## Status

**NOT TESTED ON TARGET ENVIRONMENT**

This Cloud Agent run executes on **Ubuntu Linux / GCC**, not Windows 11 x64 / MSVC.

Windows/MSVC Release numbers must be produced by:

```bat
scripts\verify_windows_release.bat
```

or:

```bat
scripts\benchmark_windows_release.bat
```

Results are written to `benchmark-results\windows-msvc-release.txt`.

## Required report fields (fill after Windows run)

Environment: Windows 11 x64  
Compiler: MSVC  
Configuration: Release  

| Pipeline stage | p50 (us) | p95 (us) | p99 (us) | max (us) |
|---|---:|---:|---:|---:|
| Feature Engine | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Market State | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Regime | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Evidence | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Entry Decision | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Position Update | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Exit Decision | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Full Pipeline | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |

Max sustainable events/sec: **NOT TESTED ON TARGET ENVIRONMENT**  
Dropped events: **NOT TESTED ON TARGET ENVIRONMENT**  
Peak queue depth: **NOT TESTED ON TARGET ENVIRONMENT**  
Peak RAM: **NOT TESTED ON TARGET ENVIRONMENT**  
CPU usage: **NOT TESTED ON TARGET ENVIRONMENT**

## Linux GCC reference only (NOT a Windows substitute)

See `benchmark-results/linux-hotpath-NOT-WINDOWS.txt` after local Linux runs.
These numbers are for development triage only and must not be reported as MSVC results.
