'use strict';
// Only the operator's queue position is stored here. Native journals and
// database progress remain the sole authorities for scientific work.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function createRecoverySchedule(plan,directory,{initialJobId}={}){
 if(!Array.isArray(plan)||plan.length!==43||new Set(plan.map(x=>x.jobId)).size!==43
  ||plan.some(x=>!Number.isSafeInteger(x.jobId)||x.jobId<1))throw Error('Exact recovery plan required');
 const file=path.join(directory,'campaign.cursor.json');
 const planSha256=crypto.createHash('sha256').update(JSON.stringify(plan.map(x=>({
  jobId:x.jobId,originalJobId:x.originalJobId,runtime:x.runtime,worker:x.worker,
 })))).digest('hex');
 let index=initialJobId===undefined?0:plan.findIndex(x=>x.jobId===initialJobId);
 if(index<0)throw Error('Initial recovery job outside plan');
 function inspect(){
  try{const s=fs.lstatSync(file);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()
   ||(s.mode&0o077))throw Error('Private recovery cursor required');return true;
  }catch(e){if(e.code==='ENOENT')return false;throw e;}
 }
 function write(next){
  inspect();
  const temporary=file+'.'+crypto.randomUUID()+'.next';
  const fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify({schema:'long-recovery-schedule-v1',planSha256,
   nextJobId:plan[next].jobId})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,file);
  const dir=fs.openSync(directory,'r');
  try{fs.fsyncSync(dir);}catch(e){if(process.platform==='linux'||e.code!=='EINVAL')throw e;}
  finally{fs.closeSync(dir);}
 }
 if(inspect()){
  if(initialJobId!==undefined)throw Error('Existing recovery cursor cannot be bootstrapped again');
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  if(saved.schema!=='long-recovery-schedule-v1'||saved.planSha256!==planSha256
   ||Object.keys(saved).sort().join(',')!=='nextJobId,planSha256,schema')throw Error('Recovery cursor plan changed');
  index=plan.findIndex(x=>x.jobId===saved.nextJobId);
  if(index<0)throw Error('Recovery cursor outside plan');
 }else write(index);
 return {
  current:()=>plan[index],
  advance(expectedJobId){
   if(plan[index].jobId!==expectedJobId)throw Error('Recovery cursor advanced out of order');
   const next=(index+1)%plan.length;write(next);index=next;
  },
 };
}
module.exports={createRecoverySchedule};
