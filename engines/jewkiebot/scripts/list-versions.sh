#!/usr/bin/env bash
set -eu

# List all semantic-version tags in descending order
# Usage: ./list-versions.sh
git fetch --tags
git tag --list "v[0-9]*.[0-9]*.[0-9]*" --sort=-v:refname