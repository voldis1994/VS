#!/usr/bin/env bash
# Capital DEMO verify — EXTERNAL_BLOCKER without credentials.
set -euo pipefail
cd "$(dirname "$0")/../control-api"
exec npx tsx src/vs-core/runCapitalDemoCli.ts
