#!/bin/sh
# Proves a move step (docs/plans/split.md, rule 4) against <base-ref>: self-test, core tsc,
# F state of every F demo run and the rendered dashboard data identical, and removed lines == moved lines. POSIX-only dev tool.
set -e
base=${1:?usage: check.sh <base-ref> [moved files...]}; shift
root=$(git rev-parse --show-toplevel); cd "$root"
git add -N "$@" # new files must show in git diff
(cd packages/factory && node factory.mjs test >/dev/null 2>&1) || { echo 'FAIL self-test'; exit 1; }
echo "ok self-test"
pnpm --filter @software-factory/core build >/dev/null || { echo 'FAIL tsc core'; exit 1; }
echo "ok tsc core"
snap() { d=$(mktemp -d); { FACTORY_DIR=$d node "$1/packages/factory/factory.mjs" demo >/dev/null 2>&1
  for r in $(node -e "const fs=require('fs');console.log([...new Set(fs.readFileSync('$d/events.jsonl','utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l).run))].sort().join(' '))"); do
    FACTORY_DIR=$d node "$1/packages/factory/factory.mjs" state "$r" 2>&1 || true; done
  FACTORY_DIR=$d node "$1/packages/factory/factory.mjs" render >/dev/null 2>&1 && grep -o '"generated".*' "$d/dashboard.html" | tr ',' '\n' # the embedded dashboard data (hooks, runs, rules…)
  } | sed -E -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/T/g' -e "s#$d#D#g; s#$1#R#g"; }
b=$(mktemp -d); git archive "$base" packages | tar -x -C "$b"; ln -s "$root/node_modules" "$b/node_modules"
snap "$b" > "$b/before.txt"; snap "$root" > "$b/after.txt"
diff "$b/before.txt" "$b/after.txt" | head -20 && cmp -s "$b/before.txt" "$b/after.txt" || { echo 'FAIL demo state or dashboard data differs'; exit 1; }
echo "ok demo state identical ($(wc -l < "$b/after.txt") lines)"
norm() { grep -vE '^\s*$|^import |^export \{|^export \*|^// @ts-nocheck' | sed -E 's/^export //' | sort; }
git diff -U0 "$base" -- packages/factory/factory.mjs | grep -E '^-[^-]' | cut -c2- | norm > "$b/rm.txt"
git diff -U0 "$base" -- packages/factory/factory.mjs | grep -E '^\+[^+]' | cut -c2- | norm > "$b/fadd.txt"
{ git diff -U0 "$base" -- "$@" | grep -E '^\+[^+]' | cut -c2-; cat "$b/fadd.txt"; } | norm > "$b/add.txt"
diff "$b/rm.txt" "$b/add.txt" && echo "ok removed lines == moved lines"
