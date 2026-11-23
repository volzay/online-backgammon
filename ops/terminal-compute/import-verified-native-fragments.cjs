'use strict';
// All four authenticated fragments are mandatory; individual fragments never
// enter a production journal or create a confidence bound/learning label.
const fs=require('node:fs'),path=require('node:path');
const {validateFragments,sha}=require('./validate-native-results.cjs');
function main(){
 const file=process.argv[2],expectedHash=process.argv[3];if(process.platform!=='linux'||process.getuid()===0||!/^\/var\/lib\/online-backgammon-requested-attested-fragments-20261123\/[A-Za-z0-9-]+-bundle\.json$/.test(file)||!/^[0-9a-f]{64}$/.test(expectedHash||''))throw Error('Private complete bundle under original native worker lock required');
 const bytes=fs.readFileSync(file);if(sha(bytes)!==expectedHash)throw Error('Verified bundle changed');const records=JSON.parse(bytes);if(!Array.isArray(records)||records.length!==4)throw Error('Every fixed range is required');
 const {plan,input,expected}=records[0],root='/opt/online-backgammon-hard-quarters-cached-v1';
 if(plan.root!==root||!['8JPN-KUD8-d7','CTNM-E43Z-d5','CTNM-E43Z-d9','CTNM-E43Z-d13'].includes(plan.id)
  ||plan.stateDirectory!=='/var/lib/online-backgammon-requested-cached-'+(plan.id.startsWith('8JPN')?2401:2402))throw Error('Wrong original source scope');
 const canonical=require(root+'/scripts/generate-long-bot-shadow-replay').stableStringify;
 for(const record of records)if(canonical(record.plan)!==canonical(plan)||canonical(record.input)!==canonical(input)||canonical(record.expected)!==canonical(expected)
  ||record.provenance?.signatureVerified!==true||record.provenance.sourceCommit!==expected.commit||!/^[0-9a-f]{64}$/.test(record.provenance.signatureBundleSha256||''))throw Error('Authenticated fragment bindings differ');
 const full=validateFragments(records.map(r=>r.result),input,expected);
 if(sha(require(root+'/scripts/long-bot-terminal-journal').canonicalManifest(plan.manifest))!==plan.manifestId||plan.workloadSha256!==expected.inputSha256)throw Error('Original native manifest changed');
 const w=require(root+'/scripts/long-bot-causal-worker');if(w.runtimeDigest()!==input.runtimeDigest||w.policyImplementationId()!==input.policyImplementationId||!fs.existsSync(plan.stateDirectory+'/pause-admission'))throw Error('Native runtime or handover changed');
 const fence=require(root+'/scripts/long-bot-production-fence').assertProductionFence({journalDirectory:plan.stateDirectory+'/terminal-journal',applicationDirectory:root});
 const binding=path.basename(plan.journalDirectory);if(!/^[0-9a-f]{64}$/.test(binding)||fence.prepareJobJournal({jobBindingId:binding})!==plan.journalDirectory)throw Error('Wrong original job journal');
 const journal=require(root+'/scripts/long-bot-terminal-journal').createTerminalJournal({directory:plan.journalDirectory,manifest:plan.manifest});let matching=0,committed=0;
 try{
  for(const slot of full.outcomes){const old=journal.lookup(slot.sampleIndex,slot.candidateId,slot.seeds);if(old){if(old.winner!==slot.winner||old.plies!==slot.plies)throw Error('Native endpoint conflict');matching++;}}
  for(const slot of full.outcomes){fence.assertHeld();const r=journal.commit(slot);if(!r?.duplicate)committed++;}
  if(!journal.observation().complete)throw Error('Original 32-sample cohort incomplete');
 }finally{journal.close();}
 const receipt={schema:'long-verified-complete-native-fragments-import-v1',id:input.id,manifestId:plan.manifestId,nativeRuntimeDigest:input.runtimeDigest,policyImplementationId:input.policyImplementationId,completedAt:new Date().toISOString(),declaredSamples:32,endpoints:full.endpoints,alreadyMatchingNativeEndpoints:matching,committed,provenance:{signatureVerified:true,sourceCommit:expected.commit,fragments:records.map(r=>r.provenance)},learningEvidenceCreated:false};
 const dir=path.join(plan.stateDirectory,'verified-remote-native-provenance');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,input.id+'-fragments.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
