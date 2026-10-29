#!/usr/bin/env bash
# Build the engine (and its tests) into build/, from any directory.
#
#   scripts/build.sh              # incremental Release build: only what changed
#   scripts/build.sh --clean      # wipe build/ first
#   scripts/build.sh Debug        # another build type (reconfigures)
#
# Needs cmake, ninja and g++ on PATH (MSYS2 UCRT64 on Windows).
set -euo pipefail

ENGINE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ENGINE_ROOT/build"
CACHE="$BUILD_DIR/CMakeCache.txt"

CLEAN=0
BUILD_TYPE=Release
for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN=1 ;;
        *) BUILD_TYPE="$arg" ;;
    esac
done

if [[ $CLEAN == 1 ]]; then
    echo "=== Cleaning build/ ==="
    rm -rf "$BUILD_DIR"
fi

# A build/ configured with another generator (or on another machine) can't be
# reused by CMake; start it fresh instead of failing.
if [[ -f "$CACHE" ]] && ! grep -q '^CMAKE_GENERATOR:INTERNAL=Ninja$' "$CACHE"; then
    echo "=== build/ was configured with another generator; starting fresh ==="
    rm -rf "$BUILD_DIR"
fi

current_type="$(sed -n 's/^CMAKE_BUILD_TYPE:STRING=//p' "$CACHE" 2>/dev/null || true)"
if [[ ! -f "$CACHE" || "$current_type" != "$BUILD_TYPE" ]]; then
    echo "=== Configuring ($BUILD_TYPE) ==="
    cmake -S "$ENGINE_ROOT" -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE="$BUILD_TYPE"
fi

echo "=== Building ==="
cmake --build "$BUILD_DIR"

echo "=== Done: $BUILD_DIR/jewkiebot ==="
