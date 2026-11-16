#!/usr/bin/env bash
# macOS / Linux equivalent of PREPARE-EVENT.bat
set -euo pipefail
cd "$(dirname "$0")"
echo "[1/5] npm ci";          npm ci --no-audit --no-fund
echo "[2/5] typecheck";       npm run typecheck
echo "[3/5] tests";           npm test
echo "[4/5] build";           npx vite build
echo "[5/5] verify build";    npx tsx scripts/verify-build.ts
echo "PREPARED. On event day run ./start-event.sh (no internet needed)."
