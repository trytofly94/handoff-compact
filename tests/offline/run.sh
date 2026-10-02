#!/bin/bash
# Offline smoke test: runs the mod's logic against a simulated event chain, without
# Claude Code. Useful where `claude plugin test` can't run (mods not enabled yet).
# It is NOT a substitute for tests/*.test.ts, which exercise Claude Code's real semantics.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
command -v node >/dev/null || { echo "SKIP: node not found"; exit 0; }
TMP="$(mktemp -d "${TMPDIR:-/tmp}/handoff-compact-offline.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT
cp "$HERE"/*.mjs "$TMP/"
cp "$HERE/../../hooks/register.js" "$TMP/handoff-compact.mjs"
node "$TMP/handoff-compact.smoke.mjs" "$TMP"
