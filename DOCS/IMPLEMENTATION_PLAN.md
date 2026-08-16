# Implementation Plan — VS CORE Final Production Build

**Date:** 2026-08-16  
**Branch target:** `cursor/vs-final-production-build-0bd7`  
**Source of truth:** master specification (this plan)

## Proposed final directory tree (authoritative)

```
VS/
├── SERVER/                 # i3 brain (control-api, client-api, core/*, database, install, monitor)
├── ADMIN/                  # MSI Control Panel only (apps/dashboard-v2, windows installers)
├── CLIENT/                 # Customer app (apps/client-v2, windows, enrollment)
├── SHARED/                 # contracts, types, protocol
├── DEPLOY/                 # debian/windows/systemd/docker/wireguard/firewall (from SERVER + scripts)
├── TESTS/                  # unit, integration, security, physical checklists
├── DOCS/                   # architecture, install, acceptance
├── Old-system/             # ALL non-production / historical (formerly legacy + C++ + old UI)
├── scripts/                # release packaging
├── README.md
└── VERSION
```

## Legacy / obsolete (already / to remain in Old-system)

| Item | Action |
|------|--------|
| `Old-system/apps/dashboard` | ARCHIVE — old ADMIN/CLIENT UI |
| `Old-system/libs` C++ | ARCHIVE — not imported by Node |
| `Old-system/legacy-review` | ARCHIVE |
| `Old-system/docs`, cmake, tools, tests | ARCHIVE |
| Fake/mock production data | FORBIDDEN — fail-closed UNKNOWN/NO DATA |

## Missing infrastructure that blocks PHYSICAL acceptance

| Item | Impact |
|------|--------|
| Physical i3 Debian 13 | Blocks i3 SERVER PASS |
| Physical MSI on same LAN | Blocks MSI ADMIN PASS |
| Remote CLIENT different ISP + UDP 51820 | Blocks REMOTE CLIENT PASS |
| Capital.com credentials | Broker stays NOT_CONFIGURED / CONFIG_REQUIRED |
| Live market provider credentials | Market stays UNAVAILABLE unless configured |

## Phase execution (this run)

Complete repository-controlled work: audit docs, DEPLOY layout, missing DOCS, FINAL_ACCEPTANCE_REPORT, harden fail-closed, tests.  
Physical E2E marked **BLOCKED** with evidence, not PASS.
