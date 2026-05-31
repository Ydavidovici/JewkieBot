#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
ENGINE_ROOT="${SCRIPT_DIR}/.."
BUILD_DIR="${ENGINE_ROOT}/build"

echo "=== Cleaning previous build ==="
rm -rf "${BUILD_DIR}"

BUILD_TYPE=${1:-Release}

echo "=== Configuring (CMAKE_BUILD_TYPE=${BUILD_TYPE}) ==="
cmake -S "${ENGINE_ROOT}" -B "${BUILD_DIR}" \
  -G "MinGW Makefiles" \
  -DCMAKE_BUILD_TYPE="${BUILD_TYPE}"

echo "=== Building ==="
cmake --build "${BUILD_DIR}" -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

echo "=== Done ==="
