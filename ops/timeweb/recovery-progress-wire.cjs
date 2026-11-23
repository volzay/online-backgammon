'use strict';
// Exact representation adapter for the three v1 workers. Scientific fields
// and complete outcomes are copied byte-for-byte; v1 cannot resume a v2 ply.
const V1_RUNTIME='430a0f4ea942c2282b8529fcf39fe9347194d1124432b3dc8b4d0fad25594a2a';
function requestBody(name,args,worker,runtime){
 if(runtime!==V1_RUNTIME||name!=='checkpoint_long_bot_causal_review_slice')return args;
 if(args.p_worker_id!==worker||args.p_progress?.schema!=='long-server-causal-progress-v1'
  ||'currentRolloutCheckpoint' in args.p_progress)throw Error('Invalid v1 recovery request');
 const result=structuredClone(args.p_result);
 for(const review of result?.reviews||[]){
  if(review.reason!=='rollout-time-limit')continue;
  const observation=review.rollout?.terminalJournalObservation;
  if(!observation||observation.schema!=='long-bot-terminal-journal-v1'||'activeCheckpoint'in observation
   ||observation.learningEvidence!==false)throw Error('Exact legacy journal observation required');
  // This immutable v1 journal records terminal endpoints only. The absent
  // in-game checkpoint is represented explicitly as null, never invented.
  observation.activeCheckpoint=null;
 }
 return {...args,p_result:result,p_progress:{...args.p_progress,schema:'long-server-causal-progress-v2',currentRolloutCheckpoint:null}};
}
function responseBody(name,value,worker,runtime){
 if(runtime!==V1_RUNTIME||name!=='claim_long_bot_causal_review_slices')return value;
 if(!Array.isArray(value)||value.length>1)throw Error('Invalid v1 recovery claim');
 return value.map(job=>{
  const p=job.progress;
  if(job.runtimeDigest!==runtime||job.jobId!==Number(worker.split('-')[2])
   ||p?.schema!=='long-server-causal-progress-v2'||p.currentRolloutCheckpoint!==null)throw Error('v1 recovery requires an exact terminal boundary');
  const {currentRolloutCheckpoint,...legacy}=p;
  return {...job,progress:{...legacy,schema:'long-server-causal-progress-v1'}};
 });
}
module.exports={V1_RUNTIME,requestBody,responseBody};
