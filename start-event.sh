#!/usr/bin/env bash
# macOS / Linux equivalent of START-EVENT.bat
cd "$(dirname "$0")"
[ -d node_modules/tsx ] || { echo "Not prepared: run ./prepare-event.sh first."; exit 1; }
[ -f dist/build-info.json ] || { echo "No prepared build: run ./prepare-event.sh first."; exit 1; }
exec node --import tsx server/index.ts
