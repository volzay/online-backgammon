'use strict';
// This accepts ONLY an operator-staged, signature-verified complete result.
// It cannot verify a GitHub signature by itself. Run the root verification
// wrapper first, then drop to the original worker UID under its REAL flock.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validate,sha}=require('./validate-native-results.cjs');
const ROOTS=new Set(['/opt/online-backgammon-hard-quarters-cached-v1','/opt/online-backgammon-live-transfer-7a263bcd-r2']);
const STATES=new Set(['/var/lib/online-backgammon-requested-cached-2401','/var/lib/online-backgammon-requested-cached-2402','/var/lib/online-backgammon-lem-lesson-confirmation-20261123']);
function main(){
 const file=process.argv[2],expectedHash=process.argv[3];
 if(process.platform!=='linux'||process.getuid()===0||!/^\/var\/lib\/online-backgammon-requested-attested-import-20261123\/[A-Za-z0-9-]+\.json$/.test(file)||!/^[0-9a-f]{64}$/.test(expectedHash||''))throw Error('Fixed private staging and original native worker UID required');
 const bytes=fs.readFileSync(file);if(sha(bytes)!==expectedHash)throw Error('Verified staging changed');const payload=JSON.parse(bytes);
 const {plan,input,result,expected,provenance}=payload;
 if(!ROOTS.has(plan.root)||!STATES.has(plan.stateDirectory)||plan.id!==input.id||plan.manifestId!==input.manifestId||plan.workloadSha256!==expected.inputSha256
  ||sha(require(plan.root+'/scripts/long-bot-terminal-journal').canonicalManifest(plan.manifest))!==plan.manifestId
  ||!provenance||provenance.signatureVerified!==true||provenance.sourceCommit!==expected.commit
  ||!/^[0-9a-f]{64}$/.test(provenance.sealedArtifactSha256||'')||!/^[0-9a-f]{64}$/.test(provenance.signatureBundleSha256||''))throw Error('Verified import binding differs');
 validate(result,input,expected);
 const w=require(plan.root+'/scripts/long-bot-causal-worker');if(w.runtimeDigest()!==input.runtimeDigest||w.policyImplementationId()!==input.policyImplementationId)throw Error('Native reviewer changed');
 if(!fs.existsSync(plan.stateDirectory+'/pause-admission'))throw Error('Pause admission before taking original worker flock');
 if(plan.journalDirectory!==plan.stateDirectory+'/terminal-journal'&&!new RegExp('^'+plan.stateDirectory+'/terminal-journal/[0-9a-f]{64}$').test(plan.journalDirectory))throw Error('Journal outside original private worker state');
 const fence=require(plan.root+'/scripts/long-bot-production-fence').assertProductionFence({journalDirectory:plan.stateDirectory+'/terminal-journal',applicationDirectory:plan.root});
 const binding=path.basename(plan.journalDirectory);if(/^[0-9a-f]{64}$/.test(binding))fence.prepareJobJournal({jobBindingId:binding});
 fence.assertHeld();const journal=require(plan.root+'/scripts/long-bot-terminal-journal').createTerminalJournal({directory:plan.journalDirectory,manifest:plan.manifest});
 let matching=0,committed=0;
 try{
  // All existing endpoints are compared before adding a single new endpoint.
  for(const slot of result.outcomes){const previous=journal.lookup(slot.sampleIndex,slot.candidateId,slot.seeds);if(previous){if(previous.winner!==slot.winner||previous.plies!==slot.plies||previous.complete!==true)throw Error('Remote native result conflicts with original production endpoint');matching++;}}
  for(const slot of result.outcomes){fence.assertHeld();const r=journal.commit(slot);if(!r?.duplicate)committed++;}
  if(!journal.observation().complete)throw Error('Native journal remains incomplete');
 }finally{journal.close();}
 const dir=path.join(plan.stateDirectory,'verified-remote-native-provenance');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const receipt={schema:'long-verified-remote-native-import-v1',id:input.id,manifestId:plan.manifestId,nativeRuntimeDigest:input.runtimeDigest,policyImplementationId:input.policyImplementationId,
  completedAt:new Date().toISOString(),endpoints:result.outcomes.length,alreadyMatchingNativeEndpoints:matching,committed,provenance,learningEvidenceCreated:false};
 fs.writeFileSync(path.join(dir,input.id+'.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(receipt));
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
