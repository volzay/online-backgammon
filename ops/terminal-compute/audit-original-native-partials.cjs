'use strict';
// Authenticate the pre-cache historical endpoints under their original lock
// and compare them with the independently attested complete replacement.
// No terminal slots, counters, archive fields or learning evidence are written.
const fs=require('node:fs'),path=require('node:path');
const original=Number(process.argv[2]);if(![2401,2402].includes(original))throw Error('Fixed original source required');
const root='/opt/online-backgammon-hard-quarters-d33a1c62',state='/var/lib/online-backgammon-requested-native-'+original;
const id=original===2401?'8JPN-KUD8-d1':'CTNM-E43Z-d1';
const replacement=JSON.parse(fs.readFileSync('/var/lib/online-backgammon-requested-attested-import-20261123/'+id+'.json'));
const w=require(root+'/scripts/long-bot-causal-worker');
const canonical=require(root+'/scripts/generate-long-bot-shadow-replay').stableStringify;
if(w.runtimeDigest()!=='d7fd1192b3c1cea8e1793b9261703f85c4a9effd18169dc2eeb1b4a567b99183'
 ||w.policyImplementationId()!==replacement.input.policyImplementationId||!fs.existsSync(state+'/pause-admission'))throw Error('Original release/scope differs');
const fence=require(root+'/scripts/long-bot-production-fence').assertProductionFence({journalDirectory:state+'/terminal-journal',applicationDirectory:root});
const manifests=[];
for(const binding of fs.readdirSync(state+'/terminal-journal').filter(n=>/^[0-9a-f]{64}$/.test(n))){
 const directory=fence.prepareJobJournal({jobBindingId:binding});
 for(const cohort of fs.readdirSync(directory).filter(n=>/^[0-9a-f]{64}$/.test(n))){const manifest=JSON.parse(fs.readFileSync(path.join(directory,cohort,'manifest.json')));
  if(manifest.bindings.sourceDecisionIndex===replacement.plan.manifest.bindings.sourceDecisionIndex)manifests.push({directory,manifest});}
}
if(manifests.length!==1)throw Error('Original source cohort is not unique');
const {directory,manifest}=manifests[0],current=replacement.plan.manifest;
for(const field of ['candidateIds','seedsBySample','sampleCount','botColor','maxPlies'])if(canonical(manifest[field])!==canonical(current[field]))throw Error('Native experiment differs: '+field);
for(const field of ['authoritativeArchiveFingerprint','orderedStateCanonical','selectedOrderedMoveKey','selectedAfterPositionKey','completeOrderedLegalSet','rolloutLimits'])if(canonical(manifest.bindings[field])!==canonical(current.bindings[field]))throw Error('Original source experiment differs: '+field);
const full=new Map(replacement.result.outcomes.map(s=>[s.sampleIndex+':'+s.candidateId,s]));
const journal=require(root+'/scripts/long-bot-terminal-journal').createTerminalJournal({directory,manifest});let compared=0;
try{for(let sample=0;sample<32;sample++)for(const candidate of manifest.candidateIds){const slot=journal.lookup(sample,candidate,manifest.seedsBySample[sample]);if(!slot)continue;
 const actual=full.get(sample+':'+candidate);if(!actual||actual.winner!==slot.winner||actual.plies!==slot.plies)throw Error('Original native endpoint differs');compared++;}}
finally{journal.close();}
console.log(JSON.stringify({id,originalJobId:original,originalNativeRuntime:w.runtimeDigest(),replacementNativeRuntime:replacement.input.runtimeDigest,originalAuthenticatedEndpointsCompared:compared,winnerAndPliesMatched:compared,conflicts:0,learningEvidenceCreated:false}));
