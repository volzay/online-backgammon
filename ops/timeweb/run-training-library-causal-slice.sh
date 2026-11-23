#!/bin/bash
set -euo pipefail
# Keep every historical queue in its original immutable runtime. Four new slots
# in seventeen serve the current policy; a verified empty claim falls through.
previous=/opt/online-backgammon-live-transfer-dispatch-v1/run-live-transfer-causal-slice.sh
slot=$(( $(/usr/bin/date -u +%s) / 600 % 17 ))
if (( slot != 1 && slot != 5 && slot != 9 && slot != 14 )); then exec /usr/bin/bash "$previous";fi
application=/opt/online-backgammon-training-library-db212e88-r2
state=/var/lib/online-backgammon-training-library-causal-db212e88
if [[ -e "$state/pause-admission" ]];then exec /usr/bin/bash "$previous";fi
if result=$(
 cd "$application" || exit 1
 exec /usr/bin/flock --exclusive --nonblock --no-fork "$state/worker.flock" \
  /usr/bin/node scripts/long-bot-causal-worker.js --once --production-journal-dir "$state/terminal-journal" 2>/dev/null
);then :;else status=$?;unset result;exit "$status";fi
if status=$(printf '%s' "$result" | /usr/bin/node -e 'const fs=require("node:fs");try{
 const r=JSON.parse(fs.readFileSync(0,"utf8"));if(!r||Array.isArray(r)||typeof r!=="object"
 ||Object.keys(r).some(k=>!["workerId","claimed","lifecycle","completed"].includes(k))
 ||r.lifecycle!=="long-server-resumable-slices-v2"||!Number.isSafeInteger(r.claimed)||r.claimed<0
 ||!Array.isArray(r.completed)||(r.claimed===0&&r.completed.length!==0))throw Error();
 process.stdout.write(r.claimed===0?"empty":"handled");
 }catch{process.stderr.write("Library causal receipt rejected\n");process.exit(65);}');then unset result;
else status=$?;unset result;exit "$status";fi
[[ "$status" == handled ]]&&exit 0
[[ "$status" == empty ]]||exit 65
exec /usr/bin/bash "$previous"
