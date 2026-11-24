'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createRecoverySchedule}=require('../ops/timeweb/recovery-schedule-state.cjs');
const plan=Array.from({length:43},(_,i)=>({jobId:43-i,originalJobId:43-i,runtime:'a'.repeat(64),worker:'fixed-'+i}));
function temporary(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'long-recovery-cursor-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('short activations eventually visit every original job without resetting their progress',t=>{
 const directory=temporary(t),visited=[];
 // Each activation can afford only three expensive native jobs. Restarting
 // at the first job would permanently exclude forty of the original jobs.
 for(let activation=0;activation<15;activation++){
  const schedule=createRecoverySchedule(plan,directory);
  for(let slot=0;slot<3;slot++){const x=schedule.current();visited.push(x.jobId);schedule.advance(x.jobId);}
 }
 assert.deepEqual(visited.slice(0,43),plan.map(x=>x.jobId));
 assert.equal(new Set(visited).size,43);
 assert.equal(fs.statSync(path.join(directory,'campaign.cursor.json')).mode&0o777,0o600);
});
test('restart during an unfinished job retries that same job; a successful slot advances',t=>{
 const directory=temporary(t),first=createRecoverySchedule(plan,directory,{initialJobId:22});
 assert.equal(first.current().jobId,22);
 const resumed=createRecoverySchedule(plan,directory);assert.equal(resumed.current().jobId,22);
 assert.throws(()=>resumed.advance(21),/out of order/);
 resumed.advance(22);assert.equal(createRecoverySchedule(plan,directory).current().jobId,21);
 assert.throws(()=>createRecoverySchedule(plan,directory,{initialJobId:1}),/bootstrapped again/);
});
test('cursor refuses another plan, unknown jobs, and unsafe filesystem entries',t=>{
 const directory=temporary(t),file=path.join(directory,'campaign.cursor.json');
 createRecoverySchedule(plan,directory);
 assert.throws(()=>createRecoverySchedule(plan.map((x,i)=>i?x:{...x,runtime:'b'.repeat(64)}),directory),/plan changed/);
 const saved=JSON.parse(fs.readFileSync(file));saved.nextJobId=999;fs.writeFileSync(file,JSON.stringify(saved));
 assert.throws(()=>createRecoverySchedule(plan,directory),/outside plan/);
 fs.unlinkSync(file);const other=path.join(directory,'other');fs.writeFileSync(other,'{}',{mode:0o600});fs.symlinkSync(other,file);
 assert.throws(()=>createRecoverySchedule(plan,directory),/Private recovery cursor/);
});
