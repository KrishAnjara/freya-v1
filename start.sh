#!/usr/bin/env sh
# Starts FREYA on macOS / Linux:  sh start.sh [--prod] [--format chatml] [--remote URL --key KEY] [--local]
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required: https://nodejs.org"; exit 1; }
exec node scripts/start.mjs "$@"
