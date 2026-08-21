#!/usr/bin/env bash
# The body of the post-commit TestFlight hook (.claude/settings.local.json).
# Ships the newest commit that touches apps/ios, once, however many commits
# land in a burst: the first one takes the lock and keeps shipping until the
# branch stops moving, so a session that lands seven commits uploads the last
# of them instead of the first.
#
# Every build is cut from the commit itself, so uncommitted work in the
# checkout — a half-finished feature, another project's edits — never rides
# along to TestFlight.
#
# Exits 0 with no output when there is nothing to ship, and 2 to report a
# failed ship back to the session.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 0

LOCK=/tmp/donkey-ship-ios.lock
LOG=dist/ship-ios.log
# The last commit that reached TestFlight, so re-running the hook re-ships
# nothing.
LAST=dist/.ship-ios-last
# A commit older than this came from something other than the command that
# just ran.
FRESH_SECONDS=600

head_sha() { git rev-parse HEAD 2>/dev/null; }
touches_ios() { [[ -n "$(git diff --name-only "$1" "$2" -- apps/ios)" ]]; }

sha="$(head_sha)" || exit 0
[[ -n "$sha" ]] || exit 0
[[ "$sha" != "$(cat "$LAST" 2>/dev/null)" ]] || exit 0
(( $(date +%s) - $(git log -1 --format=%ct "$sha") < FRESH_SECONDS )) || exit 0
[[ -n "$(git show --name-only --format= "$sha" -- apps/ios)" ]] || exit 0

# A ship already holds the lock; its loop picks this commit up on the way out.
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

mkdir -p dist
shipped=""
while :; do
  if [[ -n "$shipped" ]]; then
    sha="$(head_sha)" || break
    [[ "$sha" != "$shipped" ]] || break
    touches_ios "$shipped" "$sha" || break
  fi
  shipped="$sha"
  short="$(git rev-parse --short "$sha")"
  if scripts/ship-ios-testflight.sh --ref "$sha" >"$LOG" 2>&1; then
    printf '%s' "$sha" > "$LAST"
    echo "TestFlight upload done ($short)"
  else
    echo "TestFlight ship failed for $short; see $LOG" >&2
    exit 2
  fi
done
