#!/usr/bin/env node
'use strict';
// Every source gets a catalogue entry. Only independently verified positions
// enter the bounded model teacher; neither wins nor losses are action labels.
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const H=require('./generate-long-bot-shadow-replay'),T=require('./long-bot-board-model-worker');
const L=require('./long-bot-training-library'),C=require('./long-bot-causal-worker');
const ROOT=path.resolve(__dirname,'..'),VERSION='long-training-library-worker-v1';
function identity({production=false}={}){
 const files=[...C.runtimeClosureFiles().map(([name])=>name),'scripts/long-bot-board-model-worker.js',
  'scripts/long-bot-training-library.js','scripts/long-bot-training-library-worker.js'].sort();
 const h=createHash('sha256').update(`${VERSION}\0${process.version}\0${process.versions.v8}\0`);
 for(const name of files){const file=path.join(ROOT,name),s=fs.lstatSync(file);
  if(production&&(!s.isFile()||s.uid!==0||(s.mode&0o022)||s.nlink!==1||fs.realpathSync(file)!==file))throw Error('Mutable library runtime');
  h.update(name).update('\0').update(fs.readFileSync(file)).update('\0');
 }
 return {runtimeDigest:h.digest('hex'),policyImplementationId:C.policyImplementationId()};
}
async function runOnce({mode='review',maxSources=1}={}){
 const id=identity({production:true}),owner=randomUUID();
 const rpc=(name,args)=>C.supabaseRpc(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,name,args);
 const report={version:VERSION,...id,classified:0,reviewed:0,lessons:0,deferred:0};
 const started=Date.now();
 for(let n=0;n<maxSources&&Date.now()-started<180000;n++){
  const s=await rpc('claim_long_bot_training_library',{p_runtime:id.runtimeDigest,p_policy:id.policyImplementationId,p_owner:owner,p_mode:mode});
  if(!s)break;
  const args={p_game:s.gameId,p_fingerprint:s.fingerprint,p_runtime:id.runtimeDigest,p_owner:owner};
  if(s.classificationStatus==='pending'){
   let result;try{result=L.classify(s.game,s.archive);}catch(e){result={classificationStatus:'unusable',classification:{version:L.VERSION,reason:e.message.slice(0,200),totalTurns:0,historyVerified:false},turns:[]};}
   // Preserve native chronological indices even when tactical positions are
   // reviewed first. Stable priority does not alter the historical source.
   result.turns=result.turns.map((t,i)=>({...t,sourceTurnIndex:i})).sort((a,b)=>{
    const priority=t=>(t.motifs.includes('five-point-fence')?8:0)+(t.motifs.includes('head-release')?4:0)+(t.motifs.includes('mars-rescue')?2:0);
    return priority(b)-priority(a)||a.sourceTurnIndex-b.sourceTurnIndex;
   });
   await rpc('classify_long_bot_training_library',{...args,p_result:result});report.classified++;continue;
  }
  const source={trainingGameId:s.gameId,roomCode:s.roomCode,fingerprint:s.fingerprint,
   archiveId:s.classification.sourceArchiveId,sourcePolicyImplementationId:s.sourcePolicyImplementationId};
  // Classification may have been retained from an explicitly recorded older
  // worker. Verify its native input again; never copy a teacher receipt or ID.
  const checked=L.verifyTurn(s.turn);
  if(checked.positionHash!==s.turn.positionHash)throw Error('Stored position identity changed');
  const review=await T.reviewTurn({...s.turn,...checked},source,s.cursor,id,{maxRootPositions:256,maxElapsedMs:160000});
  review.sourceClassificationRuntime=s.classification.reusedClassificationRuntime||id.runtimeDigest;
  review.sourceTurnIndex=s.turn.sourceTurnIndex;review.actor=s.turn.actor;review.positionHash=s.turn.positionHash;
  await rpc('checkpoint_long_bot_training_library',{...args,p_previous:s.cursor,p_review:review});
  if(review.status==='capacity'){report.deferred++;continue;}
  report.reviewed++;if(review.lesson)report.lessons++;
 }
 H.loadRuntime().engine.setExperience([],'server');return report;
}
if(require.main===module)(async()=>{
 const a=process.argv.slice(2);
 if(a[0]==='--identity'&&a.length===1)return identity();
 if(a[0]!=='--once'||a.length>3||a[1]&&!['classify','review'].includes(a[1]))throw Error('Usage: --identity | --once [classify|review] [source-count]');
 const maxSources=a[2]===undefined?1:Number(a[2]);if(!Number.isInteger(maxSources)||maxSources<1||maxSources>500)throw Error('Invalid source count');
 return runOnce({mode:a[1]||'review',maxSources});
})().then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
module.exports={VERSION,identity,runOnce};
