#!/bin/sh
# Type-checks the mod against the Claude Code engine's own declarations.
#
# The engine writes them to .claude-plugin/types/ when it hot-reloads the mod
# from a development folder. Elsewhere, point CLAUDE_CODE_TYPES at a copy of
# claude-code.d.ts (the plugin-authoring skill writes one for the running
# build) and this script lays it in place. They are not committed.
set -eu
cd "$(dirname "$0")/.."
TARGET=.claude-plugin/types/claude-code/index.d.ts
if [ ! -f "$TARGET" ]; then
  if [ -n "${CLAUDE_CODE_TYPES:-}" ] && [ -f "$CLAUDE_CODE_TYPES" ]; then
    mkdir -p "$(dirname "$TARGET")"
    cp "$CLAUDE_CODE_TYPES" "$TARGET"
  else
    echo "typecheck: skipped (no engine types; set CLAUDE_CODE_TYPES to claude-code.d.ts)" >&2
    npx --no-install tsc -p tsconfig.unit.json
    exit 0
  fi
fi
npx --no-install tsc -p tsconfig.json
npx --no-install tsc -p tsconfig.unit.json
