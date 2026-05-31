#!/usr/bin/env bash
set -euo pipefail

git fetch origin --tags --force

# pick highest semver tag
latest=$(git tag -l 'v*' | sort -V | tail -n1)
echo "🔖 Latest release tag is ${latest}"

# name a branch based on it
branch="release-${latest#v}"

# checkout or reset that branch to the tag
git checkout -B "$branch" "$latest"

echo "🌱 Working on branch ${branch} (from ${latest})"
exec "$(dirname "${BASH_SOURCE[0]}")/build.sh"