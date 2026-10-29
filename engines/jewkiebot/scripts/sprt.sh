#!/usr/bin/env bash
# SPRT self-play: is <new> stronger than <base>?
#
# Builds both versions side by side, prints their bench fingerprints, plays
# them against each other with fastchess until the SPRT reaches a verdict,
# and appends one line to docs/engine-improvements/results.md.
#
#   scripts/sprt.sh <base> <new> [stc|ltc] [gainer|simplify|sanity] [concurrency]
#
#   base / new   a git ref (dev, main, HEAD~1, a branch or commit), or "working"
#                for the working tree exactly as it is, uncommitted edits included
#   stc | ltc    time control: 8+0.08 (default) or 40+0.4
#   gainer       prove new is better:      elo0=0  elo1=5   (default)
#   simplify     prove new isn't worse:    elo0=-5 elo1=0
#   sanity       no SPRT, a fixed 200 games: checks the setup (same engine
#                twice should land near 0 Elo with no crashes or time losses)
#   concurrency  games in parallel (default: logical cores / 2 - 1)
#
# Run with the machine otherwise idle. Several games losing on time at the
# same moment (huge overruns ending together) means the machine stalled, not
# the engine: check the PGN's GameEndTime before trusting such a result.
#
# Examples:
#   scripts/sprt.sh dev working              # my uncommitted change vs dev
#   scripts/sprt.sh main dev stc gainer
#   scripts/sprt.sh working working stc sanity
#
# Needs tools/fastchess/... and tools/UHO_4060_v1.epd (see "Testing harness" in docs/engine-improvements/README.md).
set -euo pipefail
# Without this, a failure inside $(...) (e.g. a build) doesn't stop the script.
shopt -s inherit_errexit

ENGINE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Ask git for both: on Windows it reports C:/... paths while Git Bash uses
# /c/..., so deriving one from the other by string prefix doesn't work.
REPO_ROOT="$(cd "$(git -C "$ENGINE_ROOT" rev-parse --show-toplevel)" && pwd)"
ENGINE_SUBDIR="$(git -C "$ENGINE_ROOT" rev-parse --show-prefix)"
ENGINE_SUBDIR="${ENGINE_SUBDIR%/}"
TOOLS="$ENGINE_ROOT/tools"
WORK="$TOOLS/sprt"
BOOK="$TOOLS/UHO_4060_v1.epd"
RESULTS="$REPO_ROOT/docs/engine-improvements/results.md"

if [[ -x "$TOOLS/fastchess/fastchess-windows-x86-64/fastchess.exe" ]]; then
    FASTCHESS="$TOOLS/fastchess/fastchess-windows-x86-64/fastchess.exe"
else
    FASTCHESS="$(command -v fastchess || true)"
fi

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ $# -ge 2 ]] || usage
BASE_REF="$1" NEW_REF="$2" TC_NAME="${3:-stc}" MODE="${4:-gainer}"
# Default: about one game per physical core, minus one left free for the OS.
CONCURRENCY="${5:-$(( $(nproc 2>/dev/null || echo 4) / 2 - 1 ))}"
(( CONCURRENCY >= 1 )) || CONCURRENCY=1

[[ -n "$FASTCHESS" ]] || { echo "fastchess not found (tools/fastchess/ or PATH)" >&2; exit 1; }
[[ -f "$BOOK" ]] || { echo "opening book missing: $BOOK" >&2; exit 1; }

case "$TC_NAME" in
    stc) TC="8+0.08"; HASH=16 ;;
    ltc) TC="40+0.4"; HASH=64 ;;
    *) usage ;;
esac
case "$MODE" in
    gainer)   SPRT=(-sprt elo0=0 elo1=5 alpha=0.05 beta=0.05);  ROUNDS=20000 ;;
    simplify) SPRT=(-sprt elo0=-5 elo1=0 alpha=0.05 beta=0.05); ROUNDS=20000 ;;
    sanity)   SPRT=();                                          ROUNDS=100 ;;
    *) usage ;;
esac

# fastchess.exe is a native Windows program: hand it Windows paths.
winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }

STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
# Remove this run's temporary worktrees (found by name: build() runs in a
# subshell, so it can't record them in a variable here).
cleanup() {
    for wt in "$WORK"/src-*-"$STAMP"; do
        [[ -d "$wt" ]] && git -C "$REPO_ROOT" worktree remove --force "$wt" >/dev/null 2>&1 || true
    done
    git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

# build <ref> <label>: prints "<engine path>|<short sha>|<bench nodes>"
build() {
    local ref="$1" label="$2" src sha
    if [[ "$ref" == "working" ]]; then
        src="$REPO_ROOT"
        sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD)+wt"
    else
        src="$WORK/src-$label-$STAMP"
        git -C "$REPO_ROOT" worktree add --detach --quiet "$src" "$ref"
        sha="$(git -C "$src" rev-parse --short HEAD)"
    fi
    local out="$WORK/build-$label"
    # Always a clean build: a cache left by an earlier run points at that
    # run's source tree, and would silently build it instead of this one.
    rm -rf "$out"
    cmake -S "$src/$ENGINE_SUBDIR" -B "$out" -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null
    cmake --build "$out" --target jewkiebot >/dev/null
    local exe="$out/jewkiebot"; [[ -f "$exe.exe" ]] && exe="$exe.exe"
    local bench
    bench="$(printf 'bench noeval\nquit\n' | "$exe" | sed -n 's/^Bench: \([0-9]*\) nodes.*/\1/p')"
    echo "$exe|$sha|${bench:-?}"
}

echo "=== Building base ($BASE_REF) and new ($NEW_REF) ==="
# Plain assignments (not `read < <(...)`) so a failed build stops the script.
BASE_INFO="$(build "$BASE_REF" base)"
NEW_INFO="$(build "$NEW_REF" new)"
IFS='|' read -r BASE_EXE BASE_SHA BASE_BENCH <<< "$BASE_INFO"
IFS='|' read -r NEW_EXE NEW_SHA NEW_BENCH <<< "$NEW_INFO"
for exe in "$BASE_EXE" "$NEW_EXE"; do
    [[ -f "$exe" ]] || { echo "build failed: $exe missing" >&2; exit 1; }
done
echo "base: $BASE_SHA  bench $BASE_BENCH"
echo "new:  $NEW_SHA  bench $NEW_BENCH"
[[ "$BASE_BENCH" == "$NEW_BENCH" && "$MODE" == "gainer" ]] &&
    echo "note: identical bench node counts - the change may not alter search at all"

LOG="$WORK/$STAMP.log"
PGN="$WORK/$STAMP.pgn"
echo "=== $MODE, $TC, $CONCURRENCY games in parallel (log: $LOG) ==="

# Run inside $WORK: fastchess autosaves its state to ./config.json.
(cd "$WORK" && "$FASTCHESS" \
    -engine cmd="$(winpath "$NEW_EXE")" name=new \
    -engine cmd="$(winpath "$BASE_EXE")" name=base \
    -each proto=uci tc="$TC" option.Threads=1 option.Hash="$HASH" option.OwnBook=false \
    -openings file="$(winpath "$BOOK")" format=epd order=random \
    -repeat -rounds "$ROUNDS" -concurrency "$CONCURRENCY" -recover \
    -ratinginterval 20 \
    -pgnout file="$(winpath "$PGN")" \
    "${SPRT[@]}") 2>&1 | tee "$LOG" || true   # non-zero after timeouts/crashes; still log the result

# Summarise from fastchess's last report block.
last() { grep -E "$1" "$LOG" | tail -1 | sed 's/^ *//'; }
GAMES_LINE="$(last '^ *Games:')"
ELO_LINE="$(last '^ *Elo:')"
LLR_LINE="$(last '^ *LLR:')"
VERDICT="$(grep -oE 'H[01] was accepted' "$LOG" | tail -1 || true)"
[[ "$MODE" == "sanity" ]] && VERDICT="sanity (fixed games)"

mkdir -p "$(dirname "$RESULTS")"
if [[ ! -f "$RESULTS" ]]; then
    cat > "$RESULTS" <<'EOF'
# Engine SPRT results

One line per `scripts/sprt.sh` run, newest last. Elo is new vs base. Full logs
and PGNs stay local in `engines/jewkiebot/tools/sprt/`.

| Date | Base | New | TC | Mode | Games | Elo | LLR | Verdict | Bench (base → new) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
EOF
fi
printf '| %s | %s %s | %s %s | %s | %s | %s | %s | %s | %s | %s → %s |\n' \
    "$(date +%Y-%m-%d)" "$BASE_REF" "$BASE_SHA" "$NEW_REF" "$NEW_SHA" "$TC" "$MODE" \
    "${GAMES_LINE:-?}" "${ELO_LINE:-?}" "${LLR_LINE:--}" "${VERDICT:-no verdict (stopped?)}" \
    "$BASE_BENCH" "$NEW_BENCH" >> "$RESULTS"

echo "=== Logged to $RESULTS ==="
