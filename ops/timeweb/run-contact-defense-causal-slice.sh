#!/bin/bash
set -euo pipefail
# New games get bounded slots; historical policies continue in their original
# dispatchers and immutable journals. A genuinely empty claim falls through.
previous=/opt/online-backgammon-head-escape-dispatch-v1/run-head-escape-causal-slice.sh
slot=$(( $(/usr/bin/date -u +%s) / 600 % 25 ))
if (( slot != 3 && slot != 9 && slot != 15 && slot != 22 ));then exec /usr/bin/bash "$previous";fi
application=/opt/online-backgammon-contact-defense-06611894-r3
state=/var/lib/online-backgammon-contact-defense-causal-06611894
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
 }catch{process.stderr.write("Contact-defense causal receipt rejected\n");process.exit(65);}');then unset result;
else status=$?;unset result;exit "$status";fi
[[ "$status" == handled ]]&&exit 0
[[ "$status" == empty ]]||exit 65
exec /usr/bin/bash "$previous"
