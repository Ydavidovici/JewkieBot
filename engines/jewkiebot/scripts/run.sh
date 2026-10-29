#!/usr/bin/env bash
# Build whatever changed, then start the engine. It prints nothing until you
# type a UCI command, e.g.:
#   uci | isready | position startpos | perft 3 | go depth 10 | bench | quit
#
#   scripts/run.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$SCRIPT_DIR/../build/jewkiebot"

"$SCRIPT_DIR/build.sh"
echo "=== Engine ready: type UCI commands, 'quit' to exit ==="

# Git Bash's own window (mintty) doesn't hand interactive input to native
# Windows programs reliably; winpty (bundled with Git for Windows) bridges it.
# VS Code's terminal and Windows Terminal don't need it.
if [[ "${TERM_PROGRAM:-}" == "mintty" ]] && command -v winpty >/dev/null 2>&1; then
    exec winpty "$ENGINE"
fi
exec "$ENGINE"
