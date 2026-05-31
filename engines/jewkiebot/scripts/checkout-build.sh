#!/usr/bin/env bash
set -euo pipefail

# Checkout a specific version tag and build it
# Usage: ./checkout-build.sh [v]MAJOR.MINOR.PATCH

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 [v]MAJOR.MINOR.PATCH" >&2
  exit 1
fi

# strip leading "v" if present, then re-add it
VER="${1#v}"
TAG="v${VER}"

echo "Checking out ${TAG}..."
git fetch --tags
git checkout "tags/${TAG}"

echo "Building source at ${TAG}..."
"$(dirname "${BASH_SOURCE[0]}")/build.sh"

echo "✅ Build complete for ${TAG}"
