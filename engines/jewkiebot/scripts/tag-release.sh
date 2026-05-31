#!/usr/bin/env bash
set -euo pipefail

# Create and push a new version tag *and* GitHub release
# Usage: ./tag-release.sh MAJOR.MINOR.PATCH

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 MAJOR.MINOR.PATCH" >&2
  exit 1
fi

VER=$1
TAG="v${VER}"

# Guard: dirty working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Working tree is dirty. Commit or stash changes before tagging." >&2
  exit 1
fi

# Guard: warn if not on main/master
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "main" && "$current_branch" != "master" ]]; then
  read -p "⚠️  You are on branch '${current_branch}', not main. Continue? [y/N] " confirm
  [[ "${confirm,,}" == "y" ]] || exit 1
fi

# Guard: tag must not already exist
if git rev-parse "$TAG" &>/dev/null; then
  echo "❌ Tag ${TAG} already exists." >&2
  exit 1
fi

read -p "Release notes for ${TAG} (optional, press Enter to skip): " NOTES

git fetch origin

if [[ -n "$NOTES" ]]; then
  git tag -a "$TAG" -m "$NOTES"
else
  git tag "$TAG"
fi

git push origin "$TAG"
echo "✅ Tagged and pushed ${TAG}"

# --- GitHub Release via gh CLI ---
if command -v gh &>/dev/null; then
  if [[ -n "$NOTES" ]]; then
    gh release create "$TAG" --title "$TAG" --notes "$NOTES"
  else
    gh release create "$TAG" --title "$TAG" --generate-notes
  fi
  echo "✅ GitHub release created for ${TAG}"
else
  echo "⚠️  gh CLI not found; skipping GitHub Release creation"
fi
