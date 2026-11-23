'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const wire=require('../ops/timeweb/recovery-progress-wire.cjs');
test('v1 representation round trip retains all progress and refuses mid-ply downgrade',()=>{
 const worker='long-recovery-11-22034581-bc95-4599-a2fb-a7dbee3db2e4',runtime=wire.V1_RUNTIME;
 const p={schema:'long-server-causal-progress-v2',slices:12,stalledSlices:0,finishedReviews:[{original:'unchanged'}],
  currentDecisionIndex:1,currentTerminalOutcomes:2,currentRolloutCheckpoint:null};
 const [job]=wire.responseBody('claim_long_bot_causal_review_slices',[{jobId:11,runtimeDigest:runtime,progress:p}],worker,runtime);
 assert.equal(job.progress.schema,'long-server-causal-progress-v1');
 assert.deepEqual(wire.requestBody('checkpoint_long_bot_causal_review_slice',{p_worker_id:worker,p_progress:job.progress},worker,runtime).p_progress,p);
 assert.throws(()=>wire.responseBody('claim_long_bot_causal_review_slices',[{jobId:11,runtimeDigest:runtime,progress:{...p,currentRolloutCheckpoint:{plies:3}}}],worker,runtime),/terminal boundary/);
 const untouched={x:2};assert.equal(wire.responseBody('claim_long_bot_causal_review_slices',untouched,worker,'other'),untouched);
});
