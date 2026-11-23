#!/bin/bash
set -euo pipefail

# Thirteen slots are coprime with every predecessor schedule (including 11).
# Two slots directly serve the original requested archives in their own runtime.
application=/opt/online-backgammon-live-transfer-7a263bcd-r2
state=/var/lib/online-backgammon-hard-live-transfer-7a263bcd-review
previous=/opt/online-backgammon-board-model-dispatch-v1/run-board-model-causal-slice.sh
slot=$(( $(/usr/bin/date -u +%s) / 600 % 13 ))
if (( slot == 2 || slot == 6 )); then
  application=/opt/online-backgammon-hard-quarters-d33a1c62
  state=/var/lib/online-backgammon-hard-quarters-d33a1c62-review
elif (( slot != 0 && slot != 3 && slot != 7 && slot != 10 )); then
  exec /usr/bin/bash "$previous"
fi
if [[ -e "$state/pause-admission" ]]; then
  exec /usr/bin/bash "$previous"
fi
# Only an authenticated native claimed=0 receipt may fall through to old work.
# A positive claim, error or ambiguous output must never admit another queue.
if result=$(
  cd "$application" || exit 1
  exec /usr/bin/flock --exclusive --nonblock --no-fork "$state/worker.flock" \
    /usr/bin/node scripts/long-bot-causal-worker.js --once \
    --production-journal-dir "$state/terminal-journal" 2>/dev/null
); then
  :
else
  result_status=$?
  unset result
  exit "$result_status"
fi
if status=$(printf '%s' "$result" | /usr/bin/node -e 'const fs=require("node:fs");
try {
  const row=JSON.parse(fs.readFileSync(0,"utf8"));
  if (!row || Array.isArray(row) || typeof row!=="object"
    || Object.keys(row).some(key=>!["workerId","claimed","lifecycle","completed"].includes(key))
    || ("workerId" in row && (typeof row.workerId!=="string" || row.workerId.length<1 || row.workerId.length>128))
    || row.lifecycle!=="long-server-resumable-slices-v2"
    || !Number.isSafeInteger(row.claimed) || row.claimed<0 || !Array.isArray(row.completed)
    || (row.claimed===0 && row.completed.length!==0)) throw Error();
  process.stdout.write(row.claimed===0?"empty":"handled");
} catch { process.stderr.write("Adaptive review receipt rejected\\n");process.exit(65); }'); then
  unset result
else
  result_status=$?
  unset result
  exit "$result_status"
fi
[[ "$status" == handled ]] && exit 0
[[ "$status" == empty ]] || exit 65
exec /usr/bin/bash "$previous"
