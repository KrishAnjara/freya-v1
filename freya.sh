#!/usr/bin/env sh
# FREYA's switches: sh freya.sh for the menu, or: on swearing, off swearing, server URL KEY, local, start
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required: https://nodejs.org"; exit 1; }
exec node scripts/freya.mjs "$@"
