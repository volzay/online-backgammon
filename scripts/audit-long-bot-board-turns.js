#!/usr/bin/env node
'use strict';
// Offline diagnostics only. No RPC, archive writes or production evidence.
const fs=require('node:fs');
const {reviewTurn,identity}=require('./long-bot-board-model-worker');
const {stateFromSnapshot}=require('./generate-long-bot-shadow-replay');
async function audit(input,output){
 const rows=JSON.parse(fs.readFileSync(input,'utf8')),id=identity(),counts={};
 const report={schema:'long-bot-complete-board-audit-v1',policy:id.policyImplementationId,productionEvidence:false,complete:false,rows:[]};
 const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 for(const row of rows){
  const turnIndex=counts[row.room]||0;counts[row.room]=turnIndex+1;
  const review=await reviewTurn({state:stateFromSnapshot(row.s),executedMoves:row.actual},
   {roomCode:row.room,archiveId:'offline-diagnostic',fingerprint:'offline-diagnostic'},turnIndex,id,
   {maxRootPositions:256,maxElapsedMs:300000});
  const {lesson,...result}=review;
  report.rows.push({room:row.room,...result,proposedLesson:lesson?{utilityGain:lesson.utilityGain,equityGain:lesson.equityGain,
   rootPositions:lesson.rootPositions,coldMoves:lesson.baselineMoves,preferredMoves:lesson.preferredMoves}:null});save();
 }
 report.complete=report.rows.length===rows.length&&report.rows.every(r=>['model-reviewed','no-applicable-improvement','forced-board'].includes(r.status));save();return report;
}
module.exports={audit};
if(require.main===module)audit(process.argv[2],process.argv[3]).then(r=>{console.log(JSON.stringify({complete:r.complete,turns:r.rows.length}));if(!r.complete)process.exitCode=1}).catch(e=>{console.error(e);process.exitCode=1});
