#!/bin/bash
set -euo pipefail

# Share the existing bounded service between the new policy and its retained
# predecessor queues. Do not replace any historical immutable runtime.
application=/opt/online-backgammon-hard-adaptive-1aebb4b1-r2
state=/var/lib/online-backgammon-hard-adaptive-1aebb4b1-review
previous=/opt/online-backgammon-hard-quarters-d33a1c62/ops/timeweb/dispatch-targeted.sh
if [[ -e "$state/pause-admission" ]]; then exit 0; fi
exec 9>"$state/dispatch.flock"
/usr/bin/flock --exclusive --nonblock 9 || exit 0
next=adaptive
if [[ -r "$state/next-policy" ]]; then IFS= read -r next < "$state/next-policy"; fi
if [[ "$next" == previous ]]; then
  printf 'adaptive\n' > "$state/next-policy"
  exec /usr/bin/bash "$previous"
fi
[[ "$next" == adaptive ]] || exit 1
printf 'previous\n' > "$state/next-policy"
cd "$application"
exec /usr/bin/flock --exclusive --nonblock --no-fork "$state/worker.flock" \
  /usr/bin/node scripts/long-bot-causal-worker.js --once \
  --production-journal-dir "$state/terminal-journal"
