#!/usr/bin/env bash
set -euo pipefail

# Build (incrementally) and run the engine's unit tests.
#
# Usage:
#   scripts/test.sh                           # all unit tests (ctest label "tests")
#   scripts/test.sh tests/perft_test.cpp      # the test built from that file
#   scripts/test.sh perft_test                # tests matching a regex
#   scripts/test.sh performance               # the slow performance suites

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_dir="$SCRIPT_DIR/../build"

"$SCRIPT_DIR/build.sh"

echo "=== Running tests ==="
cd "$build_dir"

if [[ $# -ge 1 ]]; then
  arg="$1"
  if [[ "$arg" == "performance" ]]; then
    ctest -L performance --output-on-failure
    exit
  fi
  if [[ "$arg" == *.cpp || "$arg" == *.cc || "$arg" == *.cxx || "$arg" == *.C ]]; then
    fname="$(basename "$arg")"
    regex="${fname%.*}"
  else
    regex="$arg"
  fi

  echo "→ Filtering tests with regex: $regex"
  ctest -R "$regex" --output-on-failure
else
  ctest -L tests --output-on-failure
fi
