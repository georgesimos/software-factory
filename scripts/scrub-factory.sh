#!/bin/sh
# Re-runnable: replaces a personal branch prefix in the factory's self-test fixtures with "dev/".
# Usage: scripts/scrub-factory.sh <prefix>   (stub output and assertions must change together)
set -e
[ -n "$1" ] || { echo "usage: $0 <branch prefix>" >&2; exit 2; }
cd "$(dirname "$0")/../packages/factory"
sed -i.bak "s#$1/#dev/#g" factory.mjs test/gh-stub.mjs test/git-stub.mjs && rm -f factory.mjs.bak test/*.bak
