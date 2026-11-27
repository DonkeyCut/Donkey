#!/usr/bin/env bash
# Runs the site's test suite for a deploy.
#
# A test that hangs on the runner holds the deploy until its time limit. Three
# did in November 2026, each inside an ffmpeg call in the export tests, and
# none reproduced in about ninety reruns. So a watchdog runs beside the suite:
# it writes down what a long-running ffmpeg or ffprobe, or a silent suite, is
# blocked on, and stops the tool so the suite can finish. A failed attempt runs
# once more, and the first failure stays in the run summary as a warning.
set -uo pipefail

ATTEMPTS=2
ATTEMPT_LIMIT_S=600
TOOL_LIMIT_S=60
SILENT_LIMIT_S=120
POLL_S=5
log="${RUNNER_TEMP:-/tmp}/site-tests.log"

# What one process is doing: its command, state, kernel stack, threads, files.
dump() {
  local pid=$1 why=$2
  echo "::group::$why (pid $pid)"
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-400; echo
  ps -eo pid,ppid,stat,etimes,pcpu,wchan:32,args --forest | grep -E "bun|ffmpeg|ffprobe" | grep -v grep | cut -c1-220
  grep -E "^(State|Threads)" "/proc/$pid/status" 2>/dev/null
  echo "wchan: $(cat "/proc/$pid/wchan" 2>/dev/null)"
  sudo cat "/proc/$pid/stack" 2>/dev/null | head -15
  echo "threads (count state wchan name):"
  for t in /proc/"$pid"/task/*; do
    echo "$(awk '{print $3}' "$t/stat" 2>/dev/null) $(cat "$t/wchan" 2>/dev/null) $(cat "$t/comm" 2>/dev/null)"
  done | sort | uniq -c
  echo "open files:"
  sudo ls -l "/proc/$pid/fd" 2>/dev/null | awk 'NR > 1 { print $9, $11 }' | head -15
  echo "::endgroup::"
}

watch() {
  local seen=" " size=0 quiet_since now current age pid
  quiet_since=$(date +%s)
  while sleep "$POLL_S"; do
    now=$(date +%s)

    # A media tool running far past what any test needs is stuck: record it
    # and its parent, then stop it so the test fails and the suite moves on.
    for pid in $(pgrep -x ffmpeg; pgrep -x ffprobe); do
      age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
      if [ "${age:-0}" -le "$TOOL_LIMIT_S" ] || [[ "$seen" == *" $pid "* ]]; then
        continue
      fi
      seen="$seen$pid "
      dump "$pid" "media tool running over ${TOOL_LIMIT_S}s"
      dump "$(ps -o ppid= -p "$pid" | tr -d ' ')" "its parent"
      kill -9 "$pid" 2>/dev/null
    done

    # A suite that prints nothing for minutes is blocked somewhere in Bun.
    current=$(stat -c %s "$log" 2>/dev/null || echo 0)
    if [ "$current" != "$size" ]; then
      size=$current
      quiet_since=$now
      continue
    fi
    if [ $((now - quiet_since)) -gt "$SILENT_LIMIT_S" ]; then
      for pid in $(pgrep -x bun); do
        dump "$pid" "test runner silent for ${SILENT_LIMIT_S}s"
      done
      quiet_since=$now
    fi
  done
}

watch &
watcher=$!
trap 'kill "$watcher" 2>/dev/null' EXIT

for attempt in $(seq 1 "$ATTEMPTS"); do
  : > "$log"
  timeout --kill-after=10 "$ATTEMPT_LIMIT_S" npm test 2>&1 | tee "$log"
  code=${PIPESTATUS[0]}
  if [ "$code" -eq 0 ]; then
    exit 0
  fi
  failed=$(grep -E "^\(fail\)" "$log" | sort -u | head -5 | tr '\n' ' ')
  echo "::warning title=Site tests failed on attempt $attempt::exit $code ${failed:-(no test reported; the attempt hit its ${ATTEMPT_LIMIT_S}s limit)}"
  if [ "$attempt" -eq "$ATTEMPTS" ]; then
    exit "$code"
  fi
done
