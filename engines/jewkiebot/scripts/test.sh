#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/test.sh
#   scripts/test.sh tests/jewkiebot/board-move-test.cpp
#   scripts/test.sh board_move_tests
#   scripts/test.sh '^engine_.*moves$'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$repo_root/build"

if [[ ! -f "$build_dir/CMakeCache.txt" ]]; then
  echo "=== Configuring CMake (first run) ==="
  cmake -S "$repo_root" -B "$build_dir" -DCMAKE_BUILD_TYPE=RelWithDebInfo
fi

echo "=== Building ==="
cmake --build "$build_dir" -j"$(command -v nproc >/dev/null && nproc || sysctl -n hw.logicalcpu || echo 4)"

echo "=== Running tests ==="
cd "$build_dir"

if [[ $# -ge 1 ]]; then
  arg="$1"
  if [[ "$arg" == *.cpp || "$arg" == *.cc || "$arg" == *.cxx || "$arg" == *.C ]]; then
    fname="$(basename "$arg")"
    stem="${fname%.*}"
    regex="$stem"
  else
    regex="$arg"
  fi

  echo "→ Filtering tests with regex: $regex"
  echo "=== Matching tests (dry-run) ==="
  ctest -N -R "$regex" || true
  echo "=== Running matching tests ==="
  ctest -R "$regex" --output-on-failure
else
  ctest --output-on-failure
fi
