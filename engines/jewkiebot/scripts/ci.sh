# ci.sh: full workflow: clean, build, test
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
ENGINE_ROOT="${SCRIPT_DIR}/.."
BUILD_DIR="${ENGINE_ROOT}/build"

rm -rf "$BUILD_DIR"
echo "=== Cleaned build ==="

cmake -S "$ENGINE_ROOT" -B "$BUILD_DIR" \
  -G "MinGW Makefiles" \
  -DCMAKE_BUILD_TYPE=Release

cmake --build "$BUILD_DIR" -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

cd "$BUILD_DIR"
ctest --output-on-failure

echo "=== CI: build + test succeeded ==="
